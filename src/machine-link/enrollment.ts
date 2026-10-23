import { defineIdFamily } from "@fungi.computer/cairn/id";
import { importSeamVerifiers } from "@fungi.computer/seam";
import type { MachineAgentHome } from "./home.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

const identity = z.string().min(1).max(256);
const selectedAgent = z.strictObject({
  name: z.string().trim().min(1).max(256),
});

/** Public keys and selected identities only; a local store path never crosses. */
export const machineEnrollmentSchema = z.strictObject({
  requestId: identity,
  publicKey: z.base64().length(44),
  machineLabel: z.string().trim().min(1).max(256),
  agents: z.array(selectedAgent).max(256),
});
export type MachineEnrollment = z.infer<typeof machineEnrollmentSchema>;

/** Trusted Local OAuth facts, never supplied in the public enrollment body. */
export const machineMemberSchema = z.strictObject({
  memberId: identity,
  clientId: identity,
  loginId: identity,
});
export type MachineMember = z.infer<typeof machineMemberSchema>;

/** Server-selected issuer facts; omitted fields match all of this member's devices. */
export const machineLoginSelectionSchema = z.strictObject({
  clientId: identity.optional(),
  loginId: identity.optional(),
});
export type MachineLoginSelection = z.infer<typeof machineLoginSelectionSchema>;

/**
 * Host-owned Agent identity reservation over the enrollment's own store. The
 * same receipt yields the same Team Agent; no hosted Agent is opened.
 */
export type MachineAgentReservation = (
  reservation: Readonly<{ memberId: string; requestId: string; name: string }>,
) => Readonly<{ agentId: string }>;

const ids = defineIdFamily({
  family: "machine-enrollment",
  version: 1,
  kinds: { device: { prefix: "machine" } },
});
const rowSchema = z.strictObject({
  device_id: identity,
  member_id: identity,
  client_id: identity,
  login_id: identity,
  input: z.string(),
});
const mappingSchema = z.strictObject({
  selection: z.number().int().min(0).max(255),
  agent_id: identity,
});
const limitsSchema = z.strictObject({
  machines: z.number().int().positive(),
  agentsPerMachine: z.number().int().positive().max(256),
});

/** Honest enrollment refusals; none denotes command acceptance. */
export class MachineEnrollmentRefused extends Error {
  constructor(
    readonly reason:
      "request_conflict" | "capacity" | "device_revoked" | "login_not_current",
  ) {
    super(reason);
    this.name = "MachineEnrollmentRefused";
  }
}

/**
 * Team-owned enrollment state over the ordinary Agent directory, not a second
 * hosted runtime. Its caller must supply the live, member-authorized identity.
 * Limits are captured host policy; this module does not invent a Team quota.
 */
