import { machineAgentReservations } from "@fungi.computer/shiitake/delegation";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
// Implementation-level SQLite proof, not a public Computer package witness.
// The production Computer root also loads its Workers execution platform.
import { createLocalBackendReplayStore } from "../../../computer/src/local-backend-replay.js";
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
  createMachineEnrollment,
  createMachineLinkFences,
  type MachineLinkFenceResult,
  type MachineLinkFenceFact,
} from "../../src/machine-link/index.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

const member = {
  memberId: "member",
  clientId: "client",
  loginId: "login",
};
const keys = await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
]);
if (!("publicKey" in keys))
  throw new Error("Ed25519 did not return a key pair");
const exported = await crypto.subtle.exportKey("raw", keys.publicKey);
if (!(exported instanceof ArrayBuffer))
  throw new Error("Raw Ed25519 export did not return bytes");
const publicKey = btoa(String.fromCharCode(...new Uint8Array(exported)));
const joinInput = {
  requestId: "join",
  publicKey,
  machineLabel: "Local",
  agents: [],
};
const openEnrollment = (owner: WatchdogSqliteOwner) =>
  createMachineEnrollment({
    agents: machineAgentReservations,
    owner,
    limits: { machines: 256, agentsPerMachine: 256 },
    authorizeMember: () => Promise.resolve(),
    authorizeLogin: () => Promise.resolve(true),
    onAgentCreated: () => {
      throw new Error("This device selected no Agents");
    },
  });

const readFenceFact = (
  enrollment: ReturnType<typeof openEnrollment>,
  deviceId: string,
): Promise<MachineLinkFenceFact | null> => {
  const device = enrollment
    .retainedDevices()
    .find((row) => row.deviceId === deviceId);
  return Promise.resolve(
    device === undefined
      ? null
      : {
          teamId: "team",
          deviceId,
          live: false,
          fenceEpoch: device.fenceEpoch,
        },
  );
};

await test("member staging rolls back with removal and requests the first wake now, not at retry time", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = openEnrollment(owner);
    const device = await enrollment.enroll(member, joinInput);
    let wakeRequests = 0;
    let pushes = 0;
    const fences = createMachineLinkFences({
      owner,
      enrollment,
      retryDelayMs: () => 60_000,
      report: () => undefined,
      wakeNow: () => {
        wakeRequests += 1;
      },
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      push: (fact) => {
        pushes += 1;
        assert.equal(
          database.isTransaction,
          false,
          "push must not run inside removal's transaction",
        );
        assert.equal(fact.live, false);
        return Promise.resolve({
          kind: "confirmed",
          fenceEpoch: fact.fenceEpoch,
        });
      },
    });
    assert.throws(
      () =>
        owner.transactionSync(() => {
          fences.fenceMember(member.memberId, 1);
          throw new Error("removal rolled back");
        }),
      /removal rolled back/,
    );
    assert.equal(enrollment.device(device.deviceId)?.fenceEpoch, 0);
    assert.equal(fences.family.nextDue(), null);
    wakeRequests = 0;
    owner.transactionSync(() => {
      fences.fenceMember(member.memberId, 1);
      assert.equal(pushes, 0);
      assert.notEqual(fences.family.nextDue(), null);
    });
    assert.equal(
      wakeRequests,
      1,
      "the host must own an immediate wake before its normal retry schedule",
    );
    await fences.family.deliver();
    assert.equal(pushes, 1);
    assert.equal(fences.family.nextDue(), null);
    fences.fenceMember(member.memberId, 1);
    assert.equal(
      enrollment.device(device.deviceId)?.fenceEpoch,
      1,
      "removal replay cannot fence a rejoined member again",
    );
  } finally {
    database.close();
  }
});

