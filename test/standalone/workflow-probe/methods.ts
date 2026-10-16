import * as z from "zod";
import {
  workflowGitPassResultSchema,
  type WorkflowGitPassResult,
} from "@fungi.computer/agar/computer-contracts";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { pending } from "@fungi.computer/agar/backend-definition";
/** The probe asks only for the host's Workflow Git pass on its pinned Computer. */
export type ProbeEnv = Readonly<{
  COMPUTER?: Readonly<{
    workflowGitPass(
      input: Record<string, never>,
    ): Promise<WorkflowGitPassResult>;
  }>;
}>;
const passRecord = z.strictObject({
  remote: z.string(),
  bearer: z.string().optional(),
});
type ProbeContext = { ctx: DurableObjectState; env: ProbeEnv };
const row = z.strictObject({ calls: z.number(), keys: z.string() });
export const appBackend = defineAppBackend<ProbeContext>({
  methods: {
    poll: defineAppMethod({
      description:
        "Finish after three real durable App calls, or keep waiting.",
      effect: "write",
      requires: [],
      pending: true,
      input: z.strictObject({ text: z.string(), wait: z.boolean() }),
      output: z.strictObject({
        text: z.string(),
        calls: z.number(),
        keys: z.array(z.string()),
      }),
      handler: (input, context, caller) => {
        if (!caller.idempotencyKey)
          throw new Error("Workflow must supply its stable call key");
        const prior = context.ctx.storage.sql
          .exec(
            "SELECT calls,keys FROM probe WHERE id=?",
            caller.idempotencyKey,
          )
          .toArray()[0];
        const stored =
          prior === undefined ? { calls: 0, keys: "[]" } : row.parse(prior);
        const calls = stored.calls + 1;
        const keys = [
          ...z.array(z.string()).parse(JSON.parse(stored.keys)),
          caller.idempotencyKey,
        ];
        context.ctx.storage.sql.exec(
          "INSERT INTO probe(id,calls,keys) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET calls=excluded.calls,keys=excluded.keys",
          caller.idempotencyKey,
          calls,
          JSON.stringify(keys),
        );
        return calls < 3 || input.wait
          ? pending(1000)
          : { text: input.text, calls, keys };
      },
    }),
    stamp: defineAppMethod({
      description:
        "Record one scheduled delivery with the caller the host admitted.",
      effect: "write",
      requires: [],
      input: z.strictObject({ at: z.string() }),
      output: z.strictObject({ at: z.string() }),
      handler: (input, context, caller) => {
        if (!caller.idempotencyKey)
          throw new Error("Workflow must supply its stable call key");
        context.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO stamps(id,at,caller) VALUES(?,?,?)",
          caller.idempotencyKey,
          input.at,
          JSON.stringify({ actor: caller.actor, workflow: caller.workflow }),
        );
        return { at: input.at };
      },
    }),
    save: defineAppMethod({
      description:
        "Open this Git step's Workflow pass and keep it for the proof.",
      effect: "write",
      requires: ["computer.execute"],
      // The host adds the step's resolved gitAccess; the probe never reads it.
      input: z.object({}),
      output: z.strictObject({ saved: z.boolean() }),
      handler: async (_input, context, caller) => {
        if (!caller.idempotencyKey || context.env.COMPUTER === undefined)
          throw new Error("Workflow Git pass binding is unavailable");
        const pass = workflowGitPassResultSchema.parse(
          await context.env.COMPUTER.workflowGitPass({}),
        );
        context.ctx.storage.sql.exec(
          "INSERT INTO passes(id,pass) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET pass=excluded.pass",
          caller.idempotencyKey,
          JSON.stringify({ remote: pass.remote, bearer: pass.bearer }),
        );
        return { saved: true };
      },
    }),
    passes: defineAppMethod({
      description: "Read the Workflow Git passes this probe received.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: z.array(passRecord),
      handler: (_input, context) =>
        z
          .array(z.strictObject({ pass: z.string() }))
          .parse(
            context.ctx.storage.sql
              .exec("SELECT pass FROM passes ORDER BY id")
              .toArray(),
          )
          .map((row) => passRecord.parse(JSON.parse(row.pass))),
    }),
    stamps: defineAppMethod({
      description: "Read recorded scheduled deliveries.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: z.array(z.strictObject({ at: z.string(), caller: z.string() })),
      handler: (_input, context) =>
        z
          .array(z.strictObject({ at: z.string(), caller: z.string() }))
          .parse(
            context.ctx.storage.sql
              .exec("SELECT at,caller FROM stamps ORDER BY at")
              .toArray(),
          ),
    }),
    counts: defineAppMethod({
      description:
        "Read observed call counts without executing the Workflow step.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: z.array(z.strictObject({ id: z.string(), calls: z.number() })),
      handler: (_input, context) =>
        z
          .array(z.strictObject({ id: z.string(), calls: z.number() }))
          .parse(
            context.ctx.storage.sql
              .exec("SELECT id,calls FROM probe ORDER BY id")
              .toArray(),
          ),
    }),
  },
});
