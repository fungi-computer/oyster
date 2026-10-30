import { isCommittedInstallation } from "../dist/apps/installation.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOyster, installOrSelect } from "../dist/host.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createInstallationOperations,
  installationOperationsPort,
  installationOperationSchema,
  installationCommandIds,
} from "../dist/installation-operations.js";
import { observeInstallation } from "../dist/installation-client.js";
import { defaultTenant } from "../dist/tenant.js";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "cloudflare:workers"
      ? {
          url: new globalThis.URL(
            "../dist/testing/workers-runtime.js",
            import.meta.url,
          ).href,
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { executeInstallation } =
  await import("../dist/installation-execution.js");
hooks.deregister();

const owner = { actor: { kind: "member", memberId: "owner" }, role: "owner" };
const id = "context-probe";

/** A writable store over the fixture's backend App whose next Instance apply
 * can be held, so a concurrent owner write commits deterministically inside
 * another request's read -> prepare -> commit -> apply window. */
async function raceHost(t) {
  const base = await computerHost(owner, "workspace");
  const records = new Map([[id, await base.installations.get(id)]]);
  let generation = globalThis.crypto.randomUUID();
  let active = null;
  let preparing = null;
  let held = null;
  let verification = null;
  const database = new DatabaseSync(":memory:");
  const gates = [];
  const executions = [];
  const ticks = [];
  let duplicate = null;
  const admissions = new Map();
  let wakeRequests = 0;
  const host = {
    ...base,
    auth: { ...base.auth, resolve: async () => owner },
    artifacts: {
      get: async (...args) => {
        if (verification !== null && verification.candidate !== null) {
          const gate = verification;
          verification = null;
          gate.entered.resolve(gate.candidate);
          await gate.release.promise;
        }
        return base.artifacts.get(...args);
      },
    },
    installations: {
      generation: async () => generation,
      get: async (wanted) => {
        return records.get(wanted) ?? null;
      },
      list: async () => [...records.values()],
      // Version 0 names an absent record, as the registry does.
      compareAndPut: async (next, expected, expectedGeneration) => {
        if (
          expectedGeneration !== generation ||
          (records.get(next.installationId)?.authority.authorityVersion ??
            0) !== expected
        )
          return { ok: false, code: "stale_authority" };
        records.set(next.installationId, next);
        return { ok: true };
      },
    },
    instances: {
      get: (...args) => {
        const instance = base.instances.get(...args);
        return {
          ...instance,
          prepare: async (...input) => {
            if (preparing !== null) {
              const gate = preparing;
              preparing = null;
              gate.entered.resolve();
              await gate.release.promise;
            }
            return instance.prepare(...input);
          },
          apply: async (...input) => {
            if (held !== null) {
              const gate = held;
              held = null;
              gate.entered.resolve();
              await gate.release.promise;
            }
            if (
              !isCommittedInstallation(
                records.get(input[0].owner.id) ?? null,
                input[0],
                input[1],
              )
            )
              return { ok: false, code: "stale_authority" };
            const applied = await instance.apply(...input);
            if (applied.ok) active = input[0];
            return applied;
          },
        };
      },
    },
  };
  const runtime = await createInstallationOperations({
    owner: fromNodeSqlite(database),
    registryName: "registry",
    generation: () => generation,
    get: (wanted) => {
      if (verification !== null && wanted.startsWith(`${id}-`))
        verification.candidate = wanted;
      return records.get(wanted) ?? null;
    },
    compareAndPut: host.installations.compareAndPut,
    scheduleWake: async () => {
      wakeRequests++;
    },
    execute: async (command) => {
      const delivery = executeInstallation(host, command).then(
        (result) => ({ kind: "result", result }),
        (error) => ({ kind: "error", error }),
      );
      executions.push(delivery);
      const replay = duplicate;
      duplicate = null;
      if (replay !== null) {
        // Explicit duplicate RPC delivery under this SAME Watchdog claim.
        // The first delivery may reply late; no second scheduler/retry policy.
        replay.delivery = delivery;
        await replay.accept.promise;
        const retained = await operations.load(command.admission.requestId);
        assert.ok(retained);
        return executeInstallation(host, retained);
      }
      const returned = await delivery;
      if (returned.kind === "error") throw returned.error;
      return returned.result;
    },
  });
  const operations = installationOperationsPort(
    async (request) => {
      const reply = await runtime.dispatch(request);
      if (request.action === "admit") {
        const admission = admissions.get(request.input.requestId);
        if (admission !== undefined) {
          admission.entered.resolve();
          await admission.acknowledged.promise;
        }
      }
      return reply;
    },
    { tenantId: defaultTenant, origin: "https://oyster.test" },
  );
  host.installations.operations = operations;
  const tick = () => {
    assert.ok(
      wakeRequests > 0,
      "the real owner requested a wake before fixture driving",
    );
    const running = runtime.tick();
    ticks.push(running);
    return running;
  };
  const app = createOyster(host);
  const json = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const setGrants = async (grants, wanted = id) => {
    const projection = await (
      await app.request(`/api/installations/${wanted}/grants`, {
        headers: { Accept: "application/json" },
      })
    ).json();
    return app.request(
      `/api/installations/${wanted}/grants`,
      json("PUT", {
        storeGeneration: projection.storeGeneration,
        authorityVersion: projection.permissions.authority.authorityVersion,
        artifactDigest: projection.artifactDigest,
        command: {
          kind: "change-grants",
          changes: projection.permissions.declaredOperations.capabilities.map(
            ({ capability, operations }) => ({
              capability,
              grant:
                grants === "declared"
                  ? { operations, resources: "tenant-scope" }
                  : null,
            }),
          ),
        },
      }),
    );
  };
  const gate = () => {
    const value = {
      entered: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
    gates.push(value.release);
    return value;
  };
  const admit = async (installationId, release) => {
    const requestId = installationCommandIds.request.generate();
    const response = await app.request("/api/installations", {
      ...json("POST", { installationId, release }),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
    });
    assert.equal(response.status, 202, await response.clone().text());
    const initial = installationOperationSchema.parse(await response.json());
    assert.equal(initial.requestId, requestId);
    assert.equal(initial.state, "pending");
    return initial;
  };
  const observe = (initial) =>
    observeInstallation({
      requestId: initial.requestId,
      initial,
      read: () =>
        operations.read(initial.requestId, initial.requestedInstallationId),
      signal: new globalThis.AbortController().signal,
    });
  const select = async (release, wanted = id) => {
    const requestId = installationCommandIds.request.generate();
    const admission = {
      entered: Promise.withResolvers(),
      acknowledged: Promise.withResolvers(),
    };
    admissions.set(requestId, admission);
    const response = Promise.resolve(
      app.request(`/api/installations/${wanted}/release`, {
        ...json("PUT", release),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
      }),
    );
    try {
      const first = await Promise.race([
        response.then((value) => ({ response: value })),
        admission.entered.promise.then(() => ({ admitted: true })),
      ]);
      if ("response" in first) return first.response;
      await tick();
      admission.acknowledged.resolve();
      return await response;
    } finally {
      admission.acknowledged.resolve();
      admissions.delete(requestId);
    }
  };
  t.after(async () => {
    for (const release of gates) release.resolve();
    if (duplicate !== null) duplicate.accept.resolve();
    await Promise.all(ticks);
    await Promise.all(executions);
    database.close();
  });
  return {
    app,
    json,
    setGrants,
    admit,
    tick,
    observe,
    complete: (initial) =>
      installOrSelect(
        host,
        initial.requestedInstallationId,
        initial.release,
        owner,
        "install-or-remint",
        "owner-direct",
        initial.requestId,
      ),
    select,
    duplicateDelivery: () => {
      const replay = { accept: Promise.withResolvers(), delivery: null };
      gates.push(replay.accept);
      duplicate = replay;
      return replay;
    },
    current: (wanted = id) => records.get(wanted) ?? null,
    active: () => active,
    replaceStore: () => {
      generation = globalThis.crypto.randomUUID();
    },
    holdVerification: () => {
      verification = { ...gate(), candidate: null };
      return verification;
    },
    holdPreparation: () => {
      preparing = gate();
      return preparing;
    },
    hold: () => {
      held = gate();
      return held;
    },
  };
}

for (const phase of ["verification", "activation"]) {
  test(`a minted id cannot replace a later owner selection during ${phase}`, async (t) => {
    const race = await raceHost(t);
    const release = race.current().release;
    assert.equal(
      (await race.app.request(`/api/installations/${id}`, { method: "DELETE" }))
        .status,
      204,
    );
    const verification = race.holdVerification();
    const duplicate = race.duplicateDelivery();
    const admitted = await race.admit(id, release);
    const running = race.tick();
    // Hold a real executor delivery at verification/activation. Explicitly
    // duplicate that same pinned command under its one owning claim, then let
    // a later owner selection win before releasing the delayed first reply.
    const candidate = await verification.entered.promise;
    assert.equal(candidate, admitted.installationId);
    const activation = phase === "activation" ? race.hold() : null;
    if (activation !== null) {
      verification.release.resolve();
      await activation.entered.promise;
    }
    duplicate.accept.resolve();
    await running;
    const reminted = await race.observe(admitted);
    assert.equal(reminted.state, "succeeded");
    assert.equal(reminted.creation, "reminted");
    assert.equal(reminted.installation.installationId, candidate);
    const competitor = await race.admit(candidate, release);
    await race.tick();
    const replaced = await race.observe(competitor);
    assert.equal(replaced.state, "succeeded");
    assert.equal(replaced.creation, "replacement");
    assert.equal((await race.setGrants("declared", candidate)).status, 200);
    const winner = race.current(candidate);
    assert.notDeepEqual(winner.authority.approvedGrants, []);
    (activation ?? verification).release.resolve();
    const late = await duplicate.delivery;
    if (phase === "verification") {
      assert.equal(late.kind, "error");
      assert.equal(late.error.code, "stale_authority");
    } else {
      assert.equal(late.kind, "result");
      assert.deepEqual(late.result, {
        state: "unconfirmed",
        outcome: "outcome_unknown",
      });
    }
    assert.deepEqual(race.current(candidate), winner);
    assert.deepEqual(await race.observe(admitted), {
      ...reminted,
      installation: null,
    });
    assert.ok(
      winner.authority.authorityVersion > reminted.reference.authorityVersion,
    );
    assert.equal(race.current().status, "deleted");
  });
}

test("Release selection awaiting activation cannot undo an owner revocation", async (t) => {
  const race = await raceHost(t);
  assert.equal((await race.setGrants("declared")).status, 200);
  assert.notDeepEqual(race.current().authority.approvedGrants, []);
  // Selection commits through the owner after preparation and must lose to
  // the later revocation; the post-commit delayed-reply window is exercised
  // separately below.
  const gate = race.holdPreparation();
  const pending = race.select(race.current().release);
  await gate.entered.promise;
  assert.equal((await race.setGrants("none")).status, 200);
  const revoked = race.current();
  gate.release.resolve();
  const response = await pending;
  assert.deepEqual(
    {
      status: response.status,
      body: await response.json(),
      stored: race.current(),
    },
    { status: 409, body: { error: "stale_authority" }, stored: revoked },
  );
});

test("concurrent installs of one new name commit only once", async (t) => {
  const race = await raceHost(t);
  const release = race.current().release;
  const gate = race.holdPreparation();
  const first = await race.admit("fresh-probe", release);
  const running = race.tick();
  await gate.entered.promise;
  const second = await race.admit("fresh-probe", release);
  assert.equal(race.current("fresh-probe"), null);
  gate.release.resolve();
  await running;
  const won = await race.observe(first);
  assert.equal(won.state, "succeeded");
  assert.equal(won.creation, "fresh");
  const winner = race.current("fresh-probe");
  await race.tick();
  const loser = await race.observe(second);
  assert.equal(loser.state, "refused");
  assert.equal(loser.status, 409);
  assert.equal(loser.code, "stale_authority");
  assert.deepEqual(race.current("fresh-probe"), winner);
  assert.equal(winner.authority.authorityVersion, 1);
});

test("a save captured before replacing the store refuses matching version and artifact in the new generation", async (t) => {
  const race = await raceHost(t);
  const projection = await (
    await race.app.request("/api/installations/" + id + "/grants", {
      headers: { Accept: "application/json" },
    })
  ).json();
  const before = race.current();
  race.replaceStore();
  const response = await race.app.request(
    "/api/installations/" + id + "/grants",
    race.json("PUT", {
      storeGeneration: projection.storeGeneration,
      authorityVersion: projection.permissions.authority.authorityVersion,
      artifactDigest: projection.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [{ capability: "computer.execute", grant: null }],
      },
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "stale_authority" });
  assert.deepEqual(race.current(), before);
});

test("a settled completion cannot hydrate matching version and artifact from a different store generation", async (t) => {
  const race = await raceHost(t);
  const admitted = await race.admit(id, race.current().release);
  await race.tick();
  const completed = await race.observe(admitted);
  assert.equal(completed.state, "succeeded");
  assert.notEqual(completed.installation, null);
  const current = race.current();
  race.replaceStore();
  assert.deepEqual(await race.observe(admitted), {
    ...completed,
    installation: null,
  });
  assert.deepEqual(race.current(), current);
});

test("a release loser finishing after the winner cannot replace the stored or active selection", async (t) => {
  const race = await raceHost(t);
  const release = race.current().release;
  const gate = race.hold();
  const duplicate = race.duplicateDelivery();
  const admitted = await race.admit(id, { ...release, releaseId: "rel_loser" });
  const running = race.tick();
  await gate.entered.promise;
  duplicate.accept.resolve();
  await running;
  const completed = await race.observe(admitted);
  assert.equal(completed.state, "succeeded");
  const winner = await race.select({ ...release, releaseId: "rel_winner" });
  assert.equal(winner.status, 200);
  const committed = race.current();
  assert.equal(race.active().releaseId, committed.release.releaseId);
  gate.release.resolve();
  const late = await duplicate.delivery;
  assert.equal(late.kind, "result");
  assert.deepEqual(late.result, {
    state: "unconfirmed",
    outcome: "outcome_unknown",
  });
  assert.deepEqual(await race.observe(admitted), {
    ...completed,
    installation: null,
  });
  assert.ok(
    committed.authority.authorityVersion > completed.reference.authorityVersion,
  );
  const replayed = await race.app.request("/api/installations", {
    ...race.json("POST", {
      installationId: id,
      release: completed.release,
    }),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": admitted.requestId,
    },
  });
  assert.equal(replayed.status, 202);
  assert.deepEqual(installationOperationSchema.parse(await replayed.json()), {
    ...completed,
    installation: null,
  });
  const response = await race.complete(admitted);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "installation_result_unavailable",
    requestId: admitted.requestId,
    reference: completed.reference,
  });
  assert.deepEqual(race.current(), committed);
  assert.equal(race.active().releaseId, committed.release.releaseId);
  assert.equal(
    race.active().authorityVersion,
    committed.authority.authorityVersion,
  );
});
