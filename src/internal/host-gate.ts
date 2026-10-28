/** Release verification and gate facts shared by the HTTP host and its delivery engines. */
import type { Release } from "@fungi.computer/puffball";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import type { GateFacts } from "../apps/gate.js";
import type { Installation } from "../apps/installation.js";
import { deriveDeclaredOperations } from "../apps/operations.js";
import type { OysterHost, OysterPrincipal } from "../host.js";
import type { AppToolPolicy } from "../apps/tools.js";
import { keyAppAccess } from "../keys.js";
import {
  defaultAssetPolicy,
  verifyRelease,
  type ArtifactStore,
  type VerifiedRelease,
} from "../release.js";

/** Verified Releases one cache keeps; the least recently added leaves first. */
const releaseCacheLimit = 256;

/**
 * Verify each Release once per owner (an isolate's HTTP host, or the
 * Registry): a failed read is not cached, so the next request reads it again.
 * Installation verified every asset; serving verifies each on read. A Release
 * is content-addressed and immutable, so the key is its ID and root digest and
 * a hit never goes stale; the bound only forgets the oldest-verified Releases.
 */
export function releaseCache(
  artifacts: ArtifactStore,
  limit = releaseCacheLimit,
): (release: Release) => Promise<VerifiedRelease> {
  const verified = new Map<string, Promise<VerifiedRelease>>();
  return (release) => {
    const key = `${release.releaseId}:${release.artifact.artifactDigest}`;
    let entry = verified.get(key);
    if (entry === undefined) {
      entry = verifyRelease(
        artifacts,
        release,
        defaultAssetPolicy,
        false,
      ).catch((cause: unknown) => {
        verified.delete(key);
        throw cause;
      });
      verified.set(key, entry);
      for (const oldest of verified.keys()) {
        if (verified.size <= limit) break;
        verified.delete(oldest);
      }
    }
    return entry;
  };
}

/**
 * Only Agents and keys hold tool policy; members and visitors never ask. An
 * Agent keeps its one blanket policy; a key's access is its own grants for
 * this one installation -- `null` when its live key is unknown, revoked,
 * expired or suspended, or simply does not reach this installation, which
 * then refuses `not_approved`, the same as an Agent with no approval.
 */
async function hostToolPolicy(
  host: OysterHost,
  actor: OysterPrincipal["actor"],
  installationId: string,
): Promise<AppToolPolicy | null> {
  if (actor.kind === "agent")
    return (await host.appToolPolicy?.(actor)) ?? null;
  if (actor.kind !== "team-key") return null;
  const key = (await host.keys?.live(actor.keyId)) ?? null;
  return key === null ? null : keyAppAccess(key, installationId);
}

/** The gate facts one principal presents to one installation. */
export async function hostGateFacts(
  host: OysterHost,
  installation: Installation,
  release: VerifiedRelease,
  principal: OysterPrincipal,
): Promise<GateFacts> {
  const { actor } = principal;
  const declaration = release.declaration ?? emptyAppDeclaration;
  const toolPolicy = await hostToolPolicy(
    host,
    actor,
    installation.installationId,
  );
  return {
    installation: {
      status: installation.status,
      visibility: installation.visibility,
      instanceId: installation.instanceId,
      authority: installation.authority,
      artifactDigest: installation.release.artifact.artifactDigest,
    },
    declaration,
    declaredOperations: await deriveDeclaredOperations(
      installation.release,
      declaration,
      host.capabilities ?? [],
    ),
    api: release.api,
    principal: { actor, role: "role" in principal ? principal.role : null },
    access:
      toolPolicy === null
        ? null
        : {
            level: toolPolicy.level,
            bindingName: installation.installationId,
            revision: toolPolicy.revision,
            grantedBy: toolPolicy.grantedBy,
          },
  };
}
