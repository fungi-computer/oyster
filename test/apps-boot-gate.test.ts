import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { parseReleaseId } from "@fungi.computer/puffball";
import {
  createAppInstance,
  instanceIds,
  type Backend,
  type Instance,
  type InstancePorts,
  type OwnerState,
} from "../src/index.js";
import { release } from "./apps-fixture.js";
import {
  BootGateError,
  bootCheckResultSchema,
  bootMountDiagnosticsSchema,
  uiBootCheckOutcomeSchema,
  type BootFailure,
} from "../src/boot-gate.js";
import {
  BACKEND_CONSTRUCTION_FACET,
  checkBackendConstruction,
} from "../src/boot-construction.js";
import { guestLimits } from "../src/guest-policy.js";
import { withBackendConstruction } from "./boot-construction.fixture.js";
import type {
  AppInstanceContext,
  AppInstanceLoader,
} from "../src/cloudflare.js";

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

it.each<BootFailure>([
  "backend_construction_failed",
  "ui_mount_failed",
  "boot_runner_unavailable",
  "boot_clone_unavailable",
  "boot_timeout",
  "boot_cleanup_failed",
])(
  "keeps the old selection live when the host gate refuses: %s",
  async (code) => {
    const instanceId = instanceIds.instance.generate();
    const state: OwnerState = {
      instanceId,
      owner: { kind: "installation", id: "notes" },
      appId: release.appId,
      releaseId: release.releaseId,
      authorityVersion: 1,
      status: "enabled",
    };
    let record: Instance | null = null;
    let aborts = 0;
    let broken = false;
    const ports: InstancePorts<undefined> = {
      instanceId,
      read: () => Effect.succeed(record),
      write: (next) =>
        Effect.sync(() => {
          record = next;
        }),
      resolve: (releaseId) =>
        Effect.succeed({
          ...backend,
          release: { ...backend.release, releaseId },
        }),
      boot: () =>
        broken
          ? Effect.fail(new BootGateError(code))
          : Effect.succeed({ kind: "passed" as const }),
      abort: () =>
        Effect.sync(() => {
          aborts += 1;
        }),
      purge: () => Effect.void,
      connect: () => Effect.fail(new Error("Not invoked by selection")),
    };
    const instance = createAppInstance(ports);
    await Effect.runPromise(instance.prepare(state));
    expect(record).toBeNull();
    expect(aborts).toBe(0);
    const old = await Effect.runPromise(instance.apply(state));
    const stopped = aborts;
    const next = {
      ...state,
      releaseId: parseReleaseId("rel_next"),
      authorityVersion: 2,
    };
    broken = true;
    await expect(
      Effect.runPromise(instance.prepare(next)),
    ).rejects.toMatchObject({ code });
    expect(record).toEqual(old);
    expect(aborts).toBe(stopped);
    await expect(Effect.runPromise(instance.apply(next))).rejects.toMatchObject(
      { code },
    );
    expect(await Effect.runPromise(instance.inspect())).toEqual(old);
    expect(aborts).toBe(stopped);
    broken = false;
    await Effect.runPromise(instance.prepare(next));
    expect(record).toEqual(old);
    expect(aborts).toBe(stopped);
    const accepted = await Effect.runPromise(instance.apply(next));
    expect(accepted.status).toBe("active");
    expect(accepted.authorityVersion).toBe(2);
    expect(accepted.releaseId).toBe(next.releaseId);
    expect(aborts).toBe(stopped + 1);
    // Invalid input must not trigger recovery of an interrupted deletion.
    record = { ...accepted, status: "deleting" };
    const deleting = record;
    const invalid = {
      ...next,
      instanceId: instanceIds.instance.generate(),
    };
    await expect(
      Effect.runPromise(instance.prepare(invalid)),
    ).rejects.toMatchObject({ code: "instance_identity_mismatch" });
    expect(record).toEqual(deleting);
    await expect(
      Effect.runPromise(instance.apply(invalid)),
    ).rejects.toMatchObject({ code: "instance_identity_mismatch" });
    expect(record).toEqual(deleting);
  },
);

