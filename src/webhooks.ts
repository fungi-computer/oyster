import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  armedWorkflowTriggerSchema,
  workflowTriggerTargetSchema,
  type createTeamWorkflowRuns,
  type createTeamWorkflowTriggers,
  type WorkflowInstallationAuthority,
  type WorkflowTriggerTarget,
} from "@fungi.computer/braid/runtime";
import {
  workflowWebhookCustody,
  workflowWebhookVerifierSchema,
  type WorkflowWebhookVerifier,
} from "./webhook-custody.js";
import {
  workflowWebhookIngress,
  type WebhookAdmission,
  type WebhookIngressLimits,
} from "./webhook-ingress.js";
import { workflowWebhookAbuse } from "./webhook-abuse.js";

const ids = defineIdFamily({
  family: "workflow-webhooks",
  version: 1,
  kinds: { binding: { prefix: "workflow_hook" } },
});
const cargoSchema = z.strictObject({
  binding: armedWorkflowTriggerSchema,
  body: z.json(),
  headers: z.partialRecord(
    z.enum(["content-type", "x-github-event"]),
    z.string().max(1024),
  ),
});
const bindingId = z.string().min(1).max(256);
export const workflowWebhookCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    target: workflowTriggerTargetSchema,
    computerId: bindingId,
    verifier: workflowWebhookVerifierSchema,
  }),
  z.strictObject({
    operation: z.enum(["rotate", "retirePrevious", "revoke"]),
    bindingId,
  }),
  z.strictObject({ operation: z.literal("list"), after: bindingId.optional() }),
]);

/**
 * Dispatch the hosts' decoded closed control contract. Hosts decode before
 * resolving installation dependencies; only they supply the current pin and
 * their captured target.
 */
