import { DatabaseSync } from "node:sqlite";
import { Base64 } from "effect/encoding";
import { assert, expect, it } from "vitest";
import { z } from "zod";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createKeyStore } from "@fungi.computer/ear-tag/keys";
import { fromNodeSqlite as keySql } from "@fungi.computer/ear-tag/keys/node";
import {
  createAgentDirectory,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import {
  createMachineLinkFences,
  MachineEnrollmentRefused,
  MachineLinkRefused,
  type MachineLinkFenceFact,
  type MachineLinkCaller,
  type MachineEnrollment,
} from "../../src/machine-link/index.js";
import {
  oysterKeyVocabulary,
  type OysterKeyCapability,
  type LiveOysterKey,
} from "../../src/keys.js";
import {
  createStandaloneMachineEnrollment,
  standaloneMachineJoinRoutes,
  standaloneMachineAgentHome,
  type StandaloneMachineJoinResult,
} from "../../src/standalone/machine-link.js";
import { defaultTenant, tenantScope } from "../../src/tenant.js";

async function input(requestId: string) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("publicKey" in pair)) throw new Error("Ed25519 key pair required");
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("Raw key required");
  return {
    requestId,
    publicKey: Base64.encode(new Uint8Array(raw)),
    machineLabel: requestId,
    agents: [{ name: `${requestId} Agent` }],
  };
}

const grant: AgentGrant = {
  agents: "all",
  actions: ["create", "read"],
  expiresAt: Number.MAX_SAFE_INTEGER,
  provenance: { actor: "owner" },
};

type OwnerAuthority = {
  memberId: string | null;
  failCreation: boolean;
};

function fixture() {
  const database = new DatabaseSync(":memory:");
  const credentials = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const keyOwner = fromNodeSqlite(credentials);
  const clock = { now: Date.now() };
  const keys = createKeyStore({
    sql: keySql(credentials),
    commit: (body) => Promise.resolve(keyOwner.transactionSync(body)),
    vocabulary: oysterKeyVocabulary,
    prefix: "oyk",
    now: () => clock.now,
    authorizeIssuer: () => Promise.resolve({ kind: "unrestricted" }),
  });
  const authority: OwnerAuthority = {
    memberId: "owner",
    failCreation: false,
  };
  const liveKey = async (keyId: string): Promise<LiveOysterKey | null> => {
    const result = await keys.live({ keyId });
    return result.kind !== "ok"
      ? null
      : {
          keyId: result.value.keyId,
          owner: result.value.owner,
          grantVersion: result.value.grantVersion,
          grants: result.value.scope.grants,
        };
  };
  const enrollment = createStandaloneMachineEnrollment({
    owner,
    scopeId: "agents",
    ownerId: () => Promise.resolve(authority.memberId),
    liveKey,
    onAgentCreated: () => {
      if (authority.failCreation)
        throw new Error("directory projection failed");
    },
  });
  const calls = { directoryEnrollments: 0 };
  const http = standaloneMachineJoinRoutes({
    scope: tenantScope(defaultTenant, "https://oyster.test"),
    ownerId: () => Promise.resolve(authority.memberId),
    keys: () => ({ verify: keys.verify, live: liveKey }),
    // The directory RPC's typed outcome over the real SQLite enrollment owner.
    // This module fixture does not claim a native Durable Object RPC proof.
    enroll: async (keyId, value): Promise<StandaloneMachineJoinResult> => {
      calls.directoryEnrollments += 1;
      try {
        return {
          kind: "enrolled",
          value: await enrollment.enrollWithKey(keyId, value),
        };
      } catch (cause) {
        if (cause instanceof MachineEnrollmentRefused)
          return {
            kind: "refused",
            error:
              cause.reason === "request_conflict" || cause.reason === "capacity"
                ? cause.reason
                : "not_allowed",
          };
        if (cause instanceof MachineLinkRefused)
          return { kind: "refused", error: "not_allowed" };
        if (cause instanceof DOMException && cause.name === "DataError")
          return { kind: "refused", error: "invalid_enrollment" };
        throw cause;
      }
    },
  });
  return {
    owner,
    keys,
    authority,
    enrollment,
    calls,
    clock,
    http,
    credentials,
    async join(
      secret: string | null,
      requestId: string,
      value?: MachineEnrollment,
    ) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (secret !== null) headers.set("Authorization", `Bearer ${secret}`);
      return http.fetch(
        new Request("https://oyster.test/local/mesh/join", {
          method: "POST",
          headers,
          body: JSON.stringify(value ?? (await input(requestId))),
        }),
      );
    },
    directory: createAgentDirectory(owner.sql),
    async issue(
      keyId = "enroll",
      capability: OysterKeyCapability = "machine.enroll",
    ) {
      const issued = await keys.issue("owner", {
        name: keyId,
        keyId,
        grants: [{ capability, targets: { kind: "all" } }],
      });
      if (issued.kind !== "ok") throw new Error("Fixture key issue failed");
      return issued.value;
    },
    close() {
      database.close();
      credentials.close();
    },
  };
}