await test("logout starts its first push after commit and retains a stale ACK for durable retry", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = openEnrollment(owner);
    const device = await enrollment.enroll(member, joinInput);
    let pushes = 0;
    let wakes = 0;
    const failures: string[] = [];
    const fences = createMachineLinkFences({
      owner,
      enrollment,
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      retryDelayMs: () => 0,
      wakeNow: () => {
        wakes += 1;
      },
      report: (operation) => {
        failures.push(operation);
      },
      push: (fact) => {
        pushes += 1;
        assert.equal(database.isTransaction, false);
        assert.deepEqual(fact, {
          teamId: "team",
          deviceId: device.deviceId,
          live: false,
          fenceEpoch: 1,
        });
        assert.equal(enrollment.device(device.deviceId)?.fenceEpoch, 1);
        assert.equal(enrollment.keyRetired(device.deviceId), false);
        return Promise.resolve({
          kind: "confirmed",
          fenceEpoch: pushes === 1 ? 0 : 1,
        });
      },
    });
    assert.deepEqual(await fences.fenceLogins("another-member", {}), []);
    assert.deepEqual(
      await fences.fenceLogins(member.memberId, {
        clientId: "another-client",
        loginId: member.loginId,
      }),
      [],
    );
    assert.equal(pushes, 0);
    assert.equal(wakes, 0);
    assert.deepEqual(
      await fences.fenceLogins(member.memberId, {
        clientId: member.clientId,
        loginId: member.loginId,
      }),
      [{ kind: "unconfirmed", fenceEpoch: 1 }],
    );
    assert.equal(
      pushes,
      1,
      "the first attempt must not wait for family.deliver",
    );
    assert.equal(wakes, 1);
    assert.deepEqual(failures, ["machine-link.fence-push"]);
    assert.notEqual(fences.family.nextDue(), null);
    await fences.family.deliver();
    assert.equal(pushes, 2);
    assert.equal(fences.family.nextDue(), null);
  } finally {
    database.close();
  }
});

await test("erasure commits retirement and its retained-device fence intent together", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = openEnrollment(owner);
    const device = await enrollment.enroll(member, joinInput);
    let wakes = 0;
    const fences = createMachineLinkFences({
      owner,
      enrollment,
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      retryDelayMs: () => 0,
      wakeNow: () => {
        wakes += 1;
      },
      report: () => undefined,
      push: (fact) => {
        assert.equal(enrollment.keyRetired(device.deviceId), true);
        assert.equal(enrollment.retainedDevices().length, 1);
        return Promise.resolve({
          kind: "confirmed",
          fenceEpoch: fact.fenceEpoch,
        });
      },
    });
    assert.throws(
      () =>
        owner.transactionSync(() => {
          fences.retireAllForErasure();
          throw new Error("erasure acceptance rolled back");
        }),
      /erasure acceptance rolled back/,
    );
    assert.equal(enrollment.keyRetired(device.deviceId), false);
    assert.equal(fences.family.nextDue(), null);
    wakes = 0;
    fences.retireAllForErasure();
    assert.equal(enrollment.keyRetired(device.deviceId), true);
    assert.equal(wakes, 1);
    assert.notEqual(fences.family.nextDue(), null);
    await fences.family.deliver();
    assert.equal(fences.family.nextDue(), null);
    assert.equal(enrollment.retainedDevices().length, 1);
  } finally {
    database.close();
  }
});

await test("retirement commits before push; UNCONFIRMED custody survives physical reopen", async () => {
  const work = await mkdtemp(join(tmpdir(), "machine-fence-push-"));
  let database = new DatabaseSync(join(work, "team.sqlite"));
  try {
    let owner = fromNodeSqlite(database);
    let enrollment = openEnrollment(owner);
    const device = await enrollment.enroll(member, joinInput);
    let pushes = 0;
    let fences = createMachineLinkFences({
      owner,
      enrollment,
      retryDelayMs: () => 1_000,
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      wakeNow: () => undefined,
      report: () => undefined,
      push: () => {
        pushes += 1;
        assert.equal(enrollment.device(device.deviceId), null);
        assert.deepEqual(enrollment.retainedDevices(), [
          {
            deviceId: device.deviceId,
            ...member,
            revoked: true,
            fenceEpoch: 1,
          },
        ]);
        return Promise.reject(new Error("Receiving link unavailable"));
      },
    });
    assert.equal(await fences.revoke("another-member", device.deviceId), null);
    assert.equal(await fences.revoke(member.memberId, "unknown-device"), null);
    assert.equal(
      pushes,
      0,
      "unknown/unowned devices never create a link owner",
    );
    assert.deepEqual(await fences.revoke(member.memberId, device.deviceId), {
      kind: "unconfirmed",
      fenceEpoch: 1,
    });
    assert.notEqual(fences.family.nextDue(), null);
    database.close();
    database = new DatabaseSync(join(work, "team.sqlite"));
    owner = fromNodeSqlite(database);
    enrollment = openEnrollment(owner);
    fences = createMachineLinkFences({
      owner,
      enrollment,
      retryDelayMs: () => 1_000,
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      wakeNow: () => undefined,
      report: () => undefined,
      push: (fact) => {
        assert.equal(fact.deviceId, device.deviceId);
        assert.equal(enrollment.retainedDevices()[0]?.revoked, true);
        return Promise.resolve({ kind: "confirmed", fenceEpoch: 1 });
      },
    });
    const due = fences.family.nextDue();
    assert.notEqual(due, null);
    assert.ok(due !== null);
    await delay(Math.max(0, due - Date.now()));
    await fences.family.deliver();
    assert.equal(fences.family.nextDue(), null);
    await assert.rejects(
      enrollment.enroll(member, {
        ...joinInput,
        requestId: "reuse-retired-key",
      }),
      { reason: "request_conflict" },
    );
  } finally {
    database.close();
    await rm(work, { recursive: true, force: true });
  }
});

