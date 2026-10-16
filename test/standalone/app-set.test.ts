import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeAppPublisherRecipe } from "@fungi.computer/oyster/build-contract";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installStandaloneAppSet,
  standaloneAppSet,
  type StarterAppSource,
} from "../../src/standalone/app-set.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("admits the installer's current Grove asset recipe through the canonical builder", () => {
  const grove = standaloneAppSet.find((app) => app.installationId === "grove");
  if (!grove) throw new Error("Grove must be in the standalone App set");
  const normalized = normalizeAppPublisherRecipe({
    appId: grove.appId,
    recipe: grove.recipe,
  });
  expect(normalized.recipe.format).toBe("assets");
  expect(normalized.recipe.assetBase).toBe("./");
});

for (const installationId of ["inkcap", "prints"]) {
  it(`builds ${installationId} as digest-pinned assets rather than inline HTML`, () => {
    const app = standaloneAppSet.find(
      (item) => item.installationId === installationId,
    );
    if (!app) throw new Error(`${installationId} must be installed`);
    const normalized = normalizeAppPublisherRecipe({
      appId: app.appId,
      recipe: app.recipe,
    });
    expect(normalized.recipe.format).toBe("assets");
    expect(normalized.recipe.assetBase).toBe("./");
  });
}

const requestBody = Schema.fromJsonString(
  Schema.Struct({
    appId: Schema.optional(Schema.String),
    sourceRevision: Schema.optional(Schema.String),
    installationId: Schema.optional(Schema.String),
    release: Schema.optional(Schema.Unknown),
  }),
);

const upstream = `git:${"a".repeat(40)}`;

const seedOf = (appId: string) =>
  `git:${appId.length.toString(16).padStart(40, "0")}`;

/**
 * An Oyster's owner routes for builds and installations over memory. Each
 * build answers `running` once, then `outcome(appId)`.
 */
function oyster(
  outcome: (appId: string) => "succeeded" | "failed" | "missing" = () =>
    "succeeded",
) {
  const calls: string[] = [];
  const jobs = new Map<string, { appId: string; reads: number }>();
  const route = (input: URL, init: RequestInit): Response => {
    const path = input.pathname;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
    const body = Schema.decodeUnknownSync(requestBody)(init.body ?? "{}");
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/api/builds" && init.method === "POST") {
      expect(body.sourceRevision).toBe(seedOf(body.appId ?? ""));
      const jobId = `build_${String(jobs.size)}`;
      jobs.set(jobId, { appId: body.appId ?? "", reads: 0 });
      return Response.json(
        { jobId, status: "running", detail: null, release: null },
        { status: 202 },
      );
    }
    const job = jobs.get(path.slice("/api/builds/".length));
    if (path.startsWith("/api/builds/") && job !== undefined) {
      job.reads += 1;
      const status = job.reads < 2 ? "running" : outcome(job.appId);
      if (status === "missing") return new Response(null, { status: 404 });
      return Response.json({
        jobId: path.slice("/api/builds/".length),
        status,
        detail: status === "failed" ? "Build exited with 1" : null,
        release: status === "succeeded" ? { appId: job.appId } : null,
      });
    }
    if (path === "/api/installations")
      return Response.json({}, { status: 201 });
    return new Response(null, { status: 500 });
  };
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) =>
    Promise.resolve(route(input, init)),
  );
  return calls;
}

const checkout = {
  kind: "checkout",
  directory: "/unused",
  revision: `git:${"a".repeat(40)}`,
} satisfies StarterAppSource;

const install = (published: string[], concurrency = 1) =>
  installStandaloneAppSet({
    source: checkout,
    concurrency,
    url: "https://oyster.test",
    key: "key",
    report: () => undefined,
    publish: (app) => {
      published.push(app.installationId);
      return Promise.resolve(
        Response.json({
          kind: "recorded",
          receipt: {
            seedRevision: seedOf(app.appId),
            sourceRevision: upstream,
          },
        }),
      );
    },
    pollMs: 1,
  });

it("publishes, builds on the Computer and installs each App's own Release, Tourtois first", async () => {
  const calls = oyster();
  const published: string[] = [];
  const results = await install(published);
  // Each installed Release is the one its own seed revision built.
  expect(
    results.map((result) => [result.installationId, result.seedRevision]),
  ).toEqual(
    standaloneAppSet.map((app) => [app.installationId, seedOf(app.appId)]),
  );
  expect(results.every((result) => result.sourceRevision === upstream)).toBe(
    true,
  );
  expect(published).toEqual(standaloneAppSet.map((app) => app.installationId));
  expect(published[0]).toBe("tourtois");
  const installs = calls.filter((call) => call === "POST /api/installations");
  expect(installs).toHaveLength(standaloneAppSet.length);
  // Each App is installed only after its own build settled.
  expect(calls.slice(0, 4)).toEqual([
    "POST /api/builds",
    "GET /api/builds/build_0",
    "GET /api/builds/build_0",
    "POST /api/installations",
  ]);
});

it.each([
  ["failed", "bonsai build failed: Build exited with 1"],
  ["missing", "bonsai build is missing (404)"],
] as const)(
  "stops at a build that %s, installing nothing after it",
  async (kind, message) => {
    const calls = oyster((appId) =>
      appId === "app_bonsai" ? kind : "succeeded",
    );
    await expect(install([])).rejects.toThrow(message);
    expect(
      calls.filter((call) => call === "POST /api/installations"),
    ).toHaveLength(1);
  },
);

