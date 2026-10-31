import { DatabaseSync } from "node:sqlite";
import { scheduler } from "node:timers/promises";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createAppBuild,
  type AppBuild,
  type AppDeclaration,
} from "@fungi.computer/puffball/app";
import {
  releaseSchema,
  sha256DigestSchema,
} from "@fungi.computer/puffball/effect";
import { parseArtifactRef } from "@fungi.computer/puffball";
import {
  createAppInstance,
  instanceIds,
  selectionOf,
  type Backend,
  type Instance,
} from "../src/index.js";
import {
  isCommittedInstallation,
  type Installation,
} from "../src/apps/installation.js";
import { approvedInstallation } from "../src/testing/installation.js";
import {
  createOyster,
  installOrSelect,
  type OysterHost,
  type InstanceResult,
} from "../src/host.js";
import { BootGateError, type UiBootCheckOutcome } from "../src/boot-gate.js";
import { executeInstallation } from "../src/installation-execution.js";
import {
  observeInstallation,
  InstallationObservationError,
} from "../src/installation-client.js";
import {
  createInstallationOperations,
  installationOperationsPort,
  installationOperationSchema,
} from "../src/installation-operations.js";
import { defaultTenant } from "../src/tenant.js";
import { sha256, resolveBackend } from "../src/release.js";

/**
 * In-process owner/executor/core-Instance proof. Watchdog uses native SQLite;
 * Instance storage and boot are explicit host ports. This is not loopback RPC,
 * process restart, Cloudflare boot construction or native runtime acceptance.
 */
