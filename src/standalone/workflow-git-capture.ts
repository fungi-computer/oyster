import { repositoryRefSchema } from "@fungi.computer/agar/git";
import type { WorkflowCeilingCapturePorts } from "@fungi.computer/braid/runtime";
import { approvedBindingGrants } from "../apps/index.js";
import { createInstallationGitAdmission } from "../git.js";
import { oysterPrincipalIsOwner, resolveBackend } from "../host.js";
import { invocationCallerContext } from "../invocation.js";
import type { StandaloneWorkflowNodeCaptureOptions } from "./workflow-node-capture.js";

/** Installation Git only; Team-source needs its separate authoritative namespace owner. */
export function createStandaloneWorkflowInstallationGitCapture(
  options: Readonly<{
    host: Pick<
      StandaloneWorkflowNodeCaptureOptions["host"],
      "auth" | "artifacts" | "installations"
    >;
    readers: Pick<StandaloneWorkflowNodeCaptureOptions["readers"], "member">;
  }>,
): WorkflowCeilingCapturePorts["git"] {
  const { host, readers } = options;
  return async (actor, member, raw, scope) => {
    const repository = repositoryRefSchema.parse(raw);
    if (repository.kind !== "installation") return false;
    const before = await readers.member(actor.memberId);
    if (before?.membershipVersion !== member.membershipVersion) return false;
    const principal = await host.auth.resolve(actor);
    if (principal === null || !oysterPrincipalIsOwner(principal)) return false;
    const caller = invocationCallerContext(principal, null);
    if (
      caller.actor.kind !== "member" ||
      caller.actor.memberId !== actor.memberId
    )
      return false;
    const installation = await host.installations.get(
      repository.installationId,
    );
    if (
      installation?.status !== "enabled" ||
      installation.instanceId === null ||
      installation.installationId !== repository.installationId
    )
      return false;
    const currentInstallation = async () => {
      const current = await host.installations.get(repository.installationId);
      if (
        current?.status !== "enabled" ||
        current.installationId !== installation.installationId ||
        current.instanceId !== installation.instanceId ||
        current.authorityVersion !== installation.authorityVersion ||
        current.declaredOperationsDigest !==
          installation.declaredOperationsDigest ||
        current.release.appId !== installation.release.appId ||
        current.release.releaseId !== installation.release.releaseId ||
        current.release.artifact.artifactRef !==
          installation.release.artifact.artifactRef ||
        current.release.artifact.artifactDigest !==
          installation.release.artifact.artifactDigest
      )
        return null;
      return current;
    };
    const admits = createInstallationGitAdmission({
      currentInstallation,
      declaration: async (current) => {
        const backend = await resolveBackend(host.artifacts, current.release);
        const declaration = backend?.declaration;
        if (
          declaration == null ||
          !approvedBindingGrants(current, declaration).some(
            (binding) =>
              binding.binding === "GIT" && binding.operations.includes(scope),
          )
        )
          return null;
        return declaration;
      },
    });
    if (
      !(await admits(
        { kind: "actor", actor: caller.actor },
        repository.repository,
        scope,
      ))
    )
      return false;
    const after = await readers.member(actor.memberId);
    return (
      after?.membershipVersion === member.membershipVersion &&
      (await currentInstallation()) !== null
    );
  };
}
