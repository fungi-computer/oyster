import { Hono } from "hono";
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

/** Ordinary capability routes; the outer App gate supplies identity and consent. */
export function approvalCapability(
  control: (actor: HostActor) => Approvals,
): OysterCapability {
  const routes = new Hono<CapabilityEnv>();
  routes.use("*", bodyLimit({ maxSize: 4096 }));
  routes.use("*", async (context, next) => {
    if (context.env.principal.actor.kind !== "member")
      return context.json({ kind: "refused", reason: "not-eligible" }, 403);
    await next();
    return undefined;
  });
  routes.onError((cause, context) => {
    if (cause instanceof SyntaxError || cause instanceof Schema.SchemaError)
      return context.json({ error: "Invalid approval request" }, 400);
    console.warn("Native approval control failed", {
      causeClass: causeClass(cause),
    });
    return context.json({ error: "Approval home unavailable" }, 503);
  });
  const strict = { onExcessProperty: "error" } as const;
  routes.post("/list", async (c) =>
    c.json(
      await control(c.env.principal.actor).list(
        Schema.decodeUnknownSync(
          ApprovalListInputSchema,
          strict,
        )(await c.req.json()),
      ),
    ),
  );
  routes.post("/get", async (c) =>
    c.json(
      await control(c.env.principal.actor).get(
        Schema.decodeUnknownSync(
          ApprovalGetInputSchema,
          strict,
        )(await c.req.json()),
      ),
    ),
  );
  routes.post("/answer", async (c) =>
    c.json(
      await control(c.env.principal.actor).answer(
        Schema.decodeUnknownSync(
          ApprovalAnswerInputSchema,
          strict,
        )(await c.req.json()),
      ),
    ),
  );
  routes.post("/set-auto-approve", async (c) =>
    c.json(
      await control(c.env.principal.actor).setAutoApprove(
        Schema.decodeUnknownSync(
          AutoApproveInputSchema,
          strict,
        )(await c.req.json()),
      ),
    ),
  );
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
