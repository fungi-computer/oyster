import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import type {
  createMachineEnrollment,
  MachineLoginSelection,
} from "./enrollment.js";
import {
  machineLinkFenceResultSchema,
  type MachineLinkFenceResult,
  type MachineLinkFenceFact,
} from "./authority.js";

/** One host outbox family: the host's drain asks when it is due and runs it. */
export type MachineLinkFenceFamily = Readonly<{
  family: string;
  nextDue(): number | null;
  deliver(): Promise<void>;
}>;

const intentSchema = z.strictObject({
  device_id: z.string().min(1).max(256),
  fence_epoch: z.int().nonnegative(),
  failures: z.int().nonnegative(),
});
type Intent = z.infer<typeof intentSchema>;

/** Team-local durable push custody; device rows remain the authority. */
export function createMachineLinkFences(options: {
  owner: WatchdogSqliteOwner;
  enrollment: ReturnType<typeof createMachineEnrollment>;
  readFact: (deviceId: string) => Promise<MachineLinkFenceFact | null>;
  push: (fact: MachineLinkFenceFact) => Promise<MachineLinkFenceResult>;
  /** Own an immediate post-commit push/alarm. When staging inside an outer
   * transaction, the host must defer I/O until that transaction has committed.
   */
  wakeNow: () => void;
  retryDelayMs: (failures: number) => number;
  /** The host's failure log; a failed push still stays UNCONFIRMED and retries. */
  report: (operation: string, cause: unknown) => void;
}) {
  const { owner, enrollment } = options;
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS hub_machine_link_fences (
    device_id TEXT PRIMARY KEY,
    fence_epoch INTEGER NOT NULL CHECK(fence_epoch >= 0),
    failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
    next_attempt_at INTEGER NOT NULL
  ) STRICT`);
  // Only members with retained devices get a receipt: bounded by enrollment.
  // This records delivery versions, never admission or role authority.
  owner.sql.exec(`CREATE TABLE IF NOT EXISTS hub_machine_link_member_fences (
    member_id TEXT PRIMARY KEY,
    membership_version INTEGER NOT NULL CHECK(membership_version > 0)
  ) STRICT`);

  const stage = (deviceId: string, fenceEpoch: number) => {
    owner.sql.exec(
      `INSERT INTO hub_machine_link_fences
       (device_id,fence_epoch,failures,next_attempt_at) VALUES (?,?,0,?)
       ON CONFLICT(device_id) DO UPDATE SET fence_epoch=excluded.fence_epoch,
       failures=0,next_attempt_at=excluded.next_attempt_at`,
      deviceId,
      fenceEpoch,
      Date.now(),
    );
  };
  const attempt = async (intent: Intent): Promise<MachineLinkFenceResult> => {
    try {
      const fact = await options.readFact(intent.device_id);
      if (
        fact?.deviceId !== intent.device_id ||
        fact.fenceEpoch < intent.fence_epoch
      )
        throw new Error("Machine link fence fact is not current");
      const result = machineLinkFenceResultSchema.parse(
        await options.push(fact),
      );
      if (result.kind !== "confirmed" || result.fenceEpoch < intent.fence_epoch)
        throw new Error("Machine link did not confirm the committed fence");
      // An older in-flight ACK cannot clear a newer persisted intent.
      owner.sql.exec(
        "DELETE FROM hub_machine_link_fences WHERE device_id=? AND fence_epoch=?",
        intent.device_id,
        intent.fence_epoch,
      );
      return result;
    } catch (cause) {
      const failures = intent.failures + 1;
      owner.sql.exec(
        `UPDATE hub_machine_link_fences SET failures=?,next_attempt_at=?
         WHERE device_id=? AND fence_epoch=?`,
        failures,
        Date.now() + options.retryDelayMs(failures),
        intent.device_id,
        intent.fence_epoch,
      );
      options.report("machine-link.fence-push", cause);
      return { kind: "unconfirmed", fenceEpoch: intent.fence_epoch };
    }
  };
  const pending = (deviceId: string) => {
    const row = owner.sql
      .exec(
        "SELECT device_id,fence_epoch,failures FROM hub_machine_link_fences WHERE device_id=?",
        deviceId,
      )
      .toArray()[0];
    return row === undefined ? null : intentSchema.parse(row);
  };
  /** Called in the lifecycle transaction. Resume must not cancel these pushes:
   * an old socket still needs closing even after admission becomes live again.
   */
  const fenceAll = () => {
    owner.transactionSync(() => {
      for (const { deviceId } of enrollment.retainedDevices()) {
        const epoch = enrollment.fenceDevice(deviceId);
        if (epoch === null) throw new Error("Retained device disappeared");
        stage(deviceId, epoch);
      }
    });
    if (enrollment.retainedDevices().length > 0) options.wakeNow();
  };
  /** Called inside the member-removal transaction; old deliveries cannot fence
   * a member again after rejoin. The host owns the post-commit wake.
   */
  const fenceMember = (memberId: string, membershipVersion: number) => {
    const staged = owner.transactionSync(() => {
      const previous = owner.sql
        .exec(
          "SELECT membership_version FROM hub_machine_link_member_fences WHERE member_id=?",
          memberId,
        )
        .toArray()[0];
      if (
        previous !== undefined &&
        z
          .strictObject({ membership_version: z.int().positive() })
          .parse(previous).membership_version >= membershipVersion
      )
        return false;
      const devices = enrollment.fenceMember(memberId);
      if (devices.length === 0) return false;
      for (const { deviceId, fenceEpoch } of devices)
        stage(deviceId, fenceEpoch);
      owner.sql.exec(
        `INSERT INTO hub_machine_link_member_fences(member_id,membership_version) VALUES (?,?)
         ON CONFLICT(member_id) DO UPDATE SET membership_version=excluded.membership_version`,
        memberId,
        membershipVersion,
      );
      return true;
    });
    if (staged) options.wakeNow();
  };
  const fenceLogins = async (
    memberId: string,
    selection: MachineLoginSelection,
  ) => {
    const intents = owner.transactionSync(() =>
      enrollment
        .fenceLogins(memberId, selection)
        .map(({ deviceId, fenceEpoch }) => {
          stage(deviceId, fenceEpoch);
          const intent = pending(deviceId);
          if (intent === null) throw new Error("Login fence was not staged");
          return intent;
        }),
    );
    // The first attempts start inline after commit, not at the retry deadline.
    if (intents.length > 0) options.wakeNow();
    const receipts: MachineLinkFenceResult[] = [];
    for (let offset = 0; offset < intents.length; offset += 16)
      receipts.push(
        ...(await Promise.all(intents.slice(offset, offset + 16).map(attempt))),
      );
    return receipts;
  };
  const retireAllForErasure = () => {
    const devices = owner.transactionSync(() => {
      const retired = enrollment.retireAllForErasure();
      for (const { deviceId, fenceEpoch } of retired)
        stage(deviceId, fenceEpoch);
      return retired;
    });
    if (devices.length > 0) options.wakeNow();
  };
  const revoke = async (
    memberId: string,
    deviceId: string,
  ): Promise<MachineLinkFenceResult | null> => {
    const intent = owner.transactionSync(() => {
      const device = enrollment
        .retainedDevices()
        .find((row) => row.deviceId === deviceId && row.memberId === memberId);
      if (device === undefined) return null;
      if (!device.revoked && !enrollment.revoke(memberId, deviceId))
        throw new Error("Device retirement did not commit");
      const retired = enrollment
        .retainedDevices()
        .find((row) => row.deviceId === deviceId);
      if (retired === undefined) throw new Error("Retired device disappeared");
      stage(deviceId, retired.fenceEpoch);
      return pending(deviceId);
    });
    return intent === null ? null : await attempt(intent);
  };
  const family: MachineLinkFenceFamily = {
    family: "machine-link-fences",
    nextDue: () =>
      z
        .strictObject({ due: z.number().nullable() })
        .parse(
          owner.sql
            .exec(
              "SELECT MIN(next_attempt_at) AS due FROM hub_machine_link_fences",
            )
            .toArray()[0],
        ).due,
    deliver: async () => {
      const due = z.array(intentSchema).parse(
        owner.sql
          .exec(
            `SELECT device_id,fence_epoch,failures FROM hub_machine_link_fences
             WHERE next_attempt_at<=? ORDER BY next_attempt_at,device_id LIMIT 16`,
            Date.now(),
          )
          .toArray(),
      );
      await Promise.all(due.map(attempt));
    },
  };
  return {
    fenceAll,
    fenceMember,
    fenceLogins,
    retireAllForErasure,
    revoke,
    family,
  };
}
