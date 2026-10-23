/* global Request, Response, console, DOMException */
// Guest Apps produce ordinary HTTP responses. They must never control the
// browser's Oyster session, origin policy, or service-worker scope.
import assert from "node:assert/strict";
import { withBackendConstruction } from "./boot-construction.fixture.ts";
import { test } from "node:test";
import { createOyster } from "../dist/host.js";
import { instanceIds } from "../dist/index.js";
import { failureDiagnostic } from "../dist/cause-class.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { registerHooks } from "node:module";
import { URL } from "node:url";
import * as Schema from "effect/Schema";
import {
  createInvocationGate,
  invocationFactsSchema,
  APP_INVOCATION_CEILING_MS,
} from "../dist/invocation.js";

const installation = {
  installationId: "guest",
  instanceId: instanceIds.instance.generate(),
  release: { appId: "app_guest", releaseId: "rel_guest" },
  authorityVersion: 1,
  status: "enabled",
};
const hostileHeaders = {
  "Set-Cookie": "oyster_session=guest; Path=/",
  "Set-Cookie2": "session=guest; Path=/",
  "Clear-Site-Data": '"*"',
  "Strict-Transport-Security": "max-age=0",
  "Public-Key-Pins": 'pin-sha256="guest"',
  "Service-Worker-Allowed": "/",
  "Content-Security-Policy": "default-src * 'unsafe-inline'",
  "Content-Security-Policy-Report-Only": "report-uri https://guest.invalid/",
  "Access-Control-Allow-Origin": "*",
  Location: "https://guest.invalid/",
  Refresh: "0;url=https://guest.invalid/",
  "X-Guest-Extension": "must not pass by default",
};
const guestResponse = () =>
  new Response("guest payload", {
    status: 202,
    headers: {
      ...hostileHeaders,
      "Content-Type": "text/plain",
      "Content-Language": "en",
    },
  });