it("a direct HTTP bearer request buys one enrollment without specifying a key TTL", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    expect(key.key.startsWith("oyk_")).toBe(true);
    const first = await f.join(key.key, "direct");
    expect(first.status).toBe(200);
    const [device] = f.enrollment.retainedDevices();
    const [agent] = f.directory.list(grant);
    assert.isDefined(device);
    assert.isDefined(agent);
    expect(await first.json()).toEqual({
      kind: "joined",
      scopeId: "agents",
      deviceId: device.deviceId,
      agents: [{ agentId: agent.agentId, selection: 0 }],
    });
    expect((await f.join(key.key, "second-direct")).status).toBe(403);
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
    expect(f.directory.list(grant)).toHaveLength(1);
    expect((await f.keys.verify(key.key)).kind).toBe("ok");
  } finally {
    f.close();
  }
});

it("lost ACK and concurrent identical HTTP retries return the original receipt once", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const value = await input("lost-ack");
    const responses = await Promise.all([
      f.join(key.key, value.requestId, value),
      f.join(key.key, value.requestId, value),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const original: unknown = await responses[0].json();
    expect(await responses[1].json()).toEqual(original);
    expect(
      await (await f.join(key.key, value.requestId, value)).json(),
    ).toEqual(original);
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
    expect(f.directory.list(grant)).toHaveLength(1);
    expect(
      f.owner.sql
        .exec("SELECT * FROM standalone_machine_enroll_keys")
        .toArray(),
    ).toEqual([{ key_id: key.record.keyId, request_id: value.requestId }]);
    expect(
      f.owner.sql
        .exec("PRAGMA table_info(standalone_machine_enroll_keys)")
        .toArray(),
    ).toContainEqual(expect.objectContaining({ name: "key_id", pk: 1 }));
  } finally {
    f.close();
  }
});