export function createMachineEnrollment(options: {
  owner: WatchdogSqliteOwner;
  limits: z.infer<typeof limitsSchema>;
  authorizeMember: (memberId: string) => Promise<void>;
  authorizeLogin: (member: MachineMember) => Promise<boolean>;
  onAgentCreated: (agentId: string) => void;
  /** The host's Agent directory, opened over this enrollment's store. */
  agents: (sql: WatchdogSqliteOwner["sql"]) => MachineAgentReservation;
}) {
  const { owner } = options;
  const limits = limitsSchema.parse(options.limits);
  const reserveAgent = options.agents(owner.sql);
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS hub_machine_devices (
    device_id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    login_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    input TEXT NOT NULL,
    public_key TEXT NOT NULL UNIQUE,
    machine_label TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
    fence_epoch INTEGER NOT NULL DEFAULT 0
      CHECK(fence_epoch BETWEEN 0 AND 9007199254740991)
  ) STRICT`);
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS hub_machine_agents (
    device_id TEXT NOT NULL REFERENCES hub_machine_devices(device_id),
    selection INTEGER NOT NULL,
    agent_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(device_id, selection)
  ) STRICT`);

  const mappings = (deviceId: string) =>
    owner.sql
      .exec(
        "SELECT selection, agent_id FROM hub_machine_agents WHERE device_id = ? ORDER BY selection",
        deviceId,
      )
      .toArray()
      .map((row) => {
        const parsed = mappingSchema.parse(row);
        return { selection: parsed.selection, agentId: parsed.agent_id };
      });

  const enroll = async (rawMember: MachineMember, raw: MachineEnrollment) => {
    const member = machineMemberSchema.parse(rawMember);
    const { memberId } = member;
    const input = machineEnrollmentSchema.parse(raw);
    // Use the maintained Ed25519 decoder before storing an unusable pin.
    await importSeamVerifiers({ device: input.publicKey });
    await options.authorizeMember(memberId);
    const canonical = JSON.stringify(input);
    return owner.transactionSync(() => {
      const prior = owner.sql
        .exec(
          "SELECT device_id, member_id, client_id, login_id, input FROM hub_machine_devices WHERE request_id = ?",
          input.requestId,
        )
        .toArray()[0];
      if (prior !== undefined) {
        const row = rowSchema.parse(prior);
        if (
          row.member_id !== memberId ||
          row.client_id !== member.clientId ||
          row.login_id !== member.loginId ||
          row.input !== canonical
        )
          throw new MachineEnrollmentRefused("request_conflict");
        const revoked = z
          .object({ revoked: z.number() })
          .parse(
            owner.sql
              .exec(
                "SELECT revoked FROM hub_machine_devices WHERE device_id = ?",
                row.device_id,
              )
              .toArray()[0],
          ).revoked;
        if (revoked !== 0) throw new MachineEnrollmentRefused("device_revoked");
        return { deviceId: row.device_id, agents: mappings(row.device_id) };
      }
      // Bound retained identity/replay history, including revoked devices;
      // counting only active devices would leave that history unbounded.
      const count = z
        .object({ count: z.number().int().nonnegative() })
        .parse(
          owner.sql
            .exec("SELECT COUNT(*) AS count FROM hub_machine_devices")
            .toArray()[0],
        ).count;
      if (
        count >= limits.machines ||
        input.agents.length > limits.agentsPerMachine
      )
        throw new MachineEnrollmentRefused("capacity");
      if (
        owner.sql
          .exec(
            "SELECT 1 FROM hub_machine_devices WHERE public_key = ?",
            input.publicKey,
          )
          .toArray().length > 0
      )
        throw new MachineEnrollmentRefused("request_conflict");
      const deviceId = ids.device.generate();
      owner.sql.exec(
        "INSERT INTO hub_machine_devices(device_id, member_id, client_id, login_id, request_id, input, public_key, machine_label) VALUES(?,?,?,?,?,?,?,?)",
        deviceId,
        memberId,
        member.clientId,
        member.loginId,
        input.requestId,
        canonical,
        input.publicKey,
        input.machineLabel,
      );
      for (const [index, selected] of input.agents.entries()) {
        // A bounded server-owned receipt, stable across retries.
        const agent = reserveAgent({
          memberId,
          requestId: `${deviceId}:${String(index)}`,
          name: selected.name,
        });
        owner.sql.exec(
          "INSERT INTO hub_machine_agents(device_id, selection, agent_id) VALUES(?,?,?)",
          deviceId,
          index,
          agent.agentId,
        );
        options.onAgentCreated(agent.agentId);
      }
      return { deviceId, agents: mappings(deviceId) };
    });
  };
  const device = (deviceId: string) => {
    const row = owner.sql
      .exec(
        "SELECT device_id, member_id, client_id, login_id, public_key, machine_label, fence_epoch FROM hub_machine_devices WHERE device_id = ? AND revoked = 0",
        deviceId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const value = z
      .strictObject({
        device_id: identity,
        member_id: identity,
        client_id: identity,
        login_id: identity,
        public_key: z.string(),
        machine_label: z.string(),
        fence_epoch: z.int().nonnegative(),
      })
      .parse(row);
    return {
      deviceId: value.device_id,
      memberId: value.member_id,
      clientId: value.client_id,
      loginId: value.login_id,
      publicKey: value.public_key,
      machineLabel: value.machine_label,
      fenceEpoch: value.fence_epoch,
    };
  };
  const home = (agentId: string): MachineAgentHome | null => {
    const row = owner.sql
      .exec(
        `SELECT d.device_id FROM hub_machine_agents a
       JOIN hub_machine_devices d ON d.device_id = a.device_id WHERE a.agent_id = ?`,
        agentId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const value = z.strictObject({ device_id: identity }).parse(row);
    return { kind: "machine", deviceId: value.device_id };
  };
  const revoke = (memberId: string, deviceId: string) =>
    owner.transactionSync(() => {
      const current = device(deviceId);
      if (current?.memberId !== memberId) return false;
      owner.sql.exec(
        "UPDATE hub_machine_devices SET revoked = 1, fence_epoch = fence_epoch + 1 WHERE device_id = ?",
        deviceId,
      );
      return true;
    });
  const authorizeDevice = async (deviceId: string) => {
    const current = device(deviceId);
    if (current === null) throw new MachineEnrollmentRefused("device_revoked");
    await options.authorizeMember(current.memberId);
    if (
      !(await options.authorizeLogin({
        memberId: current.memberId,
        clientId: current.clientId,
        loginId: current.loginId,
      }))
    )
      throw new MachineEnrollmentRefused("login_not_current");
    // The primary login read yields to other RPCs. A concurrent per-device
    // revoke must win before this call lends the device to transport again.
    const authorized = device(deviceId);
    if (authorized === null)
      throw new MachineEnrollmentRefused("device_revoked");
    return authorized;
  };
  /** Retained rows include revoked devices: their replay owner still exists. */
  const retainedDevices = () =>
    owner.sql
      .exec(
        "SELECT device_id, member_id, client_id, login_id, revoked, fence_epoch FROM hub_machine_devices ORDER BY device_id",
      )
      .toArray()
      .map((raw) => {
        const row = z
          .strictObject({
            device_id: identity,
            member_id: identity,
            client_id: identity,
            login_id: identity,
            revoked: z.union([z.literal(0), z.literal(1)]),
            fence_epoch: z.int().nonnegative(),
          })
          .parse(raw);
        return {
          deviceId: row.device_id,
          memberId: row.member_id,
          clientId: row.client_id,
          loginId: row.login_id,
          revoked: row.revoked === 1,
          fenceEpoch: row.fence_epoch,
        };
      });
  /** Commit the authority fence before attempting any remote socket close. */
  const fenceDevice = (deviceId: string): number | null =>
    owner.transactionSync(() => {
      const row = owner.sql
        .exec(
          "UPDATE hub_machine_devices SET fence_epoch = fence_epoch + 1 WHERE device_id = ? RETURNING fence_epoch",
          deviceId,
        )
        .toArray()[0];
      return row === undefined
        ? null
        : z.strictObject({ fence_epoch: z.int().nonnegative() }).parse(row)
            .fence_epoch;
    });
  const fenceSelected = (devices: ReturnType<typeof retainedDevices>) =>
    devices.map(({ deviceId }) => {
      const fenceEpoch = fenceDevice(deviceId);
      if (fenceEpoch === null) throw new Error("Retained device disappeared");
      return { deviceId, fenceEpoch };
    });
  /** Logout/removal closes old sockets, but does not retire keys or replay. */
  const fenceLogins = (memberId: string, selection: MachineLoginSelection) =>
    owner.transactionSync(() =>
      fenceSelected(
        retainedDevices().filter(
          (device) =>
            device.memberId === memberId &&
            (selection.clientId === undefined ||
              device.clientId === selection.clientId) &&
            (selection.loginId === undefined ||
              device.loginId === selection.loginId),
        ),
      ),
    );
  const fenceMember = (memberId: string) => fenceLogins(memberId, {});
  /** Irreversible erasure acceptance, not suspension. Keep every roster row
   * until its link's replay and storage have been erased and read back.
   */
  const retireAllForErasure = () =>
    owner.transactionSync(() => {
      for (const device of retainedDevices()) {
        if (!device.revoked && !revoke(device.memberId, device.deviceId))
          throw new Error("Device retirement did not commit");
      }
      return retainedDevices().map(({ deviceId, fenceEpoch }) => ({
        deviceId,
        fenceEpoch,
      }));
    });
  /** Revocation is irreversible. Keep its UNIQUE public-key row, even after
   * the device's link replay is erased; a resumable fence is not retirement.
   */
  const keyRetired = (deviceId: string): boolean =>
    retainedDevices().some(
      (device) => device.deviceId === deviceId && device.revoked,
    );
  return {
    enroll,
    device,
    home,
    revoke,
    authorizeDevice,
    retainedDevices,
    fenceDevice,
    fenceMember,
    fenceLogins,
    retireAllForErasure,
    keyRetired,
  };
}