async function fixture(
  refuseApply = false,
  unexpected?:
    | "prepare"
    | "apply"
    | "backend-construction"
    | "stale-after-apply"
    | "lost-apply-reply",
) {
  const database = new DatabaseSync(":memory:");
  const objects = new Map<string, Uint8Array>();
  const put = async (value: Backend["backend"] | AppBuild) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = Schema.decodeUnknownSync(sha256DigestSchema)(
      await sha256(bytes),
    );
    const artifactRef = parseArtifactRef(`artifact:sha256-${digest.slice(7)}`);
    objects.set(artifactRef, bytes);
    return {
      artifactRef,
      digest,
      byteLength: bytes.byteLength,
      version: digest,
    };
  };
  const backendObject = await put({
    runtime: { kind: "durable-facet", stateSchema: 1 },
    compatibilityDate: "2026-09-04",
    exportName: "Notes",
    code: "export class Notes {}",
  });
  const root = await put(
    createAppBuild(null, {
      ...backendObject,
      mediaType: "application/vnd.fungi.app-backend+json",
    }),
  );
  const release = Schema.decodeUnknownSync(releaseSchema)({
    appId: "app_notes",
    releaseId: "rel_notes",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  });
  /** Another Release of the same App and backend that declares capabilities. */
  const declaringRelease = async (
    releaseId: string,
    capabilities: AppDeclaration["capabilities"],
  ) => {
    const declared = await put(
      createAppBuild(
        null,
        {
          ...backendObject,
          mediaType: "application/vnd.fungi.app-backend+json",
        },
        { capabilities, handlers: [], roles: [] },
      ),
    );
    return Schema.decodeUnknownSync(releaseSchema)({
      appId: "app_notes",
      releaseId,
      artifact: {
        artifactRef: declared.artifactRef,
        artifactDigest: declared.digest,
        provenance: release.artifact.provenance,
      },
    });
  };
  let reads = 0;
  const artifacts = {
    get: (ref: string) => {
      reads++;
      return Promise.resolve(objects.get(ref) ?? null);
    },
    put: (ref: string, bytes: Uint8Array) => {
      objects.set(ref, bytes);
      return Promise.resolve();
    },
  };
  const verified = await resolveBackend(artifacts, release);
  if (verified === null) throw new Error("Backend required");
  const backend: Backend = {
    release,
    digest: verified.digest,
    backend: verified.backend,
  };
  reads = 0;
  const rows = new Map<string, Installation>();
  let snapshot: Instance | null = null;
  let boots = 0;
  let aborts = 0;
  const preparing = Promise.withResolvers<undefined>();
  const prepareGate = Promise.withResolvers<undefined>();
  const applying = Promise.withResolvers<undefined>();
  const applyGate = Promise.withResolvers<undefined>();
  const selecting = Promise.withResolvers<undefined>();
  const lostReply = new TypeError("Apply reply transport disconnected");
  const replyLost = Promise.withResolvers<undefined>();
  const replayDelivery = Promise.withResolvers<undefined>();
  let loseReply = unexpected === "lost-apply-reply";
  const principal = {
    actor: { kind: "member" as const, memberId: "owner" },
    role: "owner" as const,
  };
  const runtime = await createInstallationOperations({
    owner: fromNodeSqlite(database),
    registryName: "registry",
    generation: () => "generation",
    get: (id) => rows.get(id) ?? null,
    compareAndPut: (next, version, generation) => {
      if (
        (rows.get(next.installationId)?.authority.authorityVersion ?? 0) !==
          version ||
        generation !== "generation"
      )
        return Promise.resolve({ ok: false, code: "stale_authority" });
      rows.set(next.installationId, next);
      return Promise.resolve({ ok: true });
    },
    execute: async (command) => {
      let result;
      try {
        result = await executeInstallation(host, command);
      } catch (cause) {
        if (cause !== lostReply) throw cause;
        replyLost.resolve(undefined);
        // An explicit duplicate delivery of this retained fact, under the
        // same owning claim. This fixture does not configure a retry policy.
        await replayDelivery.promise;
        const retained = await operations.load(command.admission.requestId);
        if (retained === null) throw new Error("Command missing", { cause });
        return executeInstallation(host, retained);
      }
      if (result.state !== "succeeded") return result;
      // Model a lost executor acknowledgement: replay the retained plan before
      // the Watchdog claim settles, not a new installOrSelect/version derivation.
      const retained = await operations.load(command.admission.requestId);
      if (retained === null) throw new Error("Command missing");
      return executeInstallation(host, retained);
    },
    scheduleWake: () => Promise.resolve(),
  });
  const operations = installationOperationsPort(
    async (request) => {
      const reply = await runtime.dispatch(request);
      if (
        request.action === "admit" &&
        request.input.requestId === "executor-select"
      )
        selecting.resolve(undefined);
      return reply;
    },
    {
      tenantId: defaultTenant,
      origin: "https://oyster.test",
    },
  );
  let instance: ReturnType<typeof createAppInstance<undefined>> | undefined;
  const core = (id: string) =>
    (instance ??= createAppInstance<undefined>({
      instanceId: id,
      read: () => Effect.succeed(snapshot),
      write: (next) =>
        Effect.sync(() => {
          snapshot = next;
        }),
      resolve: () => Effect.succeed(backend),
      boot: () =>
        Effect.tryPromise({
          try: async () => {
            boots++;
            if (unexpected === "backend-construction")
              throw new BootGateError("backend_construction_failed");
            if (boots === 1) {
              preparing.resolve(undefined);
              await prepareGate.promise;
            } else if (boots === 2) {
              applying.resolve(undefined);
              await applyGate.promise;
            }
            return refuseApply
              ? { kind: "failed" as const, code: "ui_mount_failed" as const }
              : { kind: "passed" as const };
          },
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("Boot failed", { cause }),
        }),
      abort: () =>
        Effect.sync(() => {
          aborts++;
        }),
      purge: () => Effect.void,
      connect: () =>
        Effect.fail(new Error("Installation does not open a guest connection")),
    }));
  const result = async <A>(
    effect: Effect.Effect<A, Error>,
  ): Promise<InstanceResult<A>> => {
    const exit = await Effect.runPromise(Effect.result(effect));
    if (exit._tag === "Success") return { ok: true, value: exit.success };
    if (exit.failure instanceof BootGateError)
      return { ok: false, code: exit.failure.code };
    throw exit.failure;
  };
  const host: OysterHost = {
    auth: {
      authenticate: () => Promise.resolve({ kind: "admitted", principal }),
      resolve: () => Promise.resolve(principal),
    },
    artifacts,
    bootUi: () => Promise.resolve({ kind: "passed" as const }),
    installations: {
      operations,
      generation: () => Promise.resolve("generation"),
      get: (id) => Promise.resolve(rows.get(id) ?? null),
      list: () => Promise.resolve([...rows.values()]),
      compareAndPut: () =>
        Promise.reject(new Error("Only retained owner commits")),
    },
    instances: {
      get: (id) => ({
        prepare: (state) =>
          unexpected === "prepare"
            ? Promise.resolve<InstanceResult<UiBootCheckOutcome | null>>({
                ok: false,
                code: "failed",
                causeClass: "AbortError",
              })
            : result(core(id).prepare(state)),
        apply: async (state) =>
          unexpected === "apply"
            ? Promise.resolve<InstanceResult<Instance>>({
                ok: false,
                code: "failed",
                causeClass: "TimeoutError",
              })
            : await (async () => {
                const applied = await result(core(id).apply(state));
                if (applied.ok && loseReply) {
                  loseReply = false;
                  throw lostReply;
                }
                // Native OysterInstance.apply rechecks the committed row
                // after core.apply; this code can arrive AFTER application.
                if (
                  applied.ok &&
                  unexpected === "stale-after-apply" &&
                  !isCommittedInstallation(
                    rows.get("notes") ?? null,
                    state,
                    release,
                  )
                )
                  return {
                    ok: false as const,
                    code: "stale_authority" as const,
                  };
                return applied;
              })(),
        fetch: () => Promise.reject(new Error("No fetch during installation")),
        call: () => Promise.reject(new Error("No call during installation")),
        gill: () => Promise.reject(new Error("No Gill during installation")),
        onGitPush: () =>
          Promise.reject(new Error("No Git push during installation")),
        syncRefused: () =>
          Promise.reject(new Error("No sync during installation")),
        authorizeGitPush: () =>
          Promise.reject(new Error("No Git authorization during installation")),
      }),
    },
  };
  const app = createOyster(host);
  const read = async (requestId = "executor-proof") => {
    const response = await app.request(
      `/api/installations/notes/status?requestId=${encodeURIComponent(requestId)}`,
    );
    expect(response.status).toBe(200);
    return installationOperationSchema.parse(await response.json());
  };
  return {
    database,
    rows,
    app,
    host,
    principal,
    declaringRelease,
    read,
    runtime,
    operations,
    replyLost,
    replayDelivery,
    selecting,
    release,
    preparing,
    prepareGate,
    applying,
    applyGate,
    snapshot: () => snapshot,
    boots: () => boots,
    aborts: () => aborts,
    reads: () => reads,
    replay: async () => {
      const row = rows.get("notes");
      if (row === undefined || instance === undefined)
        throw new Error("Active Instance missing");
      return Effect.runPromise(
        instance.apply({ ...selectionOf(row), status: row.status }),
      );
    },
  };
}

