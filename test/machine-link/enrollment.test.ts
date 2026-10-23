import { machineAgentReservations } from "@fungi.computer/shiitake/delegation";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createAgentDirectory,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import { importSeamVerifiers } from "@fungi.computer/seam";
import {
  createMachineEnrollment,
  type MachineMember,
} from "../../src/machine-link/enrollment.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

const pair = await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
]);
if (!("publicKey" in pair))
  throw new Error("Ed25519 did not generate a key pair");
const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
if (!(exported instanceof ArrayBuffer))
  throw new Error("Raw Ed25519 export did not return bytes");
const rawKey = new Uint8Array(exported);
const publicKey = btoa(String.fromCharCode(...rawKey));
const grant: AgentGrant = {
  agents: "all",
  actions: ["read"],
  expiresAt: Number.MAX_SAFE_INTEGER,
  provenance: { actor: "member" },
};
const selected = { name: "Laptop Agent" };
const input = {
  requestId: "join-once",
  publicKey,
  machineLabel: "My laptop",
  agents: [selected],
};
const limits = { machines: 2, agentsPerMachine: 4 };
const member = {
  memberId: "member",
  clientId: "local-client",
  loginId: "live-login",
};
const announced: string[] = [];
const open = (
  owner: WatchdogSqliteOwner,
  policy = limits,
  authorizeLogin: (member: MachineMember) => Promise<boolean> = () =>
    Promise.resolve(true),
) =>
  createMachineEnrollment({
    agents: machineAgentReservations,
    owner,
    limits: policy,
    authorizeLogin,
    authorizeMember: (memberId) => {
      if (memberId !== "member" && memberId !== "other-member")
        return Promise.reject(new Error("not_member"));
      return Promise.resolve();
    },
    onAgentCreated: (agentId) => {
      announced.push(agentId);
    },
  });

await test("login fencing selects only the member's matching retained devices without retirement", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const enrollment = open(fromNodeSqlite(database), {
      machines: 8,
      agentsPerMachine: 4,
    });
    const enroll = async (principal: MachineMember, requestId: string) => {
      const keys = await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ]);
      assert.ok("publicKey" in keys);
      const bytes = await crypto.subtle.exportKey("raw", keys.publicKey);
      assert.ok(bytes instanceof ArrayBuffer);
      return enrollment.enroll(principal, {
        ...input,
        requestId,
        agents: [{ name: requestId }],
        publicKey: btoa(String.fromCharCode(...new Uint8Array(bytes))),
      });
    };
    const first = await enroll(member, "first");
    const second = await enroll(
      { ...member, loginId: "other-login" },
      "second",
    );
    const outsider = await enroll(
      { ...member, memberId: "other-member" },
      "outsider",
    );
    assert.deepEqual(
      enrollment.fenceLogins(member.memberId, { loginId: member.loginId }),
      [{ deviceId: first.deviceId, fenceEpoch: 1 }],
    );
    assert.equal(enrollment.device(first.deviceId)?.fenceEpoch, 1);
    assert.equal(enrollment.device(second.deviceId)?.fenceEpoch, 0);
    assert.equal(enrollment.device(outsider.deviceId)?.fenceEpoch, 0);
    assert.deepEqual(
      enrollment.fenceLogins(member.memberId, { clientId: "missing" }),
      [],
    );
    assert.deepEqual(
      enrollment
        .fenceMember(member.memberId)
        .map(({ deviceId }) => deviceId)
        .sort(),
      [first.deviceId, second.deviceId].sort(),
    );
    assert.ok(enrollment.retainedDevices().every(({ revoked }) => !revoked));
  } finally {
    database.close();
  }
});

await test("erasure retires every live device, retains its roster, and is idempotent", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = open(owner);
    const joined = await enrollment.enroll(member, input);
    assert.deepEqual(enrollment.retireAllForErasure(), [
      { deviceId: joined.deviceId, fenceEpoch: 1 },
    ]);
    assert.equal(enrollment.device(joined.deviceId), null);
    assert.equal(enrollment.keyRetired(joined.deviceId), true);
    assert.equal(enrollment.retainedDevices().length, 1);
    assert.deepEqual(enrollment.retireAllForErasure(), [
      { deviceId: joined.deviceId, fenceEpoch: 1 },
    ]);
    await assert.rejects(enrollment.authorizeDevice(joined.deviceId), {
      reason: "device_revoked",
    });
  } finally {
    database.close();
  }
});