function constructionFixture(
  artifact: Backend,
  options: {
    failConstruction?: boolean;
    failAbort?: boolean;
    failClone?: boolean;
    withoutClone?: boolean;
  } = {},
) {
  const loads: string[] = [];
  const configurations: WorkerLoaderWorkerCode[] = [];
  const cleaned: string[] = [];
  const copied: [string, string][] = [];
  const events: string[] = [];
  const ctx: Pick<AppInstanceContext<string>, "facets"> = {
    facets: {
      get: (name, prepare) => {
        events.push(`get:${name}`);
        expect(prepare()).toEqual({ class: "BootConstruction" });
        expect(name).not.toBe("app");
        return {
          fetch: () => Promise.resolve(new Response(null)),
          construct: () =>
            options.failConstruction
              ? Promise.reject(new Error("candidate-secret"))
              : Promise.resolve(),
        };
      },
      abort: (name) => {
        cleaned.push(`abort:${name}`);
        if (options.failAbort) throw new Error("abort unavailable");
      },
      delete: (name) => {
        events.push(`delete:${name}`);
        cleaned.push(`delete:${name}`);
      },
      clone: options.withoutClone
        ? undefined
        : (source: string, destination: string) => {
            events.push(`clone:${source}:${destination}`);
            copied.push([source, destination]);
            if (options.failClone) throw new Error("private-clone-failure");
          },
    },
  };
  const loader: AppInstanceLoader<string> = {
    get: (name, configure) => {
      loads.push(name);
      const worker = configure();
      configurations.push(worker);
      expect(worker.env).toEqual({});
      expect(worker.globalOutbound).toBeNull();
      expect(worker.modules["backend.js"]).toBe(artifact.backend.code);
      return { getDurableObjectClass: (exportName) => exportName };
    },
  };
  return { ctx, loader, loads, configurations, cleaned, copied, events };
}

it("uses one disposable sibling with distinct Loader identities and empty bindings", async () => {
  const fixture = constructionFixture(backend);
  await checkBackendConstruction(
    fixture.ctx,
    fixture.loader,
    backend,
    guestLimits(),
    null,
  );
  await checkBackendConstruction(
    fixture.ctx,
    fixture.loader,
    backend,
    guestLimits(),
    null,
  );
  expect(new Set(fixture.loads).size).toBe(2);
  for (const name of fixture.loads) {
    expect(name).toMatch(/^boot:/u);
  }
  expect(fixture.copied).toEqual([]);
  expect(fixture.cleaned).toEqual(
    Array.from({ length: 2 }, () => [
      `delete:${BACKEND_CONSTRUCTION_FACET}`,
      `abort:${BACKEND_CONSTRUCTION_FACET}`,
      `delete:${BACKEND_CONSTRUCTION_FACET}`,
    ]).flat(),
  );
});

it.each([0, 1])(
  "treats a non-null prior schema fact %s as initialized for construction",
  async (priorStateSchema) => {
    // Isolate the construction decision using a valid positive-schema backend.
    // Core owns compatibility and refuses zero→positive before calling boot;
    // this is not a claim that such a migration reaches construction.
    const fixture = constructionFixture(backend);
    await checkBackendConstruction(
      fixture.ctx,
      fixture.loader,
      backend,
      guestLimits(),
      priorStateSchema,
    );
    expect(fixture.copied).toEqual([["app", BACKEND_CONSTRUCTION_FACET]]);
    expect(fixture.events.slice(0, 2)).toEqual([
      `clone:app:${BACKEND_CONSTRUCTION_FACET}`,
      `get:${BACKEND_CONSTRUCTION_FACET}`,
    ]);
    expect(fixture.cleaned).toEqual([
      `abort:${BACKEND_CONSTRUCTION_FACET}`,
      `delete:${BACKEND_CONSTRUCTION_FACET}`,
    ]);
  },
);

it("clears a leftover sibling before a fresh probe even when clone is unavailable", async () => {
  const fixture = constructionFixture(backend, { withoutClone: true });
  await checkBackendConstruction(
    fixture.ctx,
    fixture.loader,
    backend,
    guestLimits(),
    null,
  );
  expect(fixture.events.slice(0, 2)).toEqual([
    `delete:${BACKEND_CONSTRUCTION_FACET}`,
    `get:${BACKEND_CONSTRUCTION_FACET}`,
  ]);
  expect(fixture.loads).toHaveLength(1);
  expect(fixture.copied).toEqual([]);
});