it.each([false, true])(
  "joins actual owner and executor to Instance application (refuse=%s)",
  async (refuse) => {
    const state = await fixture(refuse);
    let running: Promise<unknown> | undefined;
    try {
      const admitted = await state.app.request("/api/installations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "executor-proof",
        },
        body: JSON.stringify({
          installationId: "notes",
          release: state.release,
        }),
      });
      expect(admitted.status).toBe(202);
      expect(state.reads()).toBe(0);
      expect(state.boots()).toBe(0);
      running = state.runtime.tick();
      await state.preparing.promise;
      expect(state.rows.size).toBe(0);
      expect((await state.read()).state).toBe("pending");
      state.prepareGate.resolve(undefined);
      await state.applying.promise;
      expect(state.rows.get("notes")?.authority.authorityVersion).toBe(1);
      expect(state.snapshot()).toBeNull();
      expect((await state.read()).state).toBe("pending");
      state.applyGate.resolve(undefined);
      await running;
      const outcome = await state.read();
      expect(outcome).toMatchObject(
        refuse
          ? {
              state: "succeeded",
              creation: "fresh",
              uiCheck: { kind: "failed", code: "ui_mount_failed" },
            }
          : {
              state: "succeeded",
              creation: "fresh",
              uiCheck: { kind: "passed" },
            },
      );
      expect(state.boots()).toBe(2);
      expect(state.snapshot()?.status).toBe("active");
      const aborts = state.aborts();
      expect(await state.replay()).toEqual(state.snapshot());
      expect(state.boots()).toBe(2);
      expect(state.aborts()).toBe(aborts);
    } finally {
      state.prepareGate.resolve(undefined);
      state.applyGate.resolve(undefined);
      await running;
      state.database.close();
    }
  },
);

it("succeeds when a disabled backend installation selects another Release", async () => {
  const state = await fixture();
  try {
    const baseline = await approvedInstallation({
      release: state.release,
      declaration: { capabilities: [], handlers: [], roles: [] },
      installationId: "notes",
      instanceId: instanceIds.instance.generate(),
    });
    state.rows.set("notes", { ...baseline, status: "disabled" });
    const nextRelease = await state.declaringRelease("rel_next", []);
    const admitted = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-select",
      },
      body: JSON.stringify({ installationId: "notes", release: nextRelease }),
    });
    expect(admitted.status).toBe(202);
    await state.runtime.tick();
    expect(await state.read("executor-select")).toMatchObject({
      state: "succeeded",
      installation: { status: "disabled", release: nextRelease },
      uiCheck: null,
    });
    expect(state.boots()).toBe(0);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
});