async function server() {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    null,
  );
  const installed = await host.installations.get("context-probe");
  return createOyster({
    ...host,
    auth: {
      authenticate: async () => ({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
      }),
      login: async () =>
        new Response(null, {
          status: 303,
          headers: {
            "Set-Cookie": "host_session=trusted; Path=/",
            Location: "/",
          },
        }),
    },
    installations: {
      get: async () => ({ ...installed, installationId: "guest" }),
      list: async () => [{ ...installed, installationId: "guest" }],
    },
    instances: { get: () => ({ fetch: async () => guestResponse() }) },
  });
}
test("guest backend responses retain content but cannot set host headers", async () => {
  const response = await (
    await server()
  ).request("/apps/guest/backend", {
    method: "PUT",
    body: "input",
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "guest payload");
  assert.equal(response.headers.get("Content-Type"), "text/plain");
  assert.equal(response.headers.get("Content-Language"), "en");
  for (const name of Object.keys(hostileHeaders)) {
    if (name === "Content-Security-Policy") continue;
    assert.equal(response.headers.get(name), null, `guest controlled ${name}`);
  }
  assert.equal(
    response.headers.get("Content-Security-Policy"),
    "sandbox; default-src 'none'",
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const login = await (await server()).request("/login", { method: "POST" });
  assert.equal(login.headers.get("Set-Cookie"), "host_session=trusted; Path=/");
});

// The native loader is the system boundary: its configuration is what the
// runtime enforces, for both HTTP and RPC guest entrypoints.
const { DatabaseSync } = await import("node:sqlite");
const Effect = await import("effect/Effect");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: new URL("../dist/testing/workers-runtime.js", import.meta.url)
          .href,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { createCloudflareAppInstance } = await import("../dist/cloudflare.js");
hooks.deregister();
function nativeFixture(t, limits, initialFailure) {
  let failure = initialFailure;
  const aborts = [];
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const configurations = [];
  const ids = [];
  const selected = {
    instanceId: installation.instanceId,
    appId: "app_guest",
    releaseId: "rel_guest",
    authorityVersion: 1,
    owner: { kind: "installation", id: "guest" },
  };
  const context = {
    id: { name: selected.instanceId },
    storage: {
      sql: {
        exec: (query, ...args) => {
          const rows = database.prepare(query).all(...args);
          return { toArray: () => rows };
        },
      },
    },
    facets: {
      get: (_name, prepare) => {
        prepare();
        return {
          http: async () => {
            if (failure) throw failure;
            const response = guestResponse();
            return {
              status: response.status,
              statusText: response.statusText,
              headers: [...response.headers],
              body: response.body,
            };
          },
          invoke: async () => {
            if (failure) throw failure;
            return { kind: "ok", value: { ok: true } };
          },
        };
      },
      abort: (name, reason) => {
        aborts.push([name, reason]);
      },
      delete: () => undefined,
    },
  };
  const construction = withBackendConstruction(context.facets, {
    get: (id, configure) => {
      ids.push(id);
      configurations.push(configure());
      return { getDurableObjectClass: () => ({}) };
    },
  });
  const instance = createCloudflareAppInstance(
    { ...context, facets: construction.facets },
    construction.loader,
    () =>
      Effect.succeed({
        release: installation.release,
        digest: `sha256:${"a".repeat(64)}`,
        backend: {
          compatibilityDate: "2026-09-04",
          exportName: "Guest",
          code: "export class Guest {}",
          runtime: { kind: "durable-facet", stateSchema: 1 },
        },
      }),
    () => ({}),
    () => Promise.resolve(null),
    limits,
  );
  const gate = createInvocationGate({
    abortGuest: () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
  const run = (work) =>
    gate.run(
      Schema.decodeUnknownSync(invocationFactsSchema)({
        instanceId: selected.instanceId,
        selection: selected,
        artifactDigest: `sha256:${"a".repeat(64)}`,
        grants: [],
        ancestry: [],
        deadlineAt: Date.now() + APP_INVOCATION_CEILING_MS,
        subject: {
          kind: "call",
          context: {
            computerId: null,
            actor: { kind: "member", memberId: "owner" },
          },
        },
      }),
      {},
      (frame) => Effect.runPromise(work(frame)),
    );
  return {
    instance,
    selected,
    configurations,
    ids,
    aborts,
    probes: construction.probes,
    run,
    fail: (cause) => {
      failure = cause;
    },
  };
}

test("Instance HTTP responses also isolate host headers for non-Oyster callers", async (t) => {
  const { instance, selected, run } = nativeFixture(t);
  await Effect.runPromise(instance.apply({ ...selected, status: "enabled" }));
  const response = await run((frame) =>
    instance.fetch(frame, new Request("https://guest.internal/")),
  );
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Clear-Site-Data"), null);
  assert.equal(await response.text(), "guest payload");
});

test("guest HTTP and method execution use explicit safe CPU and subrequest limits", async (t) => {
  const { instance, selected, configurations, ids, probes, run } =
    nativeFixture(t);
  await Effect.runPromise(instance.apply({ ...selected, status: "enabled" }));
  await run((frame) =>
    instance.fetch(frame, new Request("https://guest.internal/")),
  );
  await run((frame) =>
    instance.call(
      frame,
      {
        methods: {
          read: {
            description: "Read",
            input: { type: "object" },
            output: { type: "object" },
            effect: "read",
            requires: [],
          },
        },
      },
      "read",
      {},
    ),
  );
  assert.equal(configurations.length, 3);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].name, "candidate");
  assert.match(probes[0].loaderId, /^boot:/);
  assert.equal(ids[0], probes[0].loaderId);
  assert.equal(probes[0].completed, true);
  assert.equal(probes[0].aborted, true);
  assert.equal(probes[0].deleted, true);
  for (const configuration of configurations) {
    assert.deepEqual(configuration.limits, { cpuMs: 1000, subRequests: 50 });
    assert.equal(configuration.globalOutbound, null);
  }
});

test("createOyster carries custom budgets through its Instance directory to the loader", async (t) => {
  let native;
  const host = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    null,
  );
  const installed = await host.installations.get("context-probe");
  const app = createOyster({
    ...host,
    guestLimits: { cpuMs: 25, subRequests: 3 },
    auth: {
      authenticate: async () => ({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
      }),
    },
    installations: {
      get: async () => ({ ...installed, installationId: "guest" }),
    },
    instances: {
      get: (_id, limits) => {
        native = nativeFixture(t, limits);
        return {
          fetch: async (_selection, request) => {
            await Effect.runPromise(
              native.instance.apply({ ...native.selected, status: "enabled" }),
            );
            return native.run((frame) => native.instance.fetch(frame, request));
          },
        };
      },
    },
  });
  assert.equal(
    (await app.request("/apps/guest/backend", { method: "PUT", body: "input" }))
      .status,
    202,
  );
  assert.equal(native.configurations.length, 2);
  assert.equal(native.probes.length, 1);
  assert.equal(native.probes[0].name, "candidate");
  assert.match(native.probes[0].loaderId, /^boot:/);
  assert.equal(native.ids[0], native.probes[0].loaderId);
  for (const configuration of native.configurations)
    assert.deepEqual(configuration.limits, { cpuMs: 25, subRequests: 3 });
});

test("different guest budgets cannot reuse the same loader cache entry", async (t) => {
  const a = nativeFixture(t, { cpuMs: 10, subRequests: 0 });
  const b = nativeFixture(t, { cpuMs: 20, subRequests: 1 });
  for (const fixture of [a, b]) {
    await Effect.runPromise(
      fixture.instance.apply({ ...fixture.selected, status: "enabled" }),
    );
    await fixture.run((frame) =>
      fixture.instance.fetch(frame, new Request("https://guest.internal/")),
    );
  }
  for (const fixture of [a, b]) {
    assert.equal(fixture.ids.length, 2);
    assert.equal(fixture.probes.length, 1);
    assert.equal(fixture.probes[0].name, "candidate");
    assert.match(fixture.probes[0].loaderId, /^boot:/);
    assert.equal(fixture.ids[0], fixture.probes[0].loaderId);
  }
  assert.notEqual(a.ids[0], b.ids[0]);
  assert.notEqual(a.ids[1], b.ids[1]);
  for (const configuration of a.configurations)
    assert.deepEqual(configuration.limits, { cpuMs: 10, subRequests: 0 });
  for (const configuration of b.configurations)
    assert.deepEqual(configuration.limits, { cpuMs: 20, subRequests: 1 });
});

test("invalid guest budgets fail closed before an Oyster can accept requests", () => {
  for (const guestLimits of [
    { cpuMs: 0 },
    { cpuMs: Infinity },
    { cpuMs: 1.5 },
    { subRequests: -1 },
    { subRequests: NaN },
  ]) {
    assert.throws(() => createOyster({ guestLimits }));
  }
});

test("backend fetch and call log only a closed cause class and preserve rejection", async (t) => {
  const privateName = new Error("synthetic private message");
  privateName.name = "synthetic private name";
  const cases = [
    [privateName, "Error"],
    [new TypeError("synthetic private message"), "TypeError"],
    [new RangeError("synthetic private message"), "RangeError"],
    [new SyntaxError("synthetic private message"), "SyntaxError"],
    [new DOMException("synthetic private message", "AbortError"), "AbortError"],
    [
      new DOMException("synthetic private message", "TimeoutError"),
      "TimeoutError",
    ],
    [
      new DOMException("synthetic private message", "synthetic private name"),
      "Other",
    ],
  ];
  const logs = [];
  t.mock.method(console, "error", (...args) => {
    logs.push(args);
  });
  for (const [cause, causeClass] of cases) {
    const { instance, selected, run } = nativeFixture(t, undefined, cause);
    await Effect.runPromise(instance.apply({ ...selected, status: "enabled" }));
    for (const operation of [
      (frame) => instance.fetch(frame, new Request("https://guest.internal/")),
      (frame) =>
        instance.call(
          frame,
          {
            methods: {
              read: {
                description: "Read",
                input: { type: "object" },
                output: { type: "object" },
                effect: "read",
                requires: [],
              },
            },
          },
          "read",
          {},
        ),
    ]) {
      logs.length = 0;
      await assert.rejects(run(operation), (error) => error === cause);
      assert.deepEqual(logs, [
        [
          "AppInstance failure",
          {
            stage: "backend_execution",
            code: "failed",
            causeClass,
            recycled: true,
          },
        ],
      ]);
      // The Instance's own failure log never reads text a guest produced.
      assert.deepEqual(failureDiagnostic(cause), { causeClass });
    }
  }
});

test("a failed guest invocation is retired so the next frame loads a fresh isolate", async (t) => {
  // Live 2026-10-15: after one Bonsai merge call was canceled mid-invocation
  // (and one Workflows runWorkflow failed), every later call on that Instance
  // failed until the Durable Object was evicted, because each new facet was
  // rebuilt from the same memoized Loader isolate.
  const stuck = new Error("synthetic stuck isolate");
  const fixture = nativeFixture(t, undefined, stuck);
  await Effect.runPromise(
    fixture.instance.apply({ ...fixture.selected, status: "enabled" }),
  );
  const read = (frame) =>
    fixture.instance.call(
      frame,
      {
        methods: {
          read: {
            description: "Read",
            input: { type: "object" },
            output: { type: "object" },
            effect: "read",
            requires: [],
          },
        },
      },
      "read",
      {},
    );
  const logs = [];
  t.mock.method(console, "error", (...args) => {
    logs.push(args);
  });
  // Applying the owner state already aborted the facet once.
  fixture.aborts.length = 0;
  await assert.rejects(fixture.run(read), (error) => error === stuck);
  assert.equal(fixture.aborts.length, 1);
  assert.equal(fixture.aborts[0][0], "app");
  fixture.fail(undefined);
  await fixture.run(read);
  await fixture.run(read);
  assert.equal(fixture.probes.length, 1);
  assert.equal(fixture.probes[0].completed, true);
  assert.equal(fixture.probes[0].aborted, true);
  assert.equal(fixture.probes[0].deleted, true);
  assert.equal(fixture.ids.length, 4);
  assert.equal(fixture.probes[0].name, "candidate");
  assert.match(fixture.probes[0].loaderId, /^boot:/);
  assert.equal(fixture.ids[0], fixture.probes[0].loaderId);
  // The healthy-path loader id is unchanged: instance, digest and budget only.
  assert.equal(
    fixture.ids[1],
    `${fixture.selected.instanceId}:sha256:${"a".repeat(64)}:1000:50`,
  );
  assert.notEqual(fixture.ids[2], fixture.ids[1]);
  // A healthy guest keeps its isolate; only failures rotate the loader id.
  assert.equal(fixture.ids[3], fixture.ids[2]);
  assert.equal(fixture.aborts.length, 1);
  assert.equal(logs.length, 1);
});

test("host-side Instance failures keep a bounded message and platform flags", () => {
  const platform = new Error("Too many subrequests.\nsecond line");
  Object.assign(platform, { remote: true, retryable: false, overloaded: true });
  assert.deepEqual(failureDiagnostic(platform), {
    causeClass: "Error",
    platform: ["remote", "overloaded"],
    message: "Too many subrequests.",
  });
  const long = new RangeError(`a\u0007${"x".repeat(400)}`);
  const bounded = failureDiagnostic(long);
  assert.equal(bounded.causeClass, "RangeError");
  assert.equal(bounded.message?.length, 240);
  assert.equal(bounded.message?.startsWith("a x"), true);
  assert.deepEqual(failureDiagnostic(new Error("")), { causeClass: "Error" });
  assert.deepEqual(failureDiagnostic("thrown text"), { causeClass: "Other" });
});

test("host method refusals forward only the available closed cause class", async (t) => {
  const host = await computerHost(
    { actor: { kind: "member", memberId: "owner" }, role: "owner" },
    null,
  );
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args);
  t.after(() => {
    console.error = original;
  });
  for (const causeClass of ["RangeError", undefined]) {
    const failure = {
      ok: false,
      code: "failed",
    };
    if (causeClass !== undefined) failure.causeClass = causeClass;
    const app = createOyster({
      ...host,
      instances: { get: () => ({ call: async () => failure }) },
    });
    const response = await app.request("/apps/context-probe/methods/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "App execution failed" });
    const diagnostic = { stage: "instance_execution", code: "failed" };
    if (causeClass !== undefined) diagnostic.causeClass = causeClass;
    assert.deepEqual(logs.at(-1), ["AppInstance failure", diagnostic]);
  }
});