await test("an old push ACK cannot discard a newer fence staged during its RPC", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = openEnrollment(owner);
    const device = await enrollment.enroll(member, joinInput);
    let complete: ((result: MachineLinkFenceResult) => void) | undefined;
    const old = new Promise<MachineLinkFenceResult>((resolve) => {
      complete = resolve;
    });
    let first = true;
    const fences = createMachineLinkFences({
      owner,
      enrollment,
      retryDelayMs: () => 1_000,
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      wakeNow: () => undefined,
      report: () => undefined,
      push: () => {
        if (first) {
          first = false;
          return old;
        }
        return Promise.resolve({ kind: "confirmed", fenceEpoch: 2 });
      },
    });
    const retiring = fences.revoke(member.memberId, device.deviceId);
    fences.fenceAll();
    assert.ok(complete);
    complete({ kind: "confirmed", fenceEpoch: 1 });
    assert.deepEqual(await retiring, { kind: "confirmed", fenceEpoch: 1 });
    assert.equal(enrollment.retainedDevices()[0]?.fenceEpoch, 2);
    assert.notEqual(fences.family.nextDue(), null);
    await fences.family.deliver();
    assert.equal(fences.family.nextDue(), null);
  } finally {
    database.close();
  }
});

await test("a resumable fence retains signed-dial replay across receiver storage reopen", async () => {
  const work = await mkdtemp(join(tmpdir(), "machine-suspension-replay-"));
  const database = new DatabaseSync(join(work, "team.sqlite"));
  let receiver = new DatabaseSync(join(work, "link.sqlite"));
  try {
    const owner = fromNodeSqlite(database);
    const enrollment = openEnrollment(owner);
    const device = await enrollment.enroll(member, joinInput);
    const fences = createMachineLinkFences({
      owner,
      enrollment,
      retryDelayMs: () => 1_000,
      readFact: (deviceId) => readFenceFact(enrollment, deviceId),
      wakeNow: () => undefined,
      report: () => undefined,
      push: () => {
        const retained = enrollment.retainedDevices()[0];
        assert.ok(retained);
        return Promise.resolve({
          kind: "confirmed",
          fenceEpoch: retained.fenceEpoch,
        });
      },
    });
    const audience = machineLinkAudience("team", device.deviceId);
    const url = machineLinkDialUrl(
      "https://hub.test",
      "team",
      device.deviceId,
    ).href;
    const now = Date.now();
    const signer = { keyId: device.deviceId, key: keys.privateKey };
    const header = await signSeamRequest(
      signer,
      audience,
      "GET",
      url,
      unsignedPayload,
      now,
    );
    const verifiers = await importSeamVerifiers({
      [device.deviceId]: publicKey,
    });
    let replay = createLocalBackendReplayStore(fromNodeSqlite(receiver));
    assert.equal(
      await verifySeamRequest(
        verifiers,
        audience,
        "GET",
        url,
        header,
        null,
        replay,
        now,
      ),
      device.deviceId,
    );
    fences.fenceAll();
    await fences.family.deliver();
    assert.equal(
      (await enrollment.authorizeDevice(device.deviceId)).fenceEpoch,
      1,
    );
    assert.equal(enrollment.retainedDevices()[0]?.revoked, false);
    receiver.close();
    receiver = new DatabaseSync(join(work, "link.sqlite"));
    replay = createLocalBackendReplayStore(fromNodeSqlite(receiver));
    await assert.rejects(
      verifySeamRequest(
        verifiers,
        audience,
        "GET",
        url,
        header,
        null,
        replay,
        now + 1,
      ),
      /replayed nonce/,
    );
    const fresh = await signSeamRequest(
      signer,
      audience,
      "GET",
      url,
      unsignedPayload,
      now + 2,
    );
    assert.equal(
      await verifySeamRequest(
        verifiers,
        audience,
        "GET",
        url,
        fresh,
        null,
        replay,
        now + 2,
      ),
      device.deviceId,
    );
  } finally {
    receiver.close();
    database.close();
    await rm(work, { recursive: true, force: true });
  }
});
