import type { RequestShellAppAccess } from "@fungi.computer/nacre/shell-module";
import type { WorkbenchDirectory } from "@fungi.computer/nacre/workbench-directory";
import {
  grantRequestFor,
  appPermissionPageSchema,
} from "../apps/permissions.js";

/**
 * Keep standalone consent in the Oyster host: the picked shell draws the
 * prompt, while Oyster bounds the request and commits through its owner CAS.
 */
export function createShellAppAccess(
  directory: () => Promise<WorkbenchDirectory>,
): RequestShellAppAccess {
  return async (target, input, dialog) => {
    const { surfaceId, computerId } = target;
    const current = await directory();
    const app = current.apps.find((row) => row.surfaceId === surfaceId);
    const installationId = app?.installationId ?? null;
    const customize = () => dialog.customize(installationId);
    if (installationId === null) return customize();
    const path = `/api/installations/${encodeURIComponent(installationId)}/grants`;
    const response = await fetch(path, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return "declined";
    const view = appPermissionPageSchema.parse(await response.json());
    const { permissions } = view;
    const decision = grantRequestFor(
      permissions.authority,
      {
        declaration: {
          capabilities: permissions.declaredOperations.capabilities.map(
            (row) => row.capability,
          ),
        },
        declaredOperations: permissions.declaredOperations,
      },
      input,
      { computerId },
    );
    if (decision.kind === "covered") return "granted";
    if (decision.kind === "refused") {
      if (decision.code !== "window_scope_unavailable") return "declined";
      const outcome = await dialog.ask({
        appName: view.appName,
        agents: input.agents ?? [],
        computers: input.computers ?? [],
        refusal: {
          code: decision.code,
          message:
            "Allow for this window is unavailable on this Oyster. No access was changed. Use Customize to review Computer permissions explicitly.",
        },
        allow: () => Promise.resolve(false),
      });
      return outcome === "customize" ? customize() : outcome;
    }
    if (decision.kind === "customize") return customize();
    const outcome = await dialog.ask({
      appName: view.appName,
      agents: input.agents ?? [],
      computers: input.computers ?? [],
      allow: async () => {
        const saved = await fetch(path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          body: JSON.stringify({
            storeGeneration: view.storeGeneration,
            authorityVersion: permissions.authority.authorityVersion,
            artifactDigest: view.artifactDigest,
            command: decision.command,
          }),
        });
        return saved.ok;
      },
    });
    // False saves settle declined; rejected saves leave the shell open for retry.
    return outcome === "customize" ? customize() : outcome;
  };
}
