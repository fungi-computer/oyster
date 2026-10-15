/**
 * The standalone Instance's two durable delivery engines: a retained Git push
 * and a background wake, each re-admitted through the same installation and
 * method gate as a live request. Only `OysterInstance` calls them; Hub owns
 * its own delivery and never imports this module.
 */
import type { Release } from "@fungi.computer/puffball";
import {
  appGitPushFactSchema,
  type AppGitPushFact,
} from "@fungi.computer/agar/git";
import {
  backgroundWakeSchema,
  readmitBackground,
  type BackgroundWake,
} from "@fungi.computer/puffball/background-replay";
import { z } from "zod";
import { admits, type InvocationGrants } from "../apps/gate.js";
import type { Installation } from "../apps/installation.js";
import { backgroundWakeKey } from "../git-journal.js";
import { guestLimits } from "../guest-policy.js";
import type { OysterHost } from "../host.js";
import { selectionOf } from "../index.js";
import {
  APP_INVOCATION_CEILING_MS,
  invocationAuthorityOf,
  invocationCallerContext,
  invocationFacts,
} from "../invocation.js";
import {
  defaultAssetPolicy,
  verifyRelease,
  type VerifiedRelease,
} from "../release.js";
import { admittedBackgroundOrigins } from "./background-origins.js";
import { hostGateFacts, releaseCache } from "./host-gate.js";

async function admitGitPush(
  host: Pick<OysterHost, "installations">,
  readRelease: (release: Release) => Promise<VerifiedRelease>,
  installationId: string,
  raw: AppGitPushFact,
): Promise<Readonly<{
  installation: Installation;
  release: VerifiedRelease;
  fact: AppGitPushFact;
}> | null> {
  const fact = appGitPushFactSchema.parse(raw);
  const installation = await host.installations.get(installationId);
  if (installation?.status !== "enabled")
    throw new Error("Git push installation unavailable");
  const release = await readRelease(installation.release);
  const { declaration } = release;
  if (
    !declaration?.receives?.includes("git.push") ||
    !declaration.capabilities.includes("git.repository")
  )
    return null;
  const current = await host.installations.get(installationId);
  if (
    current?.status !== "enabled" ||
    current.instanceId !== installation.instanceId ||
    current.authorityVersion !== installation.authorityVersion ||
    current.release.releaseId !== installation.release.releaseId
  )
    throw new Error("Git push installation changed");
  return { installation: current, release, fact };
}

function deliverAdmittedGitPush(
  host: Pick<OysterHost, "instances" | "guestLimits">,
  installation: Installation,
  release: VerifiedRelease,
  fact: AppGitPushFact,
): Promise<void> {
  return host.instances
    .get(selectionOf(installation).instanceId, guestLimits(host.guestLimits))
    .onGitPush(
      {
        ...invocationAuthorityOf(installation, release),
        subject: {
          kind: "lifecycle",
          name: "onGitPush",
          eventId: fact.eventId,
        },
        deadlineAt: Date.now() + APP_INVOCATION_CEILING_MS,
      },
      fact,
    );
}

/** Re-admit a retained push and deliver it directly to the current Instance.
 * Durable host delivery uses the same fresh checks as initial push admission;
 * this path never calls the producer's optional enqueue callback. */
export async function deliverGitPush(
  host: Pick<
    OysterHost,
    "artifacts" | "installations" | "instances" | "guestLimits"
  >,
  installationId: string,
  fact: AppGitPushFact,
): Promise<void> {
  const admitted = await admitGitPush(
    host,
    (release) =>
      verifyRelease(host.artifacts, release, defaultAssetPolicy, false),
    installationId,
    fact,
  );
  if (admitted !== null)
    await deliverAdmittedGitPush(
      host,
      admitted.installation,
      admitted.release,
      admitted.fact,
    );
}