it("refuses a malformed artifact before starting any boot check", async () => {
  const state = await fixture();
  try {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    const malformed = {
      ...state.release,
      artifact: {
        ...state.release.artifact,
        artifactDigest: `sha256:${"0".repeat(64)}`,
      },
    };
    const admitted = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
      },
      body: JSON.stringify({ installationId: "notes", release: malformed }),
    });
    expect(admitted.status).toBe(202);
    await state.runtime.tick();
    expect(await state.read()).toMatchObject({
      state: "refused",
      status: 422,
      code: "digest_mismatch",
    });
    expect(state.boots()).toBe(0);
    expect(state.rows.size).toBe(0);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
});

it("keeps backend construction blocking before recording the UI outcome", async () => {
  const state = await fixture(false, "backend-construction");
  try {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    const admitted = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
      },
      body: JSON.stringify({
        installationId: "notes",
        release: state.release,
      }),
    });
    expect(admitted.status).toBe(202);
    await state.runtime.tick();
    expect(await state.read()).toMatchObject({
      state: "refused",
      status: 422,
      code: "backend_construction_failed",
    });
    expect(state.rows.size).toBe(0);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
});

it.each(["prepare", "apply"] as const)(
  "keeps the actual generic %s InstanceResult unconfirmed",
  async (phase) => {
    const state = await fixture(false, phase);
    try {
      const admitted = await state.app.request("/api/installations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "executor-proof",
        },
        body: JSON.stringify({
          installationId: "notes",
          release: state.release,
        }),
      });
      expect(admitted.status).toBe(202);
      state.prepareGate.resolve(undefined);
      state.applyGate.resolve(undefined);
      await state.runtime.tick();
      expect(await state.read()).toMatchObject({
        state: "unconfirmed",
        outcome: "outcome_unknown",
      });
      expect(state.rows.has("notes")).toBe(phase === "apply");
      expect(state.snapshot()).toBeNull();
    } finally {
      state.prepareGate.resolve(undefined);
      state.applyGate.resolve(undefined);
      state.database.close();
    }
  },
);

it("PUT selection admits the same completion contract and keeps the exact existing authority lineage", async () => {
  const state = await fixture();
  try {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    const install = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
      },
      body: JSON.stringify({ installationId: "notes", release: state.release }),
    });
    expect(install.status).toBe(202);
    await state.runtime.tick();
    const original = state.rows.get("notes");
    if (original === undefined) throw new Error("Installation missing");
    let completed = false;
    const selecting = Promise.resolve(
      state.app.request("/api/installations/notes/release", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "executor-select",
        },
        body: JSON.stringify(state.release),
      }),
    ).then((response) => {
      completed = true;
      return response;
    });
    await state.selecting.promise;
    expect((await state.read("executor-select")).state).toBe("pending");
    expect(completed).toBe(false);
    expect(state.rows.get("notes")).toEqual(original);
    await state.runtime.tick();
    const selected = await selecting;
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual(state.rows.get("notes"));
    expect(await state.read("executor-select")).toMatchObject({
      state: "succeeded",
      creation: "replacement",
      installation: {
        installationId: original.installationId,
        instanceId: original.instanceId,
        authority: {
          authorityVersion: original.authority.authorityVersion + 1,
        },
      },
    });
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
}, 15_000);

it.each([false, true])(
  "does not convert supersession after exact application into a fabricated domain refusal (native stale reply=%s)",
  async (nativeReply) => {
    const state = await fixture(
      false,
      nativeReply ? "stale-after-apply" : undefined,
    );
    let running: Promise<unknown> | undefined;
    try {
      await state.app.request("/api/installations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "executor-proof",
        },
        body: JSON.stringify({
          installationId: "notes",
          release: state.release,
        }),
      });
      state.prepareGate.resolve(undefined);
      running = state.runtime.tick();
      await state.applying.promise;
      const selection = state.rows.get("notes");
      if (selection === undefined)
        throw new Error("Committed selection missing");
      state.rows.set("notes", {
        ...selection,
        authority: {
          ...selection.authority,
          authorityVersion: selection.authority.authorityVersion + 1,
        },
      });
      state.applyGate.resolve(undefined);
      await running;
      expect(state.snapshot()?.authorityVersion).toBe(
        selection.authority.authorityVersion,
      );
      expect(await state.read()).toMatchObject({
        state: "unconfirmed",
        outcome: "outcome_unknown",
      });
      expect(state.rows.get("notes")?.authority.authorityVersion).toBe(2);
    } finally {
      state.prepareGate.resolve(undefined);
      state.applyGate.resolve(undefined);
      await running;
      state.database.close();
    }
  },
);