it("same request with changed body conflicts without another enrollment or key spend", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const value = await input("conflicting-retry");
    expect((await f.join(key.key, value.requestId, value)).status).toBe(200);
    const response = await f.join(key.key, value.requestId, {
      ...value,
      machineLabel: "Changed",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "request_conflict" });
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
    expect(f.directory.list(grant)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("expiry and mixed grants cannot authorize enrollment", async () => {
  const f = fixture();
  try {
    for (const [keyId, grants, expiresAt] of [
      [
        "expires",
        [{ capability: "machine.enroll", targets: { kind: "all" } }],
        f.clock.now + 1000,
      ],
      [
        "mixed",
        [
          { capability: "machine.enroll", targets: { kind: "all" } },
          { capability: "computer.use", targets: { kind: "all" } },
        ],
        undefined,
      ],
    ] as const) {
      const issued = await f.keys.issue("owner", {
        name: keyId,
        keyId,
        grants,
        expiresAt,
      });
      if (issued.kind !== "ok") throw new Error("Fixture key issue failed");
      f.clock.now += 1001;
      expect((await f.join(issued.value.key, keyId)).status).toBe(
        keyId === "expires" ? 401 : 403,
      );
      await expect(
        f.enrollment.enrollWithKey(keyId, await input(keyId)),
      ).rejects.toBeInstanceOf(MachineLinkRefused);
    }
    expect(f.calls.directoryEnrollments).toBe(0);
    expect(f.enrollment.retainedDevices()).toHaveLength(0);
    expect(f.directory.list(grant)).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("the retained member is the key owner and a replaced owner cannot enroll or replay", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const value = await input("owner-binding");
    expect((await f.join(key.key, value.requestId, value)).status).toBe(200);
    expect(f.enrollment.retainedDevices()).toEqual([
      expect.objectContaining({ memberId: "owner", loginId: key.record.keyId }),
    ]);
    f.authority.memberId = "replacement-owner";
    expect((await f.join(key.key, value.requestId, value)).status).toBe(403);
    await expect(
      f.enrollment.enrollWithKey(key.record.keyId, value),
    ).rejects.toBeInstanceOf(MachineLinkRefused);
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("the maintained Ed25519 import rejects an unusable pin and unique pins roll back the spend", async () => {
  const f = fixture();
  try {
    const first = await f.issue("first-pin");
    const second = await f.issue("second-pin");
    const value = await input("unique-pin");
    const invalid = {
      ...value,
      publicKey: Base64.encode(new Uint8Array(31)),
    };
    const invalidResponse = await f.join(first.key, value.requestId, invalid);
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      error: "invalid_enrollment",
    });
    expect(f.enrollment.retainedDevices()).toHaveLength(0);
    expect(
      f.owner.sql
        .exec("SELECT * FROM standalone_machine_enroll_keys")
        .toArray(),
    ).toHaveLength(0);
    expect((await f.join(first.key, value.requestId, value)).status).toBe(200);
    const conflict = await f.join(second.key, "same-pin", {
      ...value,
      requestId: "same-pin",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_conflict" });
    expect((await f.join(second.key, "fresh-pin")).status).toBe(200);
    expect(f.enrollment.retainedDevices()).toHaveLength(2);
  } finally {
    f.close();
  }
});

it("the endpoint bounds the body and refuses unknown credentials without enrollment detail", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const response = await f.http.fetch(
      new Request("https://oyster.test/local/mesh/join", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ padding: "x".repeat(512 * 1024) }),
      }),
    );
    expect(response.status).toBe(413);
    const absent = await f.join(null, "absent");
    const unknown = await f.join("oyk_unknown.secret", "unknown");
    expect([absent.status, unknown.status]).toEqual([401, 401]);
    expect(await absent.text()).toBe(await unknown.text());
    expect(f.calls.directoryEnrollments).toBe(0);
    expect(f.enrollment.retainedDevices()).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("storage and HTTP outputs never retain the bearer value; KEYS stores its digest", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const response = await f.join(key.key, "secret-retention");
    expect(response.status).toBe(200);
    const records = f.credentials
      .prepare("SELECT * FROM ear_tag_oyk_keys")
      .all();
    expect(records).toHaveLength(1);
    const [record] = records;
    assert.isDefined(record);
    expect(z.string().min(1).parse(record.digest)).not.toBe(key.key);
    const persisted = JSON.stringify([
      records,
      f.owner.sql
        .exec("SELECT * FROM standalone_machine_enroll_keys")
        .toArray(),
      f.owner.sql.exec("SELECT * FROM hub_machine_devices").toArray(),
      await response.json(),
    ]);
    expect(persisted).not.toContain(key.key);
    expect(persisted).not.toContain("Authorization");
  } finally {
    f.close();
  }
});

it("the shared client's standalone home projection returns actual homes and refuses stale authority", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const joined = await f.enrollment.enrollWithKey(
      key.record.keyId,
      await input("project-home"),
    );
    const [machineAgent] = joined.agents;
    assert.isDefined(machineAgent);
    const hosted = f.directory.create(grant, {
      requestId: "hosted-projection",
      name: "Hosted",
      configuration: "owner-direct",
    }).agent;
    const home = standaloneMachineAgentHome({
      identity: () => ({ teamId: "agents", agentId: hosted.agentId }),
      directory: {
        getByName: (scopeId) => {
          expect(scopeId).toBe("agents");
          return {
            agentHome: (agentId) =>
              Promise.resolve(
                !f.directory
                  .list(grant)
                  .some((entry) => entry.agentId === agentId)
                  ? null
                  : (f.enrollment.home(agentId) ?? { kind: "hosted" }),
              ),
            machineTarget: f.enrollment.target,
          };
        },
      },
    });
    expect(await home(hosted.agentId)).toEqual({ kind: "hosted" });
    expect(await home(machineAgent.agentId)).toEqual({
      kind: "machine",
      deviceId: joined.deviceId,
    });
    const facts = await f.enrollment.target(
      {
        kind: "device",
        deviceId: joined.deviceId,
        agentId: machineAgent.agentId,
      },
      hosted.agentId,
      null,
    );
    expect(facts.callerHome).toEqual({
      kind: "machine",
      deviceId: joined.deviceId,
    });
    f.authority.memberId = null;
    await expect(home(machineAgent.agentId)).rejects.toBeInstanceOf(
      MachineLinkRefused,
    );
  } finally {
    f.close();
  }
});