await test("selected Local Agent becomes one ordinary Team identity, stable over physical reopen", async () => {
  const work = await mkdtemp(join(tmpdir(), "mesh-enroll-"));
  let database = new DatabaseSync(join(work, "team.sqlite"));
  try {
    let owner = fromNodeSqlite(database);
    let enrollment = open(owner);
    const first = await enrollment.enroll(member, input);
    assert.equal(first.agents.length, 1);
    const mapping = first.agents[0];
    assert.ok(mapping);
    assert.ok(announced.includes(mapping.agentId));
    assert.equal(mapping.selection, 0);
    assert.deepEqual(
      createAgentDirectory(owner.sql)
        .list(grant)
        .map(({ agentId }) => agentId),
      [mapping.agentId],
    );
    assert.deepEqual(enrollment.home(mapping.agentId), {
      kind: "machine",
      deviceId: first.deviceId,
    });
    assert.equal(enrollment.home("unjoined"), null);
    await importSeamVerifiers({ [first.deviceId]: publicKey });
    database.close();
    database = new DatabaseSync(join(work, "team.sqlite"));
    owner = fromNodeSqlite(database);
    enrollment = open(owner);
    assert.deepEqual(await enrollment.enroll(member, input), first);
    await assert.rejects(
      enrollment.enroll({ ...member, memberId: "other-member" }, input),
      { reason: "request_conflict" },
    );
    await assert.rejects(
      enrollment.enroll({ ...member, memberId: "outsider" }, input),
      { message: "not_member" },
    );
    await assert.rejects(
      enrollment.enroll({ ...member, loginId: "another-login" }, input),
      { reason: "request_conflict" },
    );
    await assert.rejects(
      enrollment.enroll(member, { ...input, machineLabel: "Changed intent" }),
      { reason: "request_conflict" },
    );
    assert.equal(enrollment.revoke("other-member", first.deviceId), false);
    assert.equal(enrollment.revoke("member", first.deviceId), true);
    assert.equal(enrollment.device(first.deviceId), null);
    await assert.rejects(enrollment.enroll(member, input), {
      reason: "device_revoked",
    });
  } finally {
    database.close();
    await rm(work, { recursive: true, force: true });
  }
});

await test("no default enrollment, no duplicate selectors or local path fields, and host policy bounds admission", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = open(owner, { machines: 1, agentsPerMachine: 1 });
    await assert.rejects(
      enrollment.enroll(member, { ...input, agents: [selected, selected] }),
    );
    const withPrivatePath = {
      ...input,
      databasePath: "/home/member/private.sqlite",
    };
    await assert.rejects(enrollment.enroll(member, withPrivatePath));
    const empty = await enrollment.enroll(member, { ...input, agents: [] });
    assert.deepEqual(empty.agents, []);
    assert.deepEqual(createAgentDirectory(owner.sql).list(grant), []);
    await assert.rejects(
      enrollment.enroll(member, { ...input, requestId: "second-machine" }),
      { reason: "capacity" },
    );
  } finally {
    database.close();
  }
});

await test("an ordinary-directory refusal rolls back device and all Agent reservations together", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const enrollment = open(fromNodeSqlite(database));
    await assert.rejects(
      enrollment.enroll(member, {
        ...input,
        agents: [{ name: "Same" }, { name: "Same" }],
      }),
      { code: "name_taken" },
    );
    // This changes the failed intent with the same request id: it can succeed
    // only if the entire failed transaction left no receipt or device behind.
    const admitted = await enrollment.enroll(member, input);
    assert.equal(admitted.agents.length, 1);
  } finally {
    database.close();
  }
});

await test("a device's stored member/client/login are reauthorized, not just its membership", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const seen: MachineMember[] = [];
    let current = true;
    const authorizeLogin = (identity: MachineMember) => {
      seen.push(identity);
      return Promise.resolve(current);
    };
    let enrollment = open(owner, limits, authorizeLogin);
    const joined = await enrollment.enroll(member, input);
    await enrollment.authorizeDevice(joined.deviceId);
    assert.deepEqual(seen, [member]);
    current = false;
    await assert.rejects(enrollment.authorizeDevice(joined.deviceId), {
      reason: "login_not_current",
    });
    enrollment = open(owner, limits, authorizeLogin);
    await assert.rejects(enrollment.authorizeDevice(joined.deviceId), {
      reason: "login_not_current",
    });
    // A temporarily non-current client/consent/Terms decision denies work,
    // but must not silently become permanent per-device revocation.
    assert.notEqual(enrollment.device(joined.deviceId), null);
    current = true;
    await enrollment.authorizeDevice(joined.deviceId);
    enrollment.revoke(member.memberId, joined.deviceId);
    await assert.rejects(enrollment.authorizeDevice(joined.deviceId), {
      reason: "device_revoked",
    });
  } finally {
    database.close();
  }
});

await test("device revocation wins while the primary login read is in flight", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    let enterRead: (() => void) | undefined;
    let releaseLogin: ((current: boolean) => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    const login = new Promise<boolean>((resolve) => {
      releaseLogin = resolve;
    });
    const enrollment = open(fromNodeSqlite(database), limits, () => {
      assert.ok(enterRead);
      enterRead();
      return login;
    });
    const joined = await enrollment.enroll(member, input);
    const authorizing = enrollment.authorizeDevice(joined.deviceId);
    await entered;
    assert.equal(enrollment.revoke(member.memberId, joined.deviceId), true);
    assert.ok(releaseLogin);
    releaseLogin(true);
    await assert.rejects(authorizing, { reason: "device_revoked" });
  } finally {
    database.close();
  }
});

