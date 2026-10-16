/**
 * An Agent's avatar is host data on the Agent, beside its directory record:
 * the one the owner chose, else Sprite's `seededAvatar(agentId)`. The seeded
 * default is a pure function of identity, so it is computed, never stored,
 * and an Agent created before any choice needs no stored row. Conversations
 * carry no avatar of their own. Both hosts (the Hub's Team store and a
 * standalone Oyster's Agent directory) keep the row in the same owner-local
 * SQLite as the directory, so a choice commits and erases with its Agent.
 */
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { seededAvatar, type Avatar } from "@fungi.computer/sprite/avatar";
import { avatarSchema } from "@fungi.computer/sprite-zdog/avatar";
import { avatarCatalog } from "@fungi.computer/sprite-zdog/catalog";
import { renderStyleSchema } from "@fungi.computer/sprite";
import { z } from "zod";

const storedAvatarRowSchema = z.strictObject({ avatar: z.string() });

/** The catalog-valid avatar an owner may choose for an Agent. */
export const agentAvatarSchema = avatarSchema;

const appearanceValue = z.union([z.string(), z.number(), z.boolean()]);
/** One character's avatar with its appearance closed to that character's controls. */
function closedCharacterAvatar<C extends keyof typeof avatarCatalog>(
  character: C,
) {
  return z.strictObject({
    v: z.literal(1),
    character: z.literal(character),
    appearance: z.strictObject(
      Object.fromEntries(
        Object.keys(avatarCatalog[character].controls).map((control) => [
          control,
          appearanceValue.optional(),
        ]),
      ),
    ),
    expression: z.string().min(1),
    renderStyle: renderStyleSchema,
  });
}

/**
 * The avatar as a closed record, for contracts that refuse open maps (Hub
 * projections): each character's appearance names only its own controls,
 * then the catalog refines it exactly as `agentAvatarSchema` does.
 */
export const agentAvatarProjectionSchema = z
  .discriminatedUnion("character", [
    closedCharacterAvatar("mushroom"),
    closedCharacterAvatar("cat"),
    closedCharacterAvatar("burger"),
  ])
  .superRefine((avatar, context) => {
    for (const issue of agentAvatarSchema.safeParse(avatar).error?.issues ?? [])
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
  });

/** A projected avatar as the Avatar descriptor Sprite draws. */
export function avatarFromProjection(
  projected: z.infer<typeof agentAvatarProjectionSchema>,
): Avatar {
  return agentAvatarSchema.parse(projected);
}

/** One owner-local store of chosen Agent avatars. */
export type AgentAvatarStore = Readonly<{
  /** The Agent's avatar: its chosen one, else its seeded default. */
  read(agentId: string): Avatar;
  /** Record the owner's choice; the caller owns the Agent's existence. */
  write(agentId: string, avatar: Avatar): void;
  /** Forget a removed Agent's choice in the caller's removal transaction. */
  remove(agentId: string): void;
}>;

/** Open the chosen-avatar table in the Agent directory's own SQLite. */
export function createAgentAvatarStore(
  sql: WatchdogSqliteOwner["sql"],
): AgentAvatarStore {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS agent_avatars (agent_id TEXT PRIMARY KEY, avatar TEXT NOT NULL) STRICT",
  );
  return {
    read(agentId) {
      const row = sql
        .exec("SELECT avatar FROM agent_avatars WHERE agent_id = ?", agentId)
        .toArray()[0];
      if (row === undefined) return seededAvatar(agentId);
      const stored = storedAvatarRowSchema.parse(row);
      return agentAvatarSchema.parse(JSON.parse(stored.avatar));
    },
    write(agentId, avatar) {
      sql.exec(
        "INSERT INTO agent_avatars(agent_id, avatar) VALUES(?, ?) ON CONFLICT(agent_id) DO UPDATE SET avatar = excluded.avatar",
        agentId,
        JSON.stringify(agentAvatarSchema.parse(avatar)),
      );
    },
    remove(agentId) {
      sql.exec("DELETE FROM agent_avatars WHERE agent_id = ?", agentId);
    },
  };
}
