import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";
const text = z.string().min(1).max(256);
const noChange = Symbol("no-change");
const attachmentRowSchema = z.strictObject({
  attachment_id: z.string(),
  agent_id: z.string(),
  computer_id: z.string(),
  version: z.number().int().positive(),
});

const attachmentIdentitySchema = z.strictObject({
  attachmentId: text,
  agentId: text,
  computerId: text,
  version: z.number().int().nonnegative(),
});
const attachmentProjectionSchema = attachmentIdentitySchema.extend({
  name: text,
  admission: z
    .strictObject({
      grantId: text,
      agentId: text,
      attachmentId: text,
      operations: z.array(
        z.enum([
          "computer.list",
          "computer.readFile",
          "computer.writeFile",
          "computer.execute",
        ]),
      ),
      attachmentVersion: z.number().int().positive(),
      revision: z.number().int().positive(),
      expiresAt: z.number().int().positive(),
    })
    .nullable(),
});
export const projectionSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  attachments: z.array(attachmentProjectionSchema),
});
class AgentComputersError extends Error {
  constructor(
    readonly code:
      "request_conflict" | "not_attached" | "attachment_identity_conflict",
  ) {
    super(code);
  }
}
export type AgentComputerProjection = z.output<typeof projectionSchema>;
/** The parsed admission fields shared by the projection and the host's read port. */
export type AgentComputerAdmissionFields = NonNullable<
  AgentComputerProjection["attachments"][number]["admission"]
>;
/** Host-issued attachment admission; the host owns its policy and delivery. */
export type AgentComputerAdmission = Readonly<
  Omit<AgentComputerAdmissionFields, "operations"> & {
    operations: readonly AgentComputerAdmissionFields["operations"][number][];
  }
>;
export type ComputerAttachmentInput = Readonly<{
  agentId: string;
  attachmentId: string;
  computerId: string;
  requestId: string;
}>;
export type AttachComputer = ComputerAttachmentInput;
export type DetachComputer = ComputerAttachmentInput;
type AgentComputersReceiptPayload = Readonly<{
  attachmentId: string;
  computerId: string;
}>;
export type AttachmentVersion = Readonly<{
  computerId: string;
  agentId: string;
  attachmentId: string;
  version: number;
}>;
/** Renew a held Computer admission before its delivered grant expires. */
export const AGENT_ADMISSION_RENEW_BEFORE_MS = 30_000;