await test("device fence epochs survive physical reopen and do not advance a sibling device", async () => {
  const work = await mkdtemp(join(tmpdir(), "mesh-device-fence-"));
  let database = new DatabaseSync(join(work, "team.sqlite"));
  try {
    let enrollment = open(fromNodeSqlite(database));
    const first = await enrollment.enroll(member, input);
    const siblingKeys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    if (!("publicKey" in siblingKeys))
      throw new Error("Ed25519 did not generate a key pair");
    const siblingExport = await crypto.subtle.exportKey(
      "raw",
      siblingKeys.publicKey,
    );
    if (!(siblingExport instanceof ArrayBuffer))
      throw new Error("Raw Ed25519 export did not return bytes");
    const siblingKey = new Uint8Array(siblingExport);
    const second = await enrollment.enroll(member, {
      ...input,
      requestId: "sibling-device",
      publicKey: btoa(String.fromCharCode(...siblingKey)),
      agents: [],
    });
    assert.equal(
      (await enrollment.authorizeDevice(first.deviceId)).fenceEpoch,
      0,
    );
    assert.equal(enrollment.fenceDevice("unknown-device"), null);
    assert.equal(enrollment.keyRetired("unknown-device"), false);
    assert.equal(enrollment.keyRetired(first.deviceId), false);
    assert.equal(enrollment.fenceDevice(first.deviceId), 1);
    assert.equal(
      enrollment.keyRetired(first.deviceId),
      false,
      "a resumable suspension fence cannot authorize replay erasure",
    );
    assert.equal(
      (await enrollment.authorizeDevice(second.deviceId)).fenceEpoch,
      0,
    );
    database.close();
    database = new DatabaseSync(join(work, "team.sqlite"));
    enrollment = open(fromNodeSqlite(database));
    assert.equal(
      (await enrollment.authorizeDevice(first.deviceId)).fenceEpoch,
      1,
    );
    assert.equal(enrollment.fenceDevice(first.deviceId), 2);
    assert.equal(enrollment.revoke(member.memberId, first.deviceId), true);
    assert.equal(enrollment.keyRetired(first.deviceId), true);
    assert.equal(enrollment.keyRetired(second.deviceId), false);
    assert.equal(enrollment.device(first.deviceId), null);
    const retained = enrollment.retainedDevices();
    assert.equal(retained.length, 2);
    assert.deepEqual(
      retained.find(({ deviceId }) => deviceId === first.deviceId),
      { deviceId: first.deviceId, ...member, revoked: true, fenceEpoch: 3 },
    );
    assert.equal(
      (await enrollment.authorizeDevice(second.deviceId)).fenceEpoch,
      0,
    );
    database.close();
    database = new DatabaseSync(join(work, "team.sqlite"));
    enrollment = open(fromNodeSqlite(database));
    assert.equal(enrollment.keyRetired(first.deviceId), true);
    assert.equal(enrollment.keyRetired(second.deviceId), false);
  } finally {
    database.close();
    await rm(work, { recursive: true, force: true });
  }
});

await test("a revoked device public key remains UNIQUE across physical SQLite reopen", async () => {
  const work = await mkdtemp(join(tmpdir(), "mesh-retired-key-"));
  let database = new DatabaseSync(join(work, "team.sqlite"));
  try {
    let owner = fromNodeSqlite(database);
    let enrollment = open(owner);
    const joined = await enrollment.enroll(member, input);
    assert.equal(enrollment.revoke(member.memberId, joined.deviceId), true);
    database.close();
    database = new DatabaseSync(join(work, "team.sqlite"));
    owner = fromNodeSqlite(database);
    enrollment = open(owner);
    assert.equal(enrollment.keyRetired(joined.deviceId), true);
    await assert.rejects(
      enrollment.enroll(member, { ...input, requestId: "reuse-revoked-key" }),
      { reason: "request_conflict" },
    );
    assert.throws(
      () =>
        owner.sql.exec(
          `INSERT INTO hub_machine_devices(
            device_id, member_id, client_id, login_id, request_id, input,
            public_key, machine_label
          ) SELECT ?, member_id, client_id, login_id, ?, input,
            public_key, machine_label FROM hub_machine_devices WHERE device_id = ?`,
          "duplicate-public-key",
          "duplicate-key-intent",
          joined.deviceId,
        ),
      /UNIQUE constraint failed: hub_machine_devices.public_key/,
    );
  } finally {
    database.close();
    await rm(work, { recursive: true, force: true });
  }
});