/** Re-admit a stored member through the same directory and method gate as a click. */
export async function deliverBackground(
  host: OysterHost,
  raw: BackgroundWake,
): Promise<Readonly<{ status: "accepted" | "refused"; more: boolean }>> {
  const wake = backgroundWakeSchema.parse(raw);
  const available = async () => {
    const current = await host.installations.get(wake.installationId);
    return current?.status === "enabled" && current.instanceId !== null
      ? current
      : null;
  };
  if ((await available()) === null) return { status: "refused", more: false };
  const readRelease = releaseCache(host.artifacts);
  let admitted:
    | Readonly<{
        installation: Installation;
        release: VerifiedRelease;
        method: string;
        grants: InvocationGrants;
        origins: readonly string[];
      }>
    | undefined;
  const decision = await readmitBackground(wake, {
    resolve: (actor) => host.auth.resolve(actor),
    admit: async (principal) => {
      const installation = await available();
      if (installation === null)
        return { kind: "refused", code: "unavailable" };
      const release = await readRelease(installation.release);
      const method = release.declaration?.backend?.sync?.method;
      if (
        method === undefined ||
        release.api?.methods[method]?.effect !== "write"
      )
        return { kind: "refused", code: "denied" };
      const gate = await hostGateFacts(host, installation, release, principal);
      const verdict = admits(gate, {
        kind: "method",
        name: method,
        input: {},
        via: "ui",
      });
      if (verdict.kind === "refused") {
        switch (verdict.code) {
          case "unavailable":
          case "stale_authority":
          case "not_approved":
          case "level_too_low":
          case "requires_not_granted":
            return { kind: "refused", code: verdict.code };
          case "not_declared":
          case "approval_required":
          case "invalid_input":
          case "visitor_read_only":
            return { kind: "refused", code: "denied" };
        }
      }
      const origins = admittedBackgroundOrigins(gate);
      admitted = {
        installation,
        release,
        method,
        grants: verdict.grants,
        origins,
      };
      return {
        kind: "admitted",
        context: invocationCallerContext(principal, host.computerId ?? null),
      };
    },
  });
  if (decision.kind === "retry")
    throw new Error("Background admission changed; retry");
  if (decision.kind === "refused") {
    const current = await available();
    if (current === null || decision.code === "installation_unavailable")
      return { status: "refused", more: false };
    const release = await readRelease(current.release);
    const authority = invocationAuthorityOf(current, release);
    const refusal = { lane: wake.lane, code: decision.code };
    await host.instances
      .get(authority.instanceId, guestLimits(host.guestLimits))
      .syncRefused(
        {
          ...authority,
          grants: [],
          subject: { kind: "lifecycle", name: "syncRefused", ...refusal },
          deadlineAt: Date.now() + APP_INVOCATION_CEILING_MS,
        },
        refusal,
      );
    return { status: "accepted", more: false };
  }
  if (!admitted?.release.api)
    throw new Error("Background continuation was not admitted");
  const deadlineAt = Date.now() + APP_INVOCATION_CEILING_MS;
  const facts = invocationFacts.fromCaller(
    {
      ...invocationAuthorityOf(admitted.installation, admitted.release),
      grants: admitted.grants,
    },
    {
      ...decision.context,
      idempotencyKey: backgroundWakeKey(wake),
    },
    { deadlineAt, grantExpiresAt: deadlineAt },
    { name: admitted.method, effect: "write" },
  );
  if (facts.subject.kind !== "call")
    throw new Error("Background replay must be a call");
  const result = await host.instances
    .get(facts.instanceId, guestLimits(host.guestLimits))
    .call(
      {
        ...facts,
        grants: [
          ...facts.grants,
          { binding: "BACKGROUND", operations: ["admit"] },
        ],
        subject: {
          ...facts.subject,
          replay: {
            lane: wake.lane,
            epoch: wake.epoch,
            admitted: admitted.origins,
          },
        },
      },
      admitted.release.api,
      admitted.method,
      {},
    );
  if (!result.ok)
    throw new Error(`Background continuation failed: ${result.code}`);
  if (result.value.kind === "refused")
    throw new Error(`Background continuation refused: ${result.value.code}`);
  return {
    status: "accepted",
    more: z.object({ more: z.boolean() }).parse(result.value.value).more,
  };
}
