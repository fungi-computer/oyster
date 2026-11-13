import { z } from "zod";
import { appAgentInstructionsMaxLength } from "@fungi.computer/agar";

/**
 * The standing instructions an owner gave one Agent. They live in the Agent's
 * own store, so every turn reads them where it runs. The owner's text is
 * appended after Oyster's fixed instructions and never replaces them.
 */

/** The SQL an Agent's own store offers: the one statement call both hosts share. */
export type InstructionsSql = Readonly<{
  exec: (
    statement: string,
    ...bindings: (ArrayBuffer | string | number | null)[]
  ) => Readonly<{ toArray: () => readonly unknown[] }>;
}>;

const storedRow = z.strictObject({
  instructions: z.string().max(appAgentInstructionsMaxLength),
  version: z.number().int().nonnegative(),
});

/** What the owner wrote, and which edit of it this is; 0 means never written. */
export type StoredAgentInstructions = z.infer<typeof storedRow>;

/** Open the Agent's one instructions row in its own SQLite. */
export function createAgentInstructions(sql: InstructionsSql) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS agent_instructions (id INTEGER PRIMARY KEY CHECK (id = 1), instructions TEXT NOT NULL, version INTEGER NOT NULL) STRICT",
  );
  return {
    read(): StoredAgentInstructions {
      const row = sql
        .exec("SELECT instructions, version FROM agent_instructions")
        .toArray()[0];
      return row === undefined
        ? { instructions: "", version: 0 }
        : storedRow.parse(row);
    },
    /** Replace the text, one version up; empty text clears it. */
    write(instructions: string): StoredAgentInstructions {
      const checked = z
        .string()
        .max(appAgentInstructionsMaxLength)
        .parse(instructions);
      sql.exec(
        "INSERT INTO agent_instructions(id, instructions, version) VALUES(1, ?, 1) ON CONFLICT(id) DO UPDATE SET instructions = excluded.instructions, version = version + 1",
        checked,
      );
      return this.read();
    },
  };
}

/** One turn's instructions: a revision that names them, and their text. */
export type LoadedInstructions = Readonly<{ revision: string; text: string }>;

/**
 * The fixed instructions, then the owner's after them. A revision names both,
 * so an edit is seen by the next turn and by nothing already running.
 */
export function withOwnerInstructions(
  fixed: LoadedInstructions,
  owner: StoredAgentInstructions,
): LoadedInstructions {
  const text = owner.instructions.trim();
  if (text.length === 0) return fixed;
  return {
    revision: `${fixed.revision}+owner-${String(owner.version)}`,
    text: `${fixed.text}\n\nYour owner's standing instructions. Follow them on every turn, within the rules above:\n${text}`,
  };
}