export type AgentComputers = Readonly<{
  attachComputer(c: AttachComputer): AgentComputerProjection;
  detachComputer(c: DetachComputer): AgentComputerProjection;
  /** The attachment owner's transactionally advanced projection generation. */
  revision(agentId: string): number;
  read(agentId: string): AgentComputerProjection;
  refresh(agentId: string, force?: boolean): AgentComputerProjection;
  /** Every live attachment, for host-wide admission renewal or suspension. */
  attachments(): readonly AttachmentVersion[];
  /** Git admission reads live links through their owner, without foreign SQL. */
  attachedComputers(agentId: string): readonly string[];
  attachedAgents(computerId: string): readonly string[];
  nextRenewal(): number | null;
  /** Void every live attachment's decision by moving its version past it. */
  onLifecycle(status: "active" | "suspended", revision: number): void;
}>;
const computerAttachmentInputSchema = z.strictObject({
  agentId: text,
  attachmentId: text,
  computerId: text,
  requestId: text,
});
export const attachComputerInputSchema = computerAttachmentInputSchema;
export const detachComputerInputSchema = computerAttachmentInputSchema;
export const readAgentComputersInputSchema = z.strictObject({ agentId: text });
export function createAgentComputers(
  options: Readonly<{
    sql: WatchdogSqliteOwner["sql"];
    transactionSync: <T>(body: () => T) => T;
    /** Record Computer denial in the same transaction that detaches this relationship. */
    revoke: (
      requestId: string,
      attachment: z.output<typeof attachmentIdentitySchema>,
    ) => void;
    /** Read the host-owned friendly name for one attached Computer. */
    readComputerName: (computerId: string) => string;
    /** Stage a host-owned projection in the mutation transaction. */
    enqueueProjection?: (
      agentId: string,
      projection: AgentComputerProjection,
    ) => void;
    ensureAdmissions?: (
      attachments: AgentComputerProjection["attachments"],
    ) => boolean;
    readAdmission?: (attachment: {
      agentId: string;
      attachmentId: string;
      computerId: string;
      version: number;
    }) => AgentComputerAdmission | null;
  }>,
): AgentComputers {
  const { sql, transactionSync } = options;
  const ensure = () => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_agent_computers (attachment_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, computer_id TEXT NOT NULL, version INTEGER NOT NULL, attached INTEGER NOT NULL CHECK (attached IN (0, 1)), UNIQUE (agent_id, computer_id)) STRICT",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_agent_computer_revisions (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_agent_computer_receipts (request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, operation TEXT NOT NULL, input TEXT NOT NULL, attachment_id TEXT, revision INTEGER NOT NULL, result TEXT NOT NULL) STRICT",
    );
  };
  transactionSync(ensure);
  const revision = (agentId: string) =>
    z
      .number()
      .int()
      .nonnegative()
      .parse(
        sql
          .exec(
            "SELECT revision FROM hub_agent_computer_revisions WHERE agent_id = ?",
            agentId,
          )
          .toArray()[0]?.revision ?? 0,
      );
  const read = (agentId: string): AgentComputerProjection => {
    const attachments = sql
      .exec(
        "SELECT attachment_id, agent_id, computer_id, version FROM hub_agent_computers WHERE agent_id = ? AND attached = 1 ORDER BY attachment_id",
        agentId,
      )
      .toArray()
      .map((row) => attachmentRowSchema.parse(row))
      .map((r) => ({
        attachmentId: r.attachment_id,
        agentId: r.agent_id,
        computerId: r.computer_id,
        version: r.version,
        name: options.readComputerName(r.computer_id),
        admission:
          options.readAdmission?.({
            attachmentId: r.attachment_id,
            agentId: r.agent_id,
            computerId: r.computer_id,
            version: r.version,
          }) ?? null,
      }));
    return projectionSchema.parse({ revision: revision(agentId), attachments });
  };
  const commit = (
    agentId: string,
    operation: string,
    requestId: string,
    payload: AgentComputersReceiptPayload,
    mutate: () => string | null | typeof noChange,
  ) =>
    transactionSync(() => {
      const input = JSON.stringify({ agentId, operation, payload });
      const old = sql
        .exec(
          "SELECT agent_id, operation, input, result FROM hub_agent_computer_receipts WHERE request_id = ?",
          requestId,
        )
        .toArray()[0];
      if (old) {
        if (
          old.agent_id !== agentId ||
          old.operation !== operation ||
          old.input !== input
        )
          throw new AgentComputersError("request_conflict");
        return projectionSchema.parse(JSON.parse(z.string().parse(old.result)));
      }
      const changed = mutate();
      const before = read(agentId);
      if (changed === noChange) {
        sql.exec(
          "INSERT INTO hub_agent_computer_receipts (request_id,agent_id,operation,input,attachment_id,revision,result) VALUES (?,?,?,?,NULL,?,?)",
          requestId,
          agentId,
          operation,
          input,
          before.revision,
          JSON.stringify(before),
        );
        return before;
      }
      const revision = before.revision + 1;
      sql.exec(
        "INSERT INTO hub_agent_computer_revisions (agent_id,revision) VALUES (?,?) ON CONFLICT (agent_id) DO UPDATE SET revision=excluded.revision",
        agentId,
        revision,
      );
      const beforeAdmission = read(agentId);
      options.ensureAdmissions?.(beforeAdmission.attachments);
      const current = read(agentId);
      sql.exec(
        "INSERT INTO hub_agent_computer_receipts (request_id,agent_id,operation,input,attachment_id,revision,result) VALUES (?,?,?,?,?,?,?)",
        requestId,
        agentId,
        operation,
        input,
        changed,
        revision,
        JSON.stringify(current),
      );
      options.enqueueProjection?.(agentId, current);
      return current;
    });
  const attachComputer = (raw: AttachComputer) => {
    const c = attachComputerInputSchema.parse(raw);
    const payload = { attachmentId: c.attachmentId, computerId: c.computerId };
    return commit(c.agentId, "attachComputer", c.requestId, payload, () => {
      const row = sql
        .exec(
          "SELECT agent_id, computer_id, attached FROM hub_agent_computers WHERE attachment_id=?",
          c.attachmentId,
        )
        .toArray()[0];
      if (
        row !== undefined &&
        (row.agent_id !== c.agentId || row.computer_id !== c.computerId)
      )
        throw new AgentComputersError("attachment_identity_conflict");
      let changed = false;
      if (row?.attached === 0) {
        sql.exec(
          "UPDATE hub_agent_computers SET attached=1,version=version+1 WHERE attachment_id=?",
          c.attachmentId,
        );
        changed = true;
      } else if (row === undefined) {
        sql.exec(
          "INSERT INTO hub_agent_computers (attachment_id,agent_id,computer_id,version,attached) VALUES (?,?,?,1,1)",
          c.attachmentId,
          c.agentId,
          c.computerId,
        );
        changed = true;
      }
      return changed ? c.attachmentId : noChange;
    });
  };
  const detachComputer = (raw: DetachComputer) => {
    const c = detachComputerInputSchema.parse(raw);
    return commit(
      c.agentId,
      "detachComputer",
      c.requestId,
      {
        attachmentId: c.attachmentId,
        computerId: c.computerId,
      },
      () => {
        const stored = sql
          .exec(
            "SELECT agent_id, computer_id, attached, version FROM hub_agent_computers WHERE attachment_id=?",
            c.attachmentId,
          )
          .toArray()[0];
        if (
          stored !== undefined &&
          (stored.agent_id !== c.agentId || stored.computer_id !== c.computerId)
        )
          throw new AgentComputersError("attachment_identity_conflict");
        if (stored === undefined || stored.attached === 0) return noChange;
        sql.exec(
          "UPDATE hub_agent_computers SET attached=0,version=version+1 WHERE attachment_id=?",
          c.attachmentId,
        );
        options.revoke(
          c.requestId,
          attachmentIdentitySchema.parse({
            attachmentId: c.attachmentId,
            agentId: stored.agent_id,
            computerId: stored.computer_id,
            version: stored.version,
          }),
        );
        return c.attachmentId;
      },
    );
  };
  const refresh = (agentId: string, force = false) =>
    transactionSync(() => {
      const before = read(agentId);
      const renewed = options.ensureAdmissions?.(before.attachments) ?? false;
      if (!force && !renewed) return before;
      const revision = before.revision + 1;
      sql.exec(
        "INSERT INTO hub_agent_computer_revisions (agent_id,revision) VALUES (?,?) ON CONFLICT (agent_id) DO UPDATE SET revision=excluded.revision",
        agentId,
        revision,
      );
      const current = read(agentId);
      options.enqueueProjection?.(agentId, current);
      return current;
    });
  const attachments = (): readonly AttachmentVersion[] =>
    sql
      .exec(
        "SELECT agent_id,attachment_id,computer_id,version FROM hub_agent_computers WHERE attached=1 ORDER BY agent_id,attachment_id",
      )
      .toArray()
      .map((row) => attachmentRowSchema.parse(row))
      .map((row) => ({
        agentId: row.agent_id,
        attachmentId: row.attachment_id,
        computerId: row.computer_id,
        version: row.version,
      }));
  const advanceAttachedVersions = () => {
    sql.exec(
      "UPDATE hub_agent_computers SET version=version+1 WHERE attached=1",
    );
  };
  return {
    attachComputer,
    detachComputer,
    revision,
    read,
    refresh,
    attachments,
    attachedComputers: (agentId) =>
      sql
        .exec(
          "SELECT computer_id FROM hub_agent_computers WHERE agent_id=? AND attached=1",
          agentId,
        )
        .toArray()
        .map(({ computer_id }) => z.string().parse(computer_id)),
    attachedAgents: (computerId) =>
      sql
        .exec(
          "SELECT agent_id FROM hub_agent_computers WHERE computer_id=? AND attached=1",
          computerId,
        )
        .toArray()
        .map(({ agent_id }) => z.string().parse(agent_id)),
    nextRenewal: () => {
      const agentIds = new Set(attachments().map(({ agentId }) => agentId));
      const deadlines = [...agentIds].flatMap((agentId) =>
        read(agentId).attachments.map(({ admission }) =>
          admission === null
            ? Date.now()
            : admission.expiresAt - AGENT_ADMISSION_RENEW_BEFORE_MS,
        ),
      );
      return deadlines.length === 0 ? null : Math.min(...deadlines);
    },
    onLifecycle: (status, revision) => {
      const current = attachments();
      if (status === "suspended") {
        for (const attachment of current)
          options.revoke(
            JSON.stringify([
              "team-suspension",
              revision,
              attachment.agentId,
              attachment.attachmentId,
            ]),
            attachment,
          );
        advanceAttachedVersions();
      }
      for (const agentId of new Set(current.map(({ agentId }) => agentId)))
        refresh(agentId, true);
    },
  };
}
