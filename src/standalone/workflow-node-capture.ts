import * as Schema from "effect/Schema";
import { appBackendBindingsSchema } from "@fungi.computer/puffball/app";
import { catalogMethods } from "@fungi.computer/braid";
import {
  workflowMethodRequiresComputer,
  type WorkflowCeilingCapturePorts,
} from "@fungi.computer/braid/runtime";
import {
  admitMethodMetadata,
  appInvocationCeiling,
  type GateFacts,
  approvedBindingGrants,
  deriveDeclaredOperations,
  scopedBindings,
} from "../apps/index.js";
import { verifyRelease, type OysterHost } from "../host.js";
import { oysterPrincipalIsOwner } from "../authorization.js";
import { invocationCallerContext } from "../invocation.js";
import type { StandaloneWorkflowAuthorityReaders } from "./workflow-authority-readers.js";

/** Live host readers and approvals; a compile catalog is deliberately not a grant port. */
export type StandaloneWorkflowNodeCaptureOptions = Readonly<{
  host: Pick<OysterHost, "artifacts" | "computerId" | "capabilities"> &
    Readonly<{
      auth: Pick<OysterHost["auth"], "resolve">;
      installations: Pick<OysterHost["installations"], "get">;
    }>;
  readers: Pick<
    StandaloneWorkflowAuthorityReaders,
    "member" | "memberComputer"
  >;
}>;

/** Capture one compiled node through the same metadata admission as ordinary App calls. */
export function createStandaloneWorkflowNodeCapture(
  options: StandaloneWorkflowNodeCaptureOptions,
): WorkflowCeilingCapturePorts["node"] {
  const { host, readers } = options;
  return async (actor, member, target) => {
    const before = await readers.member(actor.memberId);
    if (
      before?.membershipVersion !== member.membershipVersion ||
      (target.computerId !== null &&
        (target.computerId !== host.computerId ||
          !(await readers.memberComputer(actor.memberId, target.computerId))))
    )
      return null;
    const principal = await host.auth.resolve(actor);
    if (principal === null || !oysterPrincipalIsOwner(principal)) return null;
    const caller = invocationCallerContext(principal, target.computerId);
    if (
      caller.actor.kind !== "member" ||
      caller.actor.memberId !== actor.memberId
    )
      return null;
    const installation = await host.installations.get(target.installationId);
    if (
      installation?.status !== "enabled" ||
      installation.appId !== target.appId
    )
      return null;
    const verified = await verifyRelease(
      host.artifacts,
      installation.release,
      undefined,
      false,
    );
    if (verified.declaration === null || verified.api === null) return null;
    const facts: GateFacts = {
      principal: { actor: caller.actor, role: caller.role ?? null },
      installation: {
        status: installation.status,
        instanceId: installation.instanceId,
        authority: installation.authority,
        artifactDigest: installation.release.artifact.artifactDigest,
      },
      declaration: verified.declaration,
      declaredOperations: await deriveDeclaredOperations(
        installation.release,
        verified.declaration,
        host.capabilities ?? [],
      ),
      api: verified.api,
      access: null,
    };
    const decision = admitMethodMetadata(facts, target.method);
    if (decision.kind !== "admitted") return null;
    const { method } = decision;
    if (method.effect !== "read" && method.effect !== "write") return null;
    if (
      target.computerId === null &&
      workflowMethodRequiresComputer(method.requires)
    )
      return null;
    const pinned = await catalogMethods({ [target.method]: method });
    if (pinned.methods[target.method]?.digest !== target.methodDigest)
      return null;
    const bindings = Schema.decodeUnknownSync(appBackendBindingsSchema)(
      scopedBindings(
        approvedBindingGrants(installation, verified.declaration),
        method,
        appInvocationCeiling(facts),
      ).map((binding) => ({
        name: binding.binding,
        operations: binding.operations,
      })),
    );
    const latest = await host.installations.get(target.installationId);
    const after = await readers.member(actor.memberId);
    if (
      latest?.status !== "enabled" ||
      latest.instanceId !== installation.instanceId ||
      latest.authority.authorityVersion !==
        installation.authority.authorityVersion ||
      latest.authority.declaredOperationsDigest !==
        installation.authority.declaredOperationsDigest ||
      latest.release.releaseId !== installation.release.releaseId ||
      latest.release.artifact.artifactDigest !==
        installation.release.artifact.artifactDigest ||
      after?.membershipVersion !== member.membershipVersion ||
      (target.computerId !== null &&
        !(await readers.memberComputer(actor.memberId, target.computerId)))
    )
      return null;
    return { level: method.effect, capabilities: method.requires, bindings };
  };
}