it.each(["computer.use", "apps.use"] satisfies readonly OysterKeyCapability[])(
  "HTTP authentication with %s does not authorize enrollment or address its directory",
  async (capability) => {
    const f = fixture();
    try {
      const key = await f.issue("other-capability", capability);
      expect((await f.keys.verify(key.key)).kind).toBe("ok");
      expect((await f.join(key.key, "wrong-grant")).status).toBe(403);
      expect(f.calls.directoryEnrollments).toBe(0);
      expect(f.enrollment.retainedDevices()).toEqual([]);
      expect(f.directory.list(grant)).toEqual([]);
    } finally {
      f.close();
    }
  },
);

it.each([null, "human-owner-key-not-an-oyk-secret"])(
  "HTTP join refuses absent or non-oyk credentials (%s)",
  async (secret) => {
    const f = fixture();
    try {
      expect((await f.join(secret, "not-a-key")).status).toBe(401);
      expect(f.calls.directoryEnrollments).toBe(0);
      expect(f.enrollment.retainedDevices()).toEqual([]);
    } finally {
      f.close();
    }
  },
);

it("HTTP join refuses a revoked bearer that previously authenticated", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    expect((await f.keys.verify(key.key)).kind).toBe("ok");
    expect(
      (await f.keys.revoke("owner", { requestId: "revoke", keyId: "enroll" }))
        .kind,
    ).toBe("ok");
    expect((await f.join(key.key, "revoked-bearer")).status).toBe(401);
    expect(f.calls.directoryEnrollments).toBe(0);
    expect(f.enrollment.retainedDevices()).toEqual([]);
  } finally {
    f.close();
  }
});

