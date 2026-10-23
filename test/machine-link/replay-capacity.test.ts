import { machineAgentReservations } from "@fungi.computer/shiitake/delegation";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  importSeamVerifiers,
  signSeamRequest,
  unsignedPayload,
  verifySeamRequest,
} from "@fungi.computer/seam";
import {
  machineLinkAudience,
  machineLinkDialUrl,
} from "@fungi.computer/seam/machine-link-protocol";
import {
  createLocalBackendReplayStore,
  maximumLocalDialReplayRecords,
} from "../../../computer/src/local-backend-replay.js";
import {
  createMachineEnrollment,
  MachineEnrollmentRefused,
} from "../../src/machine-link/enrollment.js";

// The Hub and standalone Oyster give every (Team, device) its own machine-link
// Durable Object, whose own SQLite storage holds that device's signed-dial
// replay records (link.ts hostFor -> MachineLinkHost(state, state.storage) ->
// createLocalBackendReplayStore(owner)). Each "link" below is that real
// per-device store on its own SQLite file, reopened physically.

async function deviceKey(deviceId: string) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new Error("Expected an Ed25519 key pair");
  const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("Expected raw key bytes");
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(raw)));
  return {
    deviceId,
    publicKey,
    signer: { keyId: deviceId, key: keys.privateKey },
  };
}
type Device = Awaited<ReturnType<typeof deviceKey>>;

async function link(work: string, teamId: string, device: Device) {
  const path = join(work, `${teamId}-${device.deviceId}.sqlite`);
  let database = new DatabaseSync(path);
  let replay = createLocalBackendReplayStore(fromNodeSqlite(database));
  const audience = machineLinkAudience(teamId, device.deviceId);
  const url = machineLinkDialUrl(
    "https://hub.test",
    teamId,
    device.deviceId,
  ).href;
  // The link pins only its own device's key.
  const verifiers = await importSeamVerifiers({
    [device.deviceId]: device.publicKey,
  });
  return {
    /** One fresh dial signed by `signer`, verified against this link. */
    async dial(signer: Device["signer"], now: number) {
      const header = await signSeamRequest(
        signer,
        audience,
        "GET",
        url,
        unsignedPayload,
        now,
      );
      return { header, result: await this.verify(header, now) };
    },
    async verify(header: string, now: number) {
      try {
        return await verifySeamRequest(
          verifiers,
          audience,
          "GET",
          url,
          header,
          null,
          replay,
          now,
        );
      } catch (cause) {
        // Seam's refusal reason, without its common message prefix.
        return cause instanceof Error
          ? cause.message.replace(/^Seam request rejected: /u, "")
          : "refused";
      }
    },
    count() {
      // The store creates its table on its first admission attempt; a link
      // that never reached admission has recorded nothing.
      const created = database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'computer_local_dial_replay'",
        )
        .get();
      if (created === undefined) return 0;
      return Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM computer_local_dial_replay")
          .get()?.count ?? 0,
      );
    },
    reopen() {
      database.close();
      database = new DatabaseSync(path);
      replay = createLocalBackendReplayStore(fromNodeSqlite(database));
    },
    close() {
      database.close();
    },
  };
}

await test("one device filling its own signed-dial replay store never touches another device's or another Team's", async () => {
  const work = await mkdtemp(join(tmpdir(), "machine-link-replay-"));
  const a = await deviceKey("device-a");
  const b = await deviceKey("device-b");
  const elsewhere = await deviceKey("device-c");
  const linkA = await link(work, "team", a);
  const linkB = await link(work, "team", b);
  const otherTeam = await link(work, "other-team", elsewhere);
  try {
    const now = Date.now();
    // Law 1: device A fills its own store with distinct valid dials.
    for (let index = 0; index < maximumLocalDialReplayRecords; index += 1)
      assert.equal((await linkA.dial(a.signer, now)).result, "device-a");
    assert.equal(linkA.count(), maximumLocalDialReplayRecords);
    assert.equal(
      (await linkA.dial(a.signer, now)).result,
      "replay capacity reached",
    );
    // A cannot spend B's capacity: B's link verifies against B's pinned key
    // before recording anything.
    assert.equal((await linkB.dial(a.signer, now)).result, "unknown key");
    assert.equal(linkB.count(), 0);
    const admittedB = await linkB.dial(b.signer, now);
    assert.equal(admittedB.result, "device-b");
    assert.equal(linkB.count(), 1);

    // Law 2: the same holds after a physical reopen of every store; A's live
    // records are neither evicted nor renewed, and replay stays refused.
    linkA.reopen();
    linkB.reopen();
    otherTeam.reopen();
    assert.equal(linkA.count(), maximumLocalDialReplayRecords);
    assert.equal(
      (await linkA.dial(a.signer, now + 1)).result,
      "replay capacity reached",
    );
    assert.equal(
      await linkB.verify(admittedB.header, now + 1),
      "replayed nonce",
    );
    assert.equal((await linkB.dial(b.signer, now + 1)).result, "device-b");
    assert.equal(linkB.count(), 2);

    // Law 3: another Team's device link is unaffected.
    assert.equal(otherTeam.count(), 0);
    assert.equal(
      (await otherTeam.dial(elsewhere.signer, now + 1)).result,
      "device-c",
    );
  } finally {
    linkA.close();
    linkB.close();
    otherTeam.close();
    await rm(work, { recursive: true, force: true });
  }
});

await test("the 256 retained-device ceiling counts revoked devices and still applies", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    // The Hub's Team composition supplies this private retention ceiling.
    const enrollment = createMachineEnrollment({
      agents: machineAgentReservations,
      owner: fromNodeSqlite(database),
      limits: { machines: 256, agentsPerMachine: 1 },
      authorizeMember: () => Promise.resolve(),
      authorizeLogin: () => Promise.resolve(true),
      onAgentCreated: () => undefined,
    });
    const member = { memberId: "member", clientId: "client", loginId: "login" };
    const enrollNext = async (index: number) =>
      enrollment.enroll(member, {
        requestId: `join-${String(index)}`,
        publicKey: (await deviceKey(`unused-${String(index)}`)).publicKey,
        machineLabel: "Laptop",
        agents: [],
      });
    for (let index = 0; index < 256; index += 1) {
      const joined = await enrollNext(index);
      // Repeated enroll-and-revoke still consumes retained history.
      assert.equal(enrollment.revoke("member", joined.deviceId), true);
    }
    assert.equal(enrollment.retainedDevices().length, 256);
    assert.ok(enrollment.retainedDevices().every(({ revoked }) => revoked));
    await assert.rejects(
      enrollNext(256),
      (cause: unknown) =>
        cause instanceof MachineEnrollmentRefused &&
        cause.reason === "capacity",
    );
  } finally {
    database.close();
  }
});
