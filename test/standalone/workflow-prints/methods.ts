import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";

/**
 * A stand-in for Prints' catalog, for the Trellis test-step proof only. It
 * declares the method Hero B's "Make the cover" step calls, as a write step
 * (a standalone host refuses external-effect steps), and records every call
 * it really receives so the proof can say whether a test ran it.
 */
type PrintsContext = { ctx: DurableObjectState };
const image = { type: "string", format: "fungi:image" } as const;
export const appBackend = defineAppBackend<PrintsContext>({
  methods: {
    generateImage: defineAppMethod({
      description: "Generate an image from a prompt",
      effect: "write",
      requires: [],
      input: z.strictObject({
        prompt: z.string(),
        model: z.string(),
        width: z.number(),
        height: z.number(),
      }),
      output: z.strictObject({
        image: z.string().meta({ format: image.format }),
      }),
      handler: (input, context, caller) => {
        if (!caller.idempotencyKey)
          throw new Error("Workflow must supply its stable call key");
        context.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO prints(id,prompt) VALUES(?,?)",
          caller.idempotencyKey,
          input.prompt,
        );
        return { image: "/Prints/weekly-cover.png" };
      },
    }),
    received: defineAppMethod({
      description: "Read the prompts this stand-in really received.",
      effect: "read",
      requires: [],
      input: z.strictObject({}),
      output: z.array(z.strictObject({ prompt: z.string() })),
      handler: (_input, context) =>
        z
          .array(z.strictObject({ prompt: z.string() }))
          .parse(
            context.ctx.storage.sql
              .exec("SELECT prompt FROM prints ORDER BY id")
              .toArray(),
          ),
    }),
  },
});