it("HTTP join rereads the owner rather than borrowing an earlier request's admission", async () => {
  const f = fixture();
  try {
    const first = await f.issue();
    const second = await f.issue("second-key");
    expect((await f.join(first.key, "first-owner-read")).status).toBe(200);
    f.authority.memberId = null;
    expect((await f.join(second.key, "owner-removed")).status).toBe(403);
    expect(f.calls.directoryEnrollments).toBe(1);
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("one live oyk enrollment key buys only one device in the ordinary directory", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    const first = await f.enrollment.enrollWithKey(
      "enroll",
      await input("first"),
    );
    expect(first.agents).toHaveLength(1);
    await expect(
      f.enrollment.enrollWithKey("enroll", await input("second")),
    ).rejects.toThrow("actor_not_allowed");
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
    expect(f.directory.list(grant)).toHaveLength(1);
    // Consumption is not a write to KEYS or a replacement credential system.
    expect((await f.keys.verify(key.key)).kind).toBe("ok");
  } finally {
    f.close();
  }
});

it("concurrent joins cannot spend the same key twice", async () => {
  const f = fixture();
  try {
    await f.issue();
    const inputs = await Promise.all([input("first"), input("second")]);
    const results = await Promise.allSettled(
      inputs.map((value) => f.enrollment.enrollWithKey("enroll", value)),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(f.enrollment.retainedDevices()).toHaveLength(1);
    expect(f.directory.list(grant)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("a failed directory commit rolls back the key mark and enrollment together", async () => {
  const f = fixture();
  try {
    await f.issue();
    f.authority.failCreation = true;
    await expect(
      f.enrollment.enrollWithKey("enroll", await input("failed")),
    ).rejects.toThrow("directory projection failed");
    expect(f.enrollment.retainedDevices()).toEqual([]);
    expect(f.directory.list(grant)).toEqual([]);
    f.authority.failCreation = false;
    await expect(
      f.enrollment.enrollWithKey("enroll", await input("retry")),
    ).resolves.toHaveProperty("deviceId");
  } finally {
    f.close();
  }
});

it("revoking an unused key refuses enrollment even after earlier successful verification", async () => {
  const f = fixture();
  try {
    const key = await f.issue();
    expect((await f.keys.verify(key.key)).kind).toBe("ok");
    expect(
      (await f.keys.revoke("owner", { requestId: "revoke", keyId: "enroll" }))
        .kind,
    ).toBe("ok");
    await expect(
      f.enrollment.enrollWithKey("enroll", await input("revoked")),
    ).rejects.toThrow("actor_not_allowed");
    expect(f.enrollment.retainedDevices()).toEqual([]);
    expect(f.directory.list(grant)).toEqual([]);
  } finally {
    f.close();
  }
});

it("computer access is not machine enrollment authority", async () => {
  const f = fixture();
  try {
    await f.issue("computer", "computer.use");
    await expect(
      f.enrollment.enrollWithKey("computer", await input("wrong-grant")),
    ).rejects.toThrow("actor_not_allowed");
    expect(f.enrollment.retainedDevices()).toEqual([]);
  } finally {
    f.close();
  }
});

it("key revocation is not device revocation; a device fence commits before push", async () => {
  const f = fixture();
  try {
    await f.issue();
    const joined = await f.enrollment.enrollWithKey(
      "enroll",
      await input("first"),
    );
    const id = { teamId: "agents", deviceId: joined.deviceId };
    await f.keys.revoke("owner", { requestId: "revoke-key", keyId: "enroll" });
    expect(await f.enrollment.admitDevice(id)).toMatchObject({ live: true });
    const pushed: MachineLinkFenceFact[] = [];
    const fences = createMachineLinkFences({
      owner: f.owner,
      enrollment: f.enrollment,
      readFact: (deviceId) => f.enrollment.currentFence({ ...id, deviceId }),
      push: async (fact) => {
        expect(await f.enrollment.admitDevice(id)).toEqual({ live: false });
        pushed.push(fact);
        return { kind: "confirmed", fenceEpoch: fact.fenceEpoch };
      },
      wakeNow: () => {
        expect(
          f.owner.sql.exec("SELECT * FROM hub_machine_link_fences").toArray(),
        ).not.toHaveLength(0);
      },
      retryDelayMs: () => 1_000,
      report: (_operation, cause) => {
        throw cause;
      },
    });
    expect(await fences.revoke("owner", joined.deviceId)).toEqual({
      kind: "confirmed",
      fenceEpoch: 1,
    });
    expect(pushed).toEqual([{ ...id, live: false, fenceEpoch: 1 }]);
    expect(await f.enrollment.admitDevice(id)).toEqual({ live: false });
    expect(f.enrollment.keyRetired(joined.deviceId)).toBe(true);
  } finally {
    f.close();
  }
});

it("a staged lifecycle fence wakes immediately and reads its fact only after commit", async () => {
  const f = fixture();
  try {
    await f.issue();
    const joined = await f.enrollment.enrollWithKey(
      "enroll",
      await input("first-wake"),
    );
    const id = { teamId: "agents", deviceId: joined.deviceId };
    let committing = false;
    let wakes = 0;
    let reads = 0;
    const pushed: MachineLinkFenceFact[] = [];
    const fences = createMachineLinkFences({
      owner: {
        sql: f.owner.sql,
        transactionSync(body) {
          committing = true;
          try {
            return f.owner.transactionSync(body);
          } finally {
            committing = false;
          }
        },
      },
      enrollment: f.enrollment,
      readFact: async (deviceId) => {
        expect(committing).toBe(false);
        reads += 1;
        expect(
          f.owner.sql
            .exec(
              "SELECT fence_epoch FROM hub_machine_link_fences WHERE device_id=?",
              deviceId,
            )
            .toArray(),
        ).toEqual([{ fence_epoch: 1 }]);
        return f.enrollment.currentFence({ ...id, deviceId });
      },
      push: (fact) => {
        expect(committing).toBe(false);
        pushed.push(fact);
        return Promise.resolve({
          kind: "confirmed",
          fenceEpoch: fact.fenceEpoch,
        });
      },
      wakeNow: () => {
        expect(committing).toBe(false);
        expect(
          f.owner.sql
            .exec(
              "SELECT fence_epoch FROM hub_machine_link_fences WHERE device_id=?",
              id.deviceId,
            )
            .toArray(),
        ).toEqual([{ fence_epoch: 1 }]);
        wakes += 1;
      },
      retryDelayMs: () => 1_000,
      report: (_operation, cause) => {
        throw cause;
      },
    });
    fences.fenceAll();
    expect(wakes).toBe(1);
    expect(reads).toBe(0);
    await fences.family.deliver();
    expect(reads).toBe(1);
    expect(pushed).toEqual([{ ...id, live: true, fenceEpoch: 1 }]);
    expect(fences.family.nextDue()).toBeNull();
  } finally {
    f.close();
  }
});

it("every admission and directory read refuses a device after owner authority is removed", async () => {
  const f = fixture();
  try {
    await f.issue();
    const joined = await f.enrollment.enrollWithKey(
      "enroll",
      await input("first"),
    );
    const id = { teamId: "agents", deviceId: joined.deviceId };
    expect(await f.enrollment.admitDevice(id)).toMatchObject({ live: true });
    expect(await f.enrollment.publicDirectory(id)).toHaveLength(1);
    f.authority.memberId = null;
    expect(await f.enrollment.admitDevice(id)).toEqual({ live: false });
    expect(await f.enrollment.currentFence(id)).toEqual({
      ...id,
      live: false,
      fenceEpoch: 0,
    });
    await expect(f.enrollment.publicDirectory(id)).rejects.toThrow(
      "actor_not_allowed",
    );
  } finally {
    f.close();
  }
});

it("target resolution uses ordinary identities and refuses a forged or revoked device home", async () => {
  const f = fixture();
  try {
    await f.issue();
    const joined = await f.enrollment.enrollWithKey(
      "enroll",
      await input("local"),
    );
    const local = joined.agents[0];
    if (local === undefined) throw new Error("Local identity missing");
    const hosted = f.directory.create(grant, {
      requestId: "hosted",
      name: "Hosted",
      configuration: "owner-direct",
    }).agent;
    const caller: MachineLinkCaller = {
      kind: "device",
      deviceId: joined.deviceId,
      agentId: local.agentId,
    };
    expect(
      await f.enrollment.target(caller, hosted.agentId, null),
    ).toMatchObject({
      targetAgentId: hosted.agentId,
      targetHome: { kind: "hosted" },
    });
    await expect(
      f.enrollment.target(
        { ...caller, deviceId: "another-device" },
        hosted.agentId,
        null,
      ),
    ).rejects.toThrow("actor_not_allowed");
    f.enrollment.revoke("owner", joined.deviceId);
    await expect(
      f.enrollment.target(caller, hosted.agentId, null),
    ).rejects.toThrow("device_revoked");
  } finally {
    f.close();
  }
});
