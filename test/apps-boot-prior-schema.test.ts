import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  createAppInstance,
  instanceIds,
  type Backend,
  type Instance,
  type InstancePorts,
  type OwnerState,
} from "../src/index.js";
import { release } from "./apps-fixture.js";

function lifecycle(priorStateSchema?: Instance["stateSchema"]) {
  const state: OwnerState = {
    instanceId: instanceIds.instance.generate(),
    owner: { kind: "installation", id: "notes" },
    appId: release.appId,
    releaseId: release.releaseId,
    authorityVersion: 1,
    status: "enabled",
  };
  const backend: Backend = {
    release,
    digest: release.artifact.artifactDigest,
    backend: {
      compatibilityDate: "2026-09-04",
      exportName: "Notes",
      runtime: { kind: "durable-facet", stateSchema: 1 },
      code: "export class Notes {}",
    },
  };
  let record: Instance | null =
    priorStateSchema === undefined
      ? null
      : {
          ...state,
          desiredStatus: "disabled",
          status: "disabled",
          stateSchema: priorStateSchema,
        };
  const effects = { reads: 0, writes: 0, aborts: 0, purges: 0 };
  const boots: (readonly [Backend, Instance["stateSchema"]])[] = [];
  const uiChecks: ("run" | "reuse" | undefined)[] = [];
  const ports: InstancePorts<undefined> = {
    instanceId: state.instanceId,
    read: () =>
      Effect.sync(() => {
        effects.reads += 1;
        return record;
      }),
    write: (next) =>
      Effect.sync(() => {
        effects.writes += 1;
        record = next;
      }),
    resolve: () => Effect.succeed(backend),
    boot: (
      artifact: Backend,
      priorStateSchema: Instance["stateSchema"],
      uiCheck: "run" | "reuse",
    ) =>
      Effect.sync(() => {
        boots.push([artifact, priorStateSchema]);
        uiChecks.push(uiCheck);
        return uiCheck === "run" ? { kind: "passed" as const } : null;
      }),
    abort: () =>
      Effect.sync(() => {
        effects.aborts += 1;
      }),
    purge: () =>
      Effect.sync(() => {
        effects.purges += 1;
      }),
    connect: () => Effect.fail(new Error("No invocation in lifecycle proof")),
  };
  return {
    instance: createAppInstance(ports),
    state,
    backend,
    effects,
    boots,
    uiChecks,
  };
}

it("passes null from the one fresh read to boot without preparing a receipt", async () => {
  const f = lifecycle();
  await Effect.runPromise(f.instance.prepare(f.state));
  expect(f.boots).toEqual([[f.backend, null]]);
  expect(f.effects).toEqual({ reads: 1, writes: 0, aborts: 0, purges: 0 });
  const applied = await Effect.runPromise(f.instance.apply(f.state));
  expect(applied.status).toBe("active");
  expect(f.boots).toEqual([
    [f.backend, null],
    [f.backend, null],
  ]);
  expect(f.effects.reads).toBe(2);
});

it("runs the UI check once, in prepare; apply proves construction again and reuses that result", async () => {
  // One result per Release and check version: apply never opens a second
  // browser session for a UI result nobody reads.
  const f = lifecycle();
  await expect(Effect.runPromise(f.instance.prepare(f.state))).resolves.toEqual(
    {
      kind: "passed",
    },
  );
  await Effect.runPromise(f.instance.apply(f.state));
  expect(f.boots).toHaveLength(2);
  expect(f.uiChecks).toEqual(["run", "reuse"]);
});

it("reads initialized state for apply rather than reusing an earlier prepare snapshot", async () => {
  const f = lifecycle();
  const next = { ...f.state, authorityVersion: 2 };
  await Effect.runPromise(f.instance.prepare(next));
  expect(f.effects).toEqual({ reads: 1, writes: 0, aborts: 0, purges: 0 });
  // The actual lifecycle initializes state after prepare and before this apply.
  await Effect.runPromise(f.instance.apply(f.state));
  const applied = await Effect.runPromise(f.instance.apply(next));
  expect(applied.status).toBe("active");
  expect(applied.authorityVersion).toBe(2);
  expect(applied.stateSchema).toBe(1);
  expect(f.boots).toEqual([
    [f.backend, null],
    [f.backend, null],
    [f.backend, 1],
  ]);
  expect(f.effects.reads).toBe(3);
  const before = { ...f.effects };
  await Effect.runPromise(f.instance.prepare({ ...next, authorityVersion: 3 }));
  expect(f.boots.at(-1)).toEqual([f.backend, 1]);
  expect(f.effects).toEqual({ ...before, reads: before.reads + 1 });
});

it("passes null for an existing disabled Instance whose state was never initialized", async () => {
  const f = lifecycle();
  const disabled = await Effect.runPromise(
    f.instance.apply({ ...f.state, status: "disabled" }),
  );
  expect(disabled.stateSchema).toBeNull();
  expect(f.boots).toEqual([]);
  const next = { ...f.state, authorityVersion: 2 };
  const before = { ...f.effects };
  await Effect.runPromise(f.instance.prepare(next));
  expect(f.boots).toEqual([[f.backend, null]]);
  expect(f.effects).toEqual({ ...before, reads: before.reads + 1 });
  await Effect.runPromise(f.instance.apply(next));
  expect(f.boots).toEqual([
    [f.backend, null],
    [f.backend, null],
  ]);
  expect(f.effects.reads).toBe(3);
});

it("keeps a persisted zero schema initialized instead of treating it as fresh state", async () => {
  // The Instance row decoder admits zero, but a real verified candidate's
  // durableBackendSchema requires a positive schema. Existing migration policy
  // must refuse zero→one before boot, never silently choose a fresh constructor.
  const f = lifecycle(0);
  const next = { ...f.state, authorityVersion: 2 };
  await expect(
    Effect.runPromise(f.instance.prepare(next)),
  ).rejects.toMatchObject({ code: "state_schema_migration_unsupported" });
  await expect(Effect.runPromise(f.instance.apply(next))).rejects.toMatchObject(
    { code: "state_schema_migration_unsupported" },
  );
  expect(f.boots).toEqual([]);
  expect(f.effects).toEqual({ reads: 2, writes: 0, aborts: 0, purges: 0 });
});
