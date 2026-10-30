import { member, routes as routesFor } from "./authorization.js";
import { bodyLimit } from "hono/body-limit";
import { causeClass } from "./cause-class.js";
import * as Schema from "effect/Schema";
import {
  ApprovalListInputSchema,
  ApprovalGetInputSchema,
  ApprovalAnswerInputSchema,
  AutoApproveInputSchema,
  type Approvals,
} from "@fungi.computer/approvals";
import type { HostActor } from "@fungi.computer/puffball/app";
import type { CapabilityEnv, OysterCapability } from "./host.js";

/** Ordinary capability routes; the outer App gate supplies consent, and only members answer. */
export function approvalCapability(
  control: (actor: HostActor) => Approvals,
): OysterCapability {
  const strict = { onExcessProperty: "error" } as const;
  const eligible = member(() =>
    Response.json({ kind: "refused", reason: "not-eligible" }, { status: 403 }),
  );
  const options = { middleware: [bodyLimit({ maxSize: 4096 })] };
  const routes = routesFor<CapabilityEnv>()
    .post(
      "/list",
      eligible,
      async (c, { principal }) =>
        c.json(
          await control(principal.actor).list(
            Schema.decodeUnknownSync(
              ApprovalListInputSchema,
              strict,
            )(await c.req.json()),
          ),
        ),
      options,
    )
    .post(
      "/get",
      eligible,
      async (c, { principal }) =>
        c.json(
          await control(principal.actor).get(
            Schema.decodeUnknownSync(
              ApprovalGetInputSchema,
              strict,
            )(await c.req.json()),
          ),
        ),
      options,
    )
    .post(
      "/answer",
      eligible,
      async (c, { principal }) =>
        c.json(
          await control(principal.actor).answer(
            Schema.decodeUnknownSync(
              ApprovalAnswerInputSchema,
              strict,
            )(await c.req.json()),
          ),
        ),
      options,
    )
    .post(
      "/set-auto-approve",
      eligible,
      async (c, { principal }) =>
        c.json(
          await control(principal.actor).setAutoApprove(
            Schema.decodeUnknownSync(
              AutoApproveInputSchema,
              strict,
            )(await c.req.json()),
          ),
        ),
      options,
    )
    .onError((cause, context) => {
      if (cause instanceof SyntaxError || cause instanceof Schema.SchemaError)
        return context.json({ error: "Invalid approval request" }, 400);
      console.warn("Native approval control failed", {
        causeClass: causeClass(cause),
      });
      return context.json({ error: "Approval home unavailable" }, 503);
    });
  return {
    id: "approvals",
    version: 1,
    permission: "approvals",
    base: "/approvals/",
    routes,
    methods: {
      list: { kind: "json", method: "POST", path: "list" },
      get: { kind: "json", method: "POST", path: "get" },
      answer: { kind: "json", method: "POST", path: "answer" },
      setAutoApprove: {
        kind: "json",
        method: "POST",
        path: "set-auto-approve",
      },
    },
  };
}
