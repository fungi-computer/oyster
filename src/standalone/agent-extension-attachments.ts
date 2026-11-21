/**
 * Which hosted extensions the owner attached to each Agent. The row is the
 * extension consent: an Agent's blanket App-tool approval never asks an
 * extension by itself. Each row pins the installation's Instance, so a
 * removed or replaced installation reads as unattached, and its grantor's
 * membership version, so a membership change revokes it. A store opened
 * from before this table existed simply has no attachments.
 */
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

const storedAttachmentSchema = z.strictObject({
  installation_id: z.string().min(1),
  instance_id: z.string().min(1),
  attached_by: z.string().min(1),
  membership_version: z.number().int().positive(),
});

/** One owner-attached hosted extension of an Agent, as stored. */
export type AgentExtensionAttachment = Readonly<{
  installationId: string;
  instanceId: string;
  attachedBy: string;
  membershipVersion: number;
}>;

export type AgentExtensionAttachments = Readonly<{
  /** Attach or re-attach; the latest owner and Instance replace the row. */
  attach: (agentId: string, attachment: AgentExtensionAttachment) => void;
  /** Whether a row was removed. */
  detach: (agentId: string, installationId: string) => boolean;
  list: (agentId: string) => readonly AgentExtensionAttachment[];
}>;

/** Open the attachment table in the Agent directory's own SQLite. */
export function createAgentExtensionAttachments(
  sql: WatchdogSqliteOwner["sql"],
): AgentExtensionAttachments {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS agent_extension_attachments (agent_id TEXT NOT NULL, installation_id TEXT NOT NULL, instance_id TEXT NOT NULL, attached_by TEXT NOT NULL, membership_version INTEGER NOT NULL, PRIMARY KEY (agent_id, installation_id)) STRICT",
  );
  return {
    attach(agentId, attachment) {
      sql.exec(
        "INSERT INTO agent_extension_attachments(agent_id, installation_id, instance_id, attached_by, membership_version) VALUES(?, ?, ?, ?, ?) ON CONFLICT(agent_id, installation_id) DO UPDATE SET instance_id = excluded.instance_id, attached_by = excluded.attached_by, membership_version = excluded.membership_version",
        agentId,
        attachment.installationId,
        attachment.instanceId,
        attachment.attachedBy,
        attachment.membershipVersion,
      );
    },
    detach(agentId, installationId) {
      return (
        sql
          .exec(
            "DELETE FROM agent_extension_attachments WHERE agent_id = ? AND installation_id = ? RETURNING installation_id",
            agentId,
            installationId,
          )
          .toArray().length > 0
      );
    },
    list(agentId) {
      return sql
        .exec(
          "SELECT installation_id, instance_id, attached_by, membership_version FROM agent_extension_attachments WHERE agent_id = ? ORDER BY installation_id",
          agentId,
        )
        .toArray()
        .map((row) => {
          const stored = storedAttachmentSchema.parse(row);
          return {
            installationId: stored.installation_id,
            instanceId: stored.instance_id,
            attachedBy: stored.attached_by,
            membershipVersion: stored.membership_version,
          };
        });
    },
  };
}
