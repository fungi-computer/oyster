import * as z from "zod";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";

/** What each method sees: the facet's own SQLite storage. */
export type NotesContext = Readonly<{
  ctx: Readonly<{ storage: Pick<DurableObjectStorage, "sql"> }>;
}>;

const noteRow = z.object({ text: z.string() });

function notes(context: NotesContext) {
  context.ctx.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY CHECK(id=1), text TEXT NOT NULL)",
  );
  return context.ctx.storage.sql;
}

/** Notes: one note, kept in the App's own SQLite. */
export const appBackend = defineAppBackend<NotesContext>({
  methods: {
    readNote: defineAppMethod({
      description: "Read the note",
      effect: "read",
      requires: [],
      input: z.object({}),
      output: z.object({ text: z.string().nullable() }),
      handler: (_input, context) => {
        const row = notes(context)
          .exec("SELECT text FROM notes WHERE id=1")
          .toArray()[0];
        return { text: row === undefined ? null : noteRow.parse(row).text };
      },
    }),
    saveNote: defineAppMethod({
      description: "Replace the note with new text",
      effect: "write",
      requires: [],
      input: z.object({ text: z.string().max(10_000) }),
      output: z.object({ saved: z.literal(true) }),
      handler: ({ text }, context) => {
        notes(context).exec(
          "INSERT INTO notes VALUES(1,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text",
          text,
        );
        return { saved: true as const };
      },
    }),
  },
});