it("replays the exact retained selection after a lost actual apply reply without preparing, rebooting or incrementing authority", async () => {
  const state = await fixture(false, "lost-apply-reply");
  let running: Promise<unknown> | undefined;
  try {
    const admitted = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
      },
      body: JSON.stringify({ installationId: "notes", release: state.release }),
    });
    expect(admitted.status).toBe(202);
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    running = state.runtime.tick();
    await state.replyLost.promise;
    expect((await state.read()).state).toBe("pending");
    expect(state.snapshot()).toMatchObject({
      status: "active",
      authorityVersion: 1,
    });
    const retained = await state.operations.load("executor-proof");
    expect(retained?.plan?.prepared).toBe(true);
    const boots = state.boots();
    const aborts = state.aborts();
    state.replayDelivery.resolve(undefined);
    await running;
    expect(await state.read()).toMatchObject({
      state: "succeeded",
      creation: "fresh",
      installation: retained?.plan?.installation,
    });
    expect(state.rows.get("notes")).toEqual(retained?.plan?.installation);
    expect(state.snapshot()?.authorityVersion).toBe(1);
    expect(state.boots()).toBe(boots);
    expect(state.aborts()).toBe(aborts);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.replayDelivery.resolve(undefined);
    await running;
    state.database.close();
  }
});

it("keeps App-mediated installation refused even for an owner member", async () => {
  const state = await fixture();
  try {
    const refused = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
        "X-Oyster-Installation": "notes",
      },
      body: JSON.stringify({ installationId: "notes", release: state.release }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "install_authority_unavailable",
    });
    expect(state.rows.size).toBe(0);
    expect(state.reads()).toBe(0);
    expect(state.boots()).toBe(0);
  } finally {
    state.database.close();
  }
});

it("cancels an observer blocked on a decoded RPC reply without failing or cancelling its retained operation", async () => {
  const state = await fixture();
  const reading = Promise.withResolvers<undefined>();
  const reply = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const reason = new Error("Caller stopped observing");
  let running: Promise<unknown> | undefined;
  let observed:
    { kind: "returned" } | { kind: "failed"; cause: unknown } | undefined;
  let observing: Promise<void> | undefined;
  try {
    const admitted = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
      },
      body: JSON.stringify({ installationId: "notes", release: state.release }),
    });
    expect(admitted.status).toBe(202);
    running = state.runtime.tick();
    await state.preparing.promise;
    observing = observeInstallation({
      requestId: "executor-proof",
      initial: await state.read(),
      signal: controller.signal,
      read: async () => {
        reading.resolve(undefined);
        // The real decoded owner port has no signal argument. Only its reply
        // transport is held; no receipt, provider or scheduler is fabricated.
        await reply.promise;
        return state.operations.read("executor-proof", "notes");
      },
    }).then(
      () => {
        observed = { kind: "returned" };
      },
      (cause: unknown) => {
        observed = { kind: "failed", cause };
      },
    );
    await reading.promise;
    controller.abort(reason);
    // A real event-loop turn, not fake time or a new observation timeout law.
    await scheduler.yield();
    expect(observed?.kind).toBe("failed");
    if (observed?.kind !== "failed")
      throw new Error("Observation did not cancel");
    expect(observed.cause).toBeInstanceOf(InstallationObservationError);
    expect(observed.cause).toMatchObject({
      requestId: "executor-proof",
      cause: reason,
    });
    expect((await state.read()).state).toBe("pending");
    expect(state.rows.size).toBe(0);
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    await running;
    expect(await state.read()).toMatchObject({
      state: "succeeded",
      creation: "fresh",
      installation: { authority: { authorityVersion: 1 } },
    });
    reply.resolve(undefined);
    await observing;
    expect(observed.kind).toBe("failed");
    expect(state.boots()).toBe(2);
  } finally {
    controller.abort(reason);
    reply.resolve(undefined);
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    await running;
    await observing;
    state.database.close();
  }
});

