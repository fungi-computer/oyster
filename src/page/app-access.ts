import type { AppPermissionRequest } from "@fungi.computer/agar";
import type { RequestShellAppAccess } from "@fungi.computer/nacre/shell-module";
import type { WorkbenchDirectory } from "@fungi.computer/nacre/workbench-directory";
import {
  grantRequestFor,
  appPermissionPageSchema,
} from "../apps/permissions.js";

/** The families beyond Agents and Computers, which the sheet lists in words. */
function otherFamilies(input: AppPermissionRequest): AppPermissionRequest {
  return {
    git: input.git ?? [],
    workflows: input.workflows ?? [],
    events: input.events ?? [],
    generation: input.generation ?? [],
  };
}

function asksForAnything(input: AppPermissionRequest): boolean {
  return [
    input.agents,
    input.computers,
    input.git,
    input.workflows,
    input.events,
    input.generation,
  ].some((list) => list !== undefined && list.length > 0);
}

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
    // An empty request is the App asking to open its permissions.
    if (installationId === null || !asksForAnything(input)) return customize();
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
        others: otherFamilies(input),
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
      others: otherFamilies(input),
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
            declaredOperationsDigest: permissions.declaredOperations.digest,
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