it("gives up on a build that does not finish within its wait", async () => {
  oyster(() => "succeeded");
  await expect(
    installStandaloneAppSet({
      source: checkout,
      url: "https://oyster.test",
      key: "key",
      report: () => undefined,
      publish: (app) =>
        Promise.resolve(
          Response.json({
            kind: "existing",
            receipt: {
              seedRevision: seedOf(app.appId),
              sourceRevision: upstream,
            },
          }),
        ),
      concurrency: 1,
      pollMs: 1,
      waitMs: 0,
    }),
  ).rejects.toThrow("tourtois build did not finish");
});

it("cancels a build status read that hangs, within the build budget", async () => {
  const reads: AbortSignal[] = [];
  const route = (input: URL, init: RequestInit): Response => {
    if (input.pathname === "/api/builds")
      return Response.json(
        { jobId: "build_0", status: "running", detail: null, release: null },
        { status: 202 },
      );
    // Status headers arrive, then the body never does; real fetch errors a
    // body read when its request's signal aborts.
    const signal = init.signal;
    if (signal === undefined || signal === null)
      throw new Error("The status read carries no signal");
    reads.push(signal);
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => {
            controller.error(signal.reason);
          });
        },
      }),
    );
  };
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) =>
    Promise.resolve(route(input, init)),
  );
  const started = Date.now();
  await expect(
    installStandaloneAppSet({
      source: checkout,
      url: "https://oyster.test",
      key: "key",
      report: () => undefined,
      publish: (app) =>
        Promise.resolve(
          Response.json({
            kind: "recorded",
            receipt: {
              seedRevision: seedOf(app.appId),
              sourceRevision: upstream,
            },
          }),
        ),
      concurrency: 1,
      pollMs: 1,
      waitMs: 200,
    }),
  ).rejects.toThrow("tourtois build did not finish (build_0)");
  expect(reads).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("runs builds two at a time on the one Computer, Tourtois first, and reports the Computer's phases", async () => {
  let running = 0;
  let most = 0;
  const started: string[] = [];
  const jobs = new Map<string, { appId: string; reads: number }>();
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const body = Schema.decodeUnknownSync(requestBody)(init.body ?? "{}");
    if (input.pathname === "/api/builds") {
      const jobId = `build_${String(jobs.size)}`;
      jobs.set(jobId, { appId: body.appId ?? "", reads: 0 });
      started.push(body.appId ?? "");
      running += 1;
      most = Math.max(most, running);
      return Promise.resolve(
        Response.json(
          { jobId, status: "running", detail: null, release: null },
          { status: 202 },
        ),
      );
    }
    const jobId = input.pathname.slice("/api/builds/".length);
    const job = jobs.get(jobId);
    if (job !== undefined) {
      job.reads += 1;
      if (job.reads < 3)
        return Promise.resolve(
          Response.json({
            jobId,
            status: "running",
            detail: null,
            release: null,
          }),
        );
      running -= 1;
      return Promise.resolve(
        Response.json({
          jobId,
          status: "succeeded",
          detail: JSON.stringify({
            phasesMs: { clone: 1, install: 20, build: 30, upload: 4 },
          }),
          release: { appId: job.appId },
        }),
      );
    }
    return Promise.resolve(Response.json({}, { status: 201 }));
  });
  const results = await install([], 2);
  expect(most).toBe(2);
  expect(started[0]).toBe("app_tourtois");
  expect(results.map((result) => result.installationId)).toEqual(
    standaloneAppSet.map((app) => app.installationId),
  );
  expect(results[0]?.timings.computer).toEqual({
    clone: 1,
    install: 20,
    build: 30,
    upload: 4,
  });
});

it("refuses more than three builds at once on one Computer", async () => {
  await expect(install([], 4)).rejects.toThrow(
    "Starter builds run 1 to 3 at a time",
  );
});

it("clones each App's own repository and roots its recipe there", async () => {
  oyster();
  const base = mkdtempSync(join(tmpdir(), "starter-repositories-"));
  try {
    for (const app of standaloneAppSet) {
      const work = join(base, `${app.repository}-work`);
      mkdirSync(work);
      writeFileSync(join(work, "package.json"), "{}\n");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: work, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("add", "package.json");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-q",
        "-m",
        "App",
      );
      execFileSync("git", [
        "clone",
        "-q",
        "--bare",
        work,
        join(base, `${app.repository}.git`),
      ]);
    }
    const entries: string[] = [];
    await installStandaloneAppSet({
      source: {
        kind: "repositories",
        base: `file://${base}`,
        ref: "main",
        scratch: base,
      },
      url: "https://oyster.test",
      key: "key",
      report: () => undefined,
      publish: (app, located) => {
        entries.push(located.recipe.entry);
        expect(located.sourceRevision).toMatch(/^git:[0-9a-f]{40}$/u);
        return Promise.resolve(
          Response.json({
            kind: "recorded",
            receipt: {
              seedRevision: seedOf(app.appId),
              sourceRevision: upstream,
            },
          }),
        );
      },
      pollMs: 1,
    });
    expect(entries).toEqual([
      "index.html",
      "web/index.html",
      "index.html",
      "index.html",
      "index.html",
      "index.html",
      "index.html",
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