export async function workflowWebhookControlResponse<Principal>(
  webhooks: ReturnType<typeof createWorkflowWebhooks<Principal>>,
  principal: Principal,
  command: z.output<typeof workflowWebhookCommandSchema>,
  authorize: (
    target: WorkflowTriggerTarget,
    computerId: string,
  ) => Promise<{
    target: WorkflowTriggerTarget;
    authority: WorkflowInstallationAuthority;
  }>,
): Promise<Response> {
  if (command.operation === "create") {
    const { target, authority } = await authorize(
      command.target,
      command.computerId,
    );
    return Response.json(
      await webhooks.create(
        principal,
        target,
        command.computerId,
        authority,
        command.verifier,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  }
  const result =
    command.operation === "list"
      ? await webhooks.list(principal, command.after)
      : await webhooks[command.operation](principal, command.bindingId);
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

/**
 * Host-owned composition: custody verifies, Braid reserves/maps/starts, and the
 * host's ordinary idempotent launch ensures its recorded engine instance.
 * No separate intake state machine or run/settlement store exists here.
 */
export function createWorkflowWebhooks<Principal>(
  options: Parameters<typeof workflowWebhookCustody<Principal>>[0] & {
    scope: Readonly<{ host: string; tenant: string }>;
    runs: Pick<
      ReturnType<typeof createTeamWorkflowRuns>,
      | "reserveWebhookDelivery"
      | "pendingWebhookDeliveries"
      | "completeWebhookDelivery"
      | "nextWebhookWake"
      | "graph"
    >;
    triggers: Pick<
      ReturnType<typeof createTeamWorkflowTriggers>,
      "arm" | "fire"
    >;
    launch: Parameters<typeof createTeamWorkflowTriggers>[0]["launch"];
    abuse: Omit<Parameters<typeof workflowWebhookAbuse>[0], "scope">;
    limits: WebhookIngressLimits;
    /** Recompute the native alarm from ALL host-owned wake sources. */
    wake(): Promise<void>;
    reportFailure(): void;
  },
) {
  const custody = workflowWebhookCustody(options);
  const abuse = workflowWebhookAbuse({
    ...options.abuse,
    scope: options.scope,
  });
  let recovering = false;
  const nextWake = () => options.runs.nextWebhookWake(options.scope);
  const receive = workflowWebhookIngress({
    limits: options.limits,
    hostLease: () => abuse.hostLease(),
    reportReadFailure: () => {
      options.reportFailure();
    },
    reportOwnerFailure: () => {
      options.reportFailure();
    },
    async deliver(delivery) {
      if (!(await abuse.bindingAdmission(delivery.bindingId)))
        return { status: "refused" };
      const verified = custody.verification.verify(delivery);
      if (verified.status !== "ok") return { status: "refused" };
      const body = z
        .json()
        .parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
              delivery.body,
            ),
          ),
        );
      const headers = Object.fromEntries(
        ["content-type", "x-github-event"].flatMap((name) => {
          const value = delivery.headers.get(name);
          return value === null ? [] : [[name, value]];
        }),
      );
      const cargo = cargoSchema.parse({
        binding: verified.binding,
        body,
        headers,
      });
      const reserved = options.transactionSync(() => {
        if (!custody.verification.isActive(delivery.bindingId))
          return { kind: "refused" as const };
        return options.runs.reserveWebhookDelivery({
          scope: {
            installationId: cargo.binding.installationId,
            workflowId: cargo.binding.workflowId,
            commit: cargo.binding.commit,
            triggerId: cargo.binding.triggerId,
          },
          delivery: {
            ...options.scope,
            bindingId: delivery.bindingId,
            eventId: verified.eventId,
          },
          cargo: z.json().parse(cargo),
          limits: abuse.concurrency,
        });
      });
      if (reserved.kind === "refused") return { status: "refused" };
      const accepted: WebhookAdmission = {
        status: "accepted",
        deliveryId: reserved.reservationId,
      };
      // Admission already committed. A lost wake acknowledgement cannot undo
      // it or prove refusal; the existing recovery owner retains this identity.
      try {
        await options.wake();
      } catch {
        options.reportFailure();
        return accepted;
      }
      return accepted;
    },
  });
  return {
    receive,
    nextWake,
    async create(
      principal: Principal,
      target: WorkflowTriggerTarget,
      computerId: string,
      authority: WorkflowInstallationAuthority,
      verifier: WorkflowWebhookVerifier,
    ) {
      const creator = await options.owner(principal);
      if (creator === null) return { kind: "refused" as const };
      const armed = await options.triggers.arm(
        { armedBy: creator, armedVia: null },
        target,
        computerId,
        authority,
      );
      if (armed.kind !== "armed") return armed;
      if (armed.trigger.on !== "webhook") return { kind: "refused" as const };
      return custody.create(
        principal,
        ids.binding.generate(),
        verifier,
        armed.binding,
      );
    },
    rotate: (principal: Principal, bindingId: string) =>
      custody.rotate(principal, bindingId),
    retirePrevious: (principal: Principal, bindingId: string) =>
      custody.retirePrevious(principal, bindingId),
    revoke: (principal: Principal, bindingId: string) =>
      custody.revoke(principal, bindingId),
    list: (principal: Principal, after: string | null = null) =>
      custody.list(principal, after),
    async recover() {
      if (recovering) return;
      recovering = true;
      try {
        for (const row of options.runs.pendingWebhookDeliveries(
          options.scope,
        )) {
          const outcome = await Effect.runPromise(
            Effect.result(
              Effect.tryPromise(async () => {
                if (row.kind === "launch") {
                  // Durable admission linearized before revocation; finish ensuring
                  // THAT existing run, never admit a fresh run from expired cargo.
                  const run = options.runs.graph.read(row.runId);
                  if (run === null)
                    throw new Error("Reserved Workflow run is missing");
                  await options.launch({
                    runId: row.runId,
                    planDigest: run.plan.planDigest,
                  });
                } else {
                  const cargo = cargoSchema.parse(row.cargo);
                  const active = () =>
                    custody.verification.isActive(row.delivery.bindingId);
                  if (active())
                    await options.triggers.fire(
                      cargo.binding,
                      row.reservationId,
                      {
                        body: cargo.body,
                        headers: cargo.headers,
                        eventId: row.delivery.eventId,
                      },
                      {
                        admitBinding: active,
                        reservationId: row.reservationId,
                      },
                    );
                }
                options.runs.completeWebhookDelivery(row.reservationId);
              }),
            ),
          );
          if (Result.isFailure(outcome)) {
            // Leave the SAME reservation pending; do not expose error text or
            // mint a replacement request after a lost launch response.
            options.reportFailure();
          }
        }
      } finally {
        recovering = false;
        await options.wake();
      }
    },
  };
}