it("refuses initialized-state construction without clone instead of testing empty storage", async () => {
  const fixture = constructionFixture(backend, { withoutClone: true });
  await expect(
    checkBackendConstruction(
      fixture.ctx,
      fixture.loader,
      backend,
      guestLimits(),
      1,
    ),
  ).rejects.toMatchObject({
    code: "boot_clone_unavailable",
    message:
      "Host facet clone is unavailable; copy-seeded construction refused",
  });
  expect(fixture.loads).toEqual([]);
  expect(fixture.cleaned).toEqual([
    `abort:${BACKEND_CONSTRUCTION_FACET}`,
    `delete:${BACKEND_CONSTRUCTION_FACET}`,
  ]);
});

it("cleans a failed clone without opening a constructor or exposing runtime details", async () => {
  const fixture = constructionFixture(backend, { failClone: true });
  await expect(
    checkBackendConstruction(
      fixture.ctx,
      fixture.loader,
      backend,
      guestLimits(),
      1,
    ),
  ).rejects.toMatchObject({
    code: "backend_load_failed",
    message: "Candidate backend module could not load",
  });
  expect(fixture.loads).toEqual([]);
  expect(fixture.cleaned).toEqual([
    `abort:${BACKEND_CONSTRUCTION_FACET}`,
    `delete:${BACKEND_CONSTRUCTION_FACET}`,
  ]);
});

it("does not substitute a fresh probe when copied-state construction fails", async () => {
  const fixture = constructionFixture(backend, { failConstruction: true });
  await expect(
    checkBackendConstruction(
      fixture.ctx,
      fixture.loader,
      backend,
      guestLimits(),
      1,
    ),
  ).rejects.toMatchObject({ code: "backend_construction_failed" });
  expect(fixture.copied).toHaveLength(1);
  expect(fixture.loads).toHaveLength(1);
  expect(fixture.cleaned).toHaveLength(2);
});

it.each([
  { cpuMs: 25, subRequests: 3 },
  { cpuMs: 10, subRequests: 0 },
])("keeps the host's guest ceilings during construction: %j", async (input) => {
  const fixture = constructionFixture(backend);
  const limits = guestLimits(input);
  await checkBackendConstruction(
    fixture.ctx,
    fixture.loader,
    backend,
    limits,
    null,
  );
  expect(fixture.configurations).toHaveLength(1);
  expect(fixture.configurations[0]?.limits).toEqual(limits);
});

it("cleans a failed construction and exposes only the fixed host reason", async () => {
  const fixture = constructionFixture(backend, { failConstruction: true });
  await expect(
    checkBackendConstruction(
      fixture.ctx,
      fixture.loader,
      backend,
      guestLimits(),
      null,
    ),
  ).rejects.toMatchObject({
    code: "backend_construction_failed",
    message: "Candidate backend could not construct on App storage",
  });
  expect(fixture.cleaned).toHaveLength(3);
});

it("the Node fixture completes real construction with fresh SQLite each time", async () => {
  const candidate: Backend = {
    ...backend,
    backend: {
      ...backend.backend,
      code: 'export class Notes { constructor(ctx) { ctx.storage.sql.exec("CREATE TABLE constructor_probe (value TEXT)"); } }',
    },
  };
  const fixture = constructionFixture(candidate);
  const construction = withBackendConstruction(
    fixture.ctx.facets,
    fixture.loader,
  );
  for (let index = 0; index < 2; index++)
    await checkBackendConstruction(
      { facets: construction.facets },
      construction.loader,
      candidate,
      guestLimits(),
      null,
    );
  expect(construction.probes).toHaveLength(2);
  expect(new Set(fixture.loads).size).toBe(2);
  for (const probe of construction.probes)
    expect(probe).toMatchObject({
      name: BACKEND_CONSTRUCTION_FACET,
      completed: true,
      aborted: true,
      deleted: true,
    });
});

