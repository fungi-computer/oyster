import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
  type AppRegionEvent,
  type AppRegionReply,
} from "@fungi.computer/agar/backend-definition";

/** The App's own facet: its isolated SQLite holds the whole Region state. */
export type RegionContext = Readonly<{
  ctx: Readonly<{ storage: Readonly<{ sql: SqlStorage }> }>;
}>;

const stateSchema = z.strictObject({
  counter: z.number().int(),
  ticks: z.number().int(),
  callers: z.array(z.unknown()),
});
type RegionState = z.output<typeof stateSchema>;

function read(context: RegionContext): RegionState {
  const sql = context.ctx.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS region_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL) STRICT",
  );
  const row = sql
    .exec("SELECT state FROM region_state WHERE id = 1")
    .toArray()[0];
  return row === undefined
    ? { counter: 0, ticks: 0, callers: [] }
    : stateSchema.parse(JSON.parse(z.string().parse(row.state)));
}

function write(context: RegionContext, state: RegionState): void {
  context.ctx.storage.sql.exec(
    "INSERT INTO region_state (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state",
    JSON.stringify(state),
  );
}

const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("increment") }),
  z.strictObject({
    kind: z.literal("arm"),
    afterMs: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal("read") }),
]);

/** A neutral Region: a durable counter, one timed wake and the callers it saw. */
async function onRegion(
  event: AppRegionEvent,
  context: RegionContext,
): Promise<AppRegionReply> {
  const state = read(context);
  const reply = (connection: string, extra: AppRegionReply = {}) => ({
    ...extra,
    send: [{ connection, data: JSON.stringify(state) }],
  });
  switch (event.kind) {
    case "connect":
      state.callers.push(event.caller);
      write(context, state);
      return Promise.resolve(reply(event.connection));
    case "message": {
      const command = commandSchema.parse(JSON.parse(event.data));
      if (command.kind === "increment") {
        state.counter += 1;
        write(context, state);
      }
      return Promise.resolve(
        reply(
          event.connection,
          command.kind === "arm"
            ? { wakeAt: Date.now() + command.afterMs }
            : {},
        ),
      );
    }
    case "alarm":
      state.ticks += 1;
      state.counter += 1;
      write(context, state);
      return Promise.resolve({});
    case "close":
      return Promise.resolve({});
  }
}

export const appBackend = defineAppBackend<RegionContext>({
  methods: {
    status: defineAppMethod({
      description: "Read the Region's durable counter",
      effect: "read",
      requires: [],
      input: z.object({}),
      output: stateSchema,
      handler: (_input, context: RegionContext) => read(context),
    }),
  },
  region: onRegion,
});
