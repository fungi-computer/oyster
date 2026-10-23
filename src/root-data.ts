import type { Release } from "@fungi.computer/puffball";
import {
  resolveAppRoles,
  type RoleCandidate,
} from "@fungi.computer/puffball/app";
import { createAppStorage } from "./app-storage.js";
import type { InstallationStore, verifyRelease } from "./host.js";
import {
  addressKey,
  appDirectoryEntrySchema,
  type AppDirectoryEntry,
} from "@fungi.computer/nacre/app-directory";

/**
 * A destination the host offers the dashboard. This is a structural twin of
 * Nacre's `WorkbenchPlatformDestination`: importing that type would put
 * Nacre's DOM-typed workbench declarations on every Worker entry that reaches
 * root data.
 */
type PlatformDestination = Readonly<{ id: string; label: string }>;

/** Role choices belong to the root owner, independently of Release declarations. */
export type OysterRootRoles = Readonly<
  Record<string, Readonly<{ surfaceId: string | null; chosen: boolean }>>
>;

/** Shared workbench metadata, without a hosted Team's administration or grants. */
export type OysterRootDirectory = Readonly<{
  apps: readonly AppDirectoryEntry[];
  roles: OysterRootRoles;
  /** Fixed host-selected Computer context; metadata conveys no operation rights. */
  computer?: Readonly<{ computerId: string; name: string }>;
}>;

/** Existing installation, Release and SQLite owners supplied by the root. */
export type OysterRootDataOptions = Parameters<typeof createAppStorage>[0] &
  Readonly<{
    installations: Pick<InstallationStore, "list">;
    /** Reuse the root's verified Release resolver; metadata grants no access. */
    resolveRelease(
      release: Release,
    ): Promise<
      Pick<Awaited<ReturnType<typeof verifyRelease>>, "declaration" | "ui">
    >;
  }>;

/** Data adapters for a standalone workbench over the root's existing owners. */
export function createOysterRootData(options: OysterRootDataOptions) {
  const storage = createAppStorage(options);
  return {
    /** Each open(authorize) receives fresh host admission and Release-declared keys. */
    storage,
    /** Project the current installations without minting permissions or role choices. */
    async directory(): Promise<OysterRootDirectory> {
      const installations = await options.installations.list();
      const projected = await Promise.all(
        installations
          .filter((installation) => installation.status !== "deleted")
          .map(async (installation) => {
            const resolved = await options.resolveRelease(installation.release);
            const declaration = resolved.declaration;
            const address = {
              kind: "installation" as const,
              installationId: installation.installationId,
            };
            const surfaceId = addressKey(address);
            const surfacePath = `/apps/${encodeURIComponent(installation.installationId)}/`;
            const available =
              installation.status === "enabled" && resolved.ui !== null;
            const availability = available ? "available" : "unavailable";
            const entry: AppDirectoryEntry = {
              address,
              installationId: installation.installationId,
              surfaceId,
              appId: installation.release.appId,
              displayName: declaration?.displayName,
              icon: declaration?.icon ?? null,
              releaseId: installation.release.releaseId,
              authorityVersion: installation.authority.authorityVersion,
              enforcement: null,
              handlers: [...(declaration?.handlers ?? [])],
              roles: [...(declaration?.roles ?? [])],
              declaredCapabilities: [...(declaration?.capabilities ?? [])],
              commands: [...(declaration?.commands ?? [])],
              gills: [...(declaration?.gills ?? [])],
              availability,
              surface: available ? { stableRoute: surfacePath } : null,
              surfacePath,
            };
            if (declaration?.calls !== undefined)
              entry.calls = declaration.calls;
            // Built from the declaration's own typed roles, not the
            // directory entry's widened (string[]) projection of them.
            const candidate: RoleCandidate = {
              surfaceId,
              availability,
              roles: declaration?.roles ?? [],
            };
            return { entry: appDirectoryEntrySchema.parse(entry), candidate };
          }),
      );
      // Standalone has no PUT route and no stored choice: per the ADR, the
      // effective holder of an unchosen role is the first available listed
      // App declaring it.
      return {
        apps: projected.map((app) => app.entry),
        roles: resolveAppRoles(
          new Map(),
          projected.map((app) => app.candidate),
        ),
      };
    },
    /** No standalone platform navigation destination is implemented yet. */
    platformDestinations(): readonly PlatformDestination[] {
      return [];
    },
  };
}