it.each([
  'constructor() { throw new Error("candidate constructor failed"); }',
  'constructor(ctx) { ctx.blockConcurrencyWhile(async () => { await Promise.resolve(); throw new Error("candidate initialization failed"); }); }',
])(
  "the Node fixture executes and awaits the candidate: %s",
  async (constructor) => {
    const candidate: Backend = {
      ...backend,
      backend: {
        ...backend.backend,
        code: `export class Notes { ${constructor} }`,
      },
    };
    const fixture = constructionFixture(candidate);
    const construction = withBackendConstruction(
      fixture.ctx.facets,
      fixture.loader,
    );
    await expect(
      checkBackendConstruction(
        { facets: construction.facets },
        construction.loader,
        candidate,
        guestLimits(),
        null,
      ),
    ).rejects.toMatchObject({ code: "backend_construction_failed" });
    expect(construction.probes).toHaveLength(1);
    expect(construction.probes[0]?.name).toBe(BACKEND_CONSTRUCTION_FACET);
    expect(construction.probes[0]).toMatchObject({
      limits: guestLimits(),
      completed: false,
      aborted: true,
      deleted: true,
    });
  },
);

it("still deletes the disposable facet when abort fails and refuses activation", async () => {
  const fixture = constructionFixture(backend, { failAbort: true });
  await expect(
    checkBackendConstruction(
      fixture.ctx,
      fixture.loader,
      backend,
      guestLimits(),
      null,
    ),
  ).rejects.toMatchObject({ code: "boot_cleanup_failed" });
  expect(fixture.cleaned).toHaveLength(3);
});

it("refuses a missing Loader without touching any facet", async () => {
  const fixture = constructionFixture(backend);
  await expect(
    checkBackendConstruction(
      fixture.ctx,
      undefined,
      backend,
      guestLimits(),
      null,
    ),
  ).rejects.toMatchObject({ code: "boot_runner_unavailable" });
  expect(fixture.loads).toEqual([]);
  expect(fixture.cleaned).toEqual([]);
});

it("distinguishes a host-skipped UI check from a runner result", () => {
  const outcome = {
    kind: "not_checked",
    code: "ui_check_not_run_on_host",
  } as const;
  expect(uiBootCheckOutcomeSchema.parse(outcome)).toEqual(outcome);
  expect(() => bootCheckResultSchema.parse(outcome)).toThrow();
});

it("rejects diagnostics on non-mount refusals and URL-bearing final paths", () => {
  const diagnostics = {
    failedPredicate: "candidate_not_mounted",
    finalUrlPath: "/_boot/rel_repro/candidate/index.html",
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    droppedCount: 0,
  };
  expect(() =>
    bootCheckResultSchema.parse({
      kind: "refused",
      code: "boot_cleanup_failed",
      diagnostics,
    }),
  ).toThrow();
  expect(() =>
    bootMountDiagnosticsSchema.parse({
      ...diagnostics,
      finalUrlPath: "https://attacker.invalid/path?token=private",
    }),
  ).toThrow();
});

it("accepts only the mount verdicts the boot page check can reach about the candidate", () => {
  const diagnostics = {
    finalUrlPath: "/_boot/rel_repro/candidate/index.html",
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    droppedCount: 0,
  };
  for (const failedPredicate of [
    "unexpected_candidate_request",
    "response_status",
    "request_failed",
    "page_error",
    "candidate_not_mounted",
  ])
    expect(
      bootMountDiagnosticsSchema.parse({ ...diagnostics, failedPredicate })
        .failedPredicate,
    ).toBe(failedPredicate);
  // The host page failing to load, and the retired Playwright runner's
  // stages, are never a verdict about the candidate.
  for (const failedPredicate of [
    "navigation_failed",
    "preflight_status",
    "response_without_request",
    "request_completion",
    "parent_response_status",
    "acquire",
    "connect",
    "lease",
    "navigate",
  ])
    expect(() =>
      bootMountDiagnosticsSchema.parse({ ...diagnostics, failedPredicate }),
    ).toThrow();
  expect(() =>
    bootMountDiagnosticsSchema.parse({
      ...diagnostics,
      failedPredicate: "request_failed",
      failedRequests: [{ path: "/x", failureKind: "preflight_status" }],
    }),
  ).toThrow();
});