/** Admit through the real host entry with Workflow origin, then run the owner. */
async function workflowInstall(
  state: Awaited<ReturnType<typeof fixture>>,
  release: Awaited<ReturnType<typeof fixture>>["release"],
  requestId: string,
) {
  const response = installOrSelect(
    state.host,
    "notes",
    release,
    state.principal,
    "install-or-select",
    "workflow",
    requestId,
  );
  while ((await state.operations.load(requestId)) === null)
    await scheduler.yield();
  await state.runtime.tick();
  return response;
}

it("requests owner confirmation for a fresh Workflow install even without capability grants", async () => {
  const state = await fixture();
  try {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    const installed = await workflowInstall(
      state,
      state.release,
      "workflow-fresh",
    );
    expect(installed.status).toBe(409);
    expect(await installed.json()).toEqual({ error: "needs_consent" });
    expect(state.rows.has("notes")).toBe(false);
    expect(
      await state.operations.read("workflow-fresh", "notes"),
    ).toMatchObject({ state: "refused", code: "needs_consent" });
    expect(state.boots()).toBe(0);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
}, 15_000);

it("settles a Workflow upgrade that declares a new capability as needs_consent and keeps the running Release", async () => {
  const state = await fixture();
  try {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    const install = await state.app.request("/api/installations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "executor-proof",
      },
      body: JSON.stringify({ installationId: "notes", release: state.release }),
    });
    expect(install.status).toBe(202);
    await state.runtime.tick();
    const running = state.rows.get("notes");
    if (running === undefined) throw new Error("Installation missing");
    const boots = state.boots();
    const upgrade = await state.declaringRelease("rel_notesreads", [
      "computer.readFile",
    ]);
    const refused = await workflowInstall(state, upgrade, "workflow-upgrade");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "needs_consent" });
    expect(
      await state.operations.read("workflow-upgrade", "notes"),
    ).toMatchObject({ state: "refused", status: 409, code: "needs_consent" });
    expect(await state.operations.load("workflow-upgrade")).toBeNull();
    expect(state.rows.get("notes")).toEqual(running);
    expect(state.boots()).toBe(boots);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
}, 15_000);

it("settles a fresh Workflow install that the owner would have to approve as needs_consent, not unconfirmed", async () => {
  const state = await fixture();
  try {
    const declared = await state.declaringRelease("rel_notesreads", [
      "computer.readFile",
    ]);
    const refused = await workflowInstall(state, declared, "workflow-grant");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "needs_consent" });
    expect(
      await state.operations.read("workflow-grant", "notes"),
    ).toMatchObject({ state: "refused", status: 409, code: "needs_consent" });
    expect(state.rows.has("notes")).toBe(false);
    expect(state.boots()).toBe(0);
  } finally {
    state.database.close();
  }
}, 15_000);

// Owner confirmation creates the installation. Later Workflow updates can
// reuse that approval but never install another App or widen its grants.
it("reuses an owner-confirmed installation without widening it in later Workflows", async () => {
  const state = await fixture();
  try {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    const response = installOrSelect(
      state.host,
      "notes",
      state.release,
      state.principal,
      "install-or-select",
      "owner-direct",
      "workflow-create",
    );
    while ((await state.operations.load("workflow-create")) === null)
      await scheduler.yield();
    await state.runtime.tick();
    const created = await response;
    expect(created.status).toBe(201);
    const fresh = state.rows.get("notes");
    if (fresh === undefined) throw new Error("Installation missing");
    expect(fresh).toMatchObject({
      authority: { approvedGrants: [], approval: null },
    });
    // A later Workflow may reuse exactly that approval...
    const next = await state.declaringRelease("rel_notesnext", []);
    const reused = await workflowInstall(state, next, "workflow-reuse");
    expect(reused.status).toBe(200);
    const upgraded = state.rows.get("notes");
    expect(upgraded?.release).toEqual(next);
    expect(upgraded).toMatchObject({
      authority: { approvedGrants: [], approval: null },
    });
    // ...but never approve a capability the owner has not granted.
    const widening = await state.declaringRelease("rel_notesreads", [
      "computer.readFile",
    ]);
    const refused = await workflowInstall(state, widening, "workflow-widen");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "needs_consent" });
    expect(state.rows.get("notes")).toEqual(upgraded);
  } finally {
    state.prepareGate.resolve(undefined);
    state.applyGate.resolve(undefined);
    state.database.close();
  }
}, 30_000);
