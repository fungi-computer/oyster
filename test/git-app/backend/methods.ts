import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { z } from "zod";

/** The App's own SQLite; pushes arrive through its `onGitPush` lifecycle. */
export type GitProofContext = { sql: SqlStorage };

const push = z.strictObject({
  eventId: z.string(),
  repository: z.string(),
  refs: z.array(z.string()),
});
export const appBackend = defineAppBackend<GitProofContext>({
  methods: {
    pushes: defineAppMethod({
      description: "List accepted pushes this App received",
      effect: "read",
      requires: ["git.repository"],
      input: z.strictObject({}),
      output: z.array(push),
      handler: (_input, context) =>
        context.sql
          .exec("SELECT fact FROM pushes ORDER BY rowid")
          .toArray()
          .map((row) => push.parse(JSON.parse(z.string().parse(row.fact)))),
    }),
  },
});
