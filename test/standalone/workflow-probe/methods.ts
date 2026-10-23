import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { pending } from "@fungi.computer/agar/backend-definition";
/** The probe runs Git only through its pinned Computer's native command. */
export type ProbeEnv = Readonly<{
  COMPUTER?: Readonly<{
    exec(
      input: Readonly<{ command: string; timeoutMs: number }>,
    ): Promise<z.input<typeof execResult>>;
    processStart(
      input: Readonly<{ command: string }>,
    ): Promise<z.input<typeof startedProcess>>;
  }>;
}>;
/** Only that the Computer started the child; never its output or env. */
const startedProcess = z.object({ id: z.string() });
/** Only the exit status a native command reports; never its output or env. */
const execResult = z.object({
  output: z.object({ exitCode: z.number().nullable() }),
});
const saveRecord = z.strictObject({
  outside: z.number().nullable(),
  saved: z.number().nullable(),
});
/**
 * Each native command receives its own Git step credential as command-local
 * Git config, and FUNGI_GIT_REMOTE names the ordinary credential-free remote.
 */
const prepare =
  'mkdir -p probe-save && cd probe-save && { git rev-parse -q --verify HEAD >/dev/null || { git init -q -b work && git -c user.name=Workflow -c user.email=workflow@test.invalid commit -q --allow-empty -m "Save storyboard"; }; }';
const push = (ref: string) =>
  prepare +
  ' && git push -q "$FUNGI_GIT_REMOTE" HEAD:' +
  ref +
  " >/dev/null 2>&1";
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
        "Push this Git step's branch from a native command; keep only exit statuses.",
      effect: "write",
      requires: ["computer.execute"],
      // The host adds the step's resolved gitAccess; the probe never reads it.
      input: z.object({}),
      output: z.strictObject({ saved: z.boolean() }),
      handler: async (_input, context, caller) => {
        if (!caller.idempotencyKey || context.env.COMPUTER === undefined)
          throw new Error("The Workflow Computer binding is unavailable");
        const computer = context.env.COMPUTER;
        const run = async (command: string) =>
          execResult.parse(await computer.exec({ command, timeoutMs: 30_000 }))
            .output.exitCode;
        // A push outside the granted branch fails; the granted branch lands.
        const record = saveRecord.parse({
          outside: await run(push("refs/heads/main")),
          saved: await run(push("refs/heads/storyboards")),
        });
        // A child the step starts keeps its own credential after this App
        // call returns, while it lives: it pushes one more commit later.
        startedProcess.parse(
          await computer.processStart({
            command:
              "sleep 3 && " +
              prepare +
              ' && git -c user.name=Workflow -c user.email=workflow@test.invalid commit -q --allow-empty -m Late && git push -q "$FUNGI_GIT_REMOTE" HEAD:refs/heads/storyboards >/dev/null 2>&1',
          }),
        );
        context.ctx.storage.sql.exec(
          "INSERT INTO saves(id,outside,saved) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET outside=excluded.outside,saved=excluded.saved",
          caller.idempotencyKey,
          record.outside,
          record.saved,
        );
        return { saved: record.saved === 0 };
      },
    }),
    saves: defineAppMethod({
      description: "Read the exit statuses of this probe's Git step commands.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: z.array(saveRecord),
      handler: (_input, context) =>
        z
          .array(saveRecord)
          .parse(
            context.ctx.storage.sql
              .exec("SELECT outside,saved FROM saves ORDER BY id")
              .toArray(),
          ),
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
