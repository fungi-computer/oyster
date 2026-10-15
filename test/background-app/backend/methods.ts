import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import {
  backgroundOriginSchema,
  type BackgroundBinding,
} from "@fungi.computer/puffball/background-replay";
import { z } from "zod";
import type { AppCatalog } from "@fungi.computer/oyster/shell/app-directory";

/** Native host-port fixture; durable rows expose the actual alarm's admission result. */
export type BackgroundContext = {
  sql: SqlStorage;
  env: {
    APPS: { catalog(input: Record<never, never>): Promise<AppCatalog> };
    BACKGROUND?: BackgroundBinding;
  };
};
const input = z.strictObject({});
const requires = ["team.workbenchHost"] as const;
const row = z.strictObject({
  origin: z.string(),
  result: z.string().nullable(),
});
function read(context: BackgroundContext) {
  context.sql.exec(
    "CREATE TABLE IF NOT EXISTS native_background (id INTEGER PRIMARY KEY CHECK(id=1), origin TEXT NOT NULL, result TEXT) STRICT",
  );
  const value = context.sql
    .exec("SELECT origin,result FROM native_background WHERE id=1")
    .toArray()[0];
  return value === undefined ? null : row.parse(value);
}
export const appBackend = defineAppBackend<BackgroundContext>({
  sync: { method: "continueRows" },
  methods: {
    enqueue: defineAppMethod({
      description: "Retain the sealed foreground origin",
      effect: "write",
      requires,
      input,
      output: z.strictObject({ queued: z.boolean() }),
      handler: (_input, context, caller) => {
        read(context);
        const origin = backgroundOriginSchema.parse(caller.backgroundOrigin);
        context.sql.exec(
          "INSERT INTO native_background(id,origin,result) VALUES(1,?,NULL) ON CONFLICT(id) DO UPDATE SET origin=excluded.origin,result=NULL",
          JSON.stringify(origin),
        );
        return { queued: true };
      },
    }),
    continueRows: defineAppMethod({
      description: "Prove the alarm's claimed-origin port",
      effect: "write",
      requires,
      input,
      output: z.strictObject({ more: z.boolean() }),
      handler: async (_input, context, caller) => {
        const stored = read(context);
        if (stored?.result !== null) return { more: false };
        if (context.env.BACKGROUND === undefined)
          throw new Error("Replay binding missing");
        let beforeRefusal = "";
        try {
          await context.env.APPS.catalog({});
        } catch (cause) {
          beforeRefusal = String(cause);
        }
        if (!beforeRefusal.includes("revoked"))
          throw new Error("Catalog was not refused before origin admission");
        const decision = await context.env.BACKGROUND.admit(
          backgroundOriginSchema.parse(JSON.parse(stored.origin)),
        );
        if (decision.kind !== "admitted")
          throw new Error("Stored origin was not admitted");
        const catalog = await context.env.APPS.catalog({});
        context.sql.exec(
          "UPDATE native_background SET result=? WHERE id=1",
          JSON.stringify({
            beforeRefusal,
            decision,
            catalogCount: catalog.apps.length,
            actor: caller.actor,
            role: caller.role,
            foregroundLaneAbsent: caller.backgroundLane === undefined,
            foregroundOriginAbsent: caller.backgroundOrigin === undefined,
          }),
        );
        return { more: false };
      },
    }),
    status: defineAppMethod({
      description: "Read the completed native admission proof",
      effect: "read",
      requires,
      input,
      output: z.json(),
      handler: (_input, context) => {
        const stored = read(context);
        return stored?.result === null || stored === null
          ? null
          : z.json().parse(JSON.parse(stored.result));
      },
    }),
  },
});
