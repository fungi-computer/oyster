import * as Schema from "effect/Schema";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  appBuildRecipe,
  readBuildManifest,
} from "../../src/build/workspace-build.js";
import { normalizeAppPublisherRecipe } from "@fungi.computer/oyster/build-contract";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { text } from "node:stream/consumers";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSigilName } from "@fungi.computer/sigils";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import * as Result from "effect/Result";
import {
  applyInstallationCommand,
  declaredOperationsSchema,
  installationCommandSchema,
  installationSchema,
  type Installation,
} from "../../src/apps/installation.js";
import {
  installStandaloneAppSet,
  standaloneAppSet,
  type StarterAppSource,
  type StarterApp,
} from "../../src/standalone/app-set.js";
import {
  installationOperationSchema,
  type InstallationOperation,
} from "../../src/installation-operations.js";
import {
  installOnOyster,
  InstallationObservationError,
} from "../../src/installation-client.js";
import type { UiBootCheckOutcome } from "../../src/boot-gate.js";
import { instanceIds } from "../../src/instance-id.js";
import {
  olderOysterStoreCode,
  olderOysterStoreMessage,
} from "../../src/older-oyster-store.js";

let isolatedHome: string;
beforeAll(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), "starter-home-"));
  const directory = join(isolatedHome, "checkout");
  mkdirSync(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: isolatedHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  git("init", "-q", "-b", "main");
  for (const app of standaloneAppSet) {
    mkdirSync(join(directory, app.directory), { recursive: true });
    writeFileSync(
      join(directory, app.directory, "package.json"),
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../..",
          app.directory,
          "package.json",
        ),
      ),
    );
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "App manifests",
  );
  checkout = {
    kind: "checkout",
    directory,
    revision: "git:" + git("rev-parse", "HEAD").trim(),
  };
});
beforeEach(() => {
  vi.stubEnv("HOME", isolatedHome);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

function recipeOf(app: StarterApp) {
  const metadata = readFileSync(
    resolve(import.meta.dirname, "../../../..", app.directory, "package.json"),
    "utf8",
  );
  return appBuildRecipe(readBuildManifest(metadata), app.directory);
}

it("admits the installer's current Grove asset recipe through the canonical builder", () => {
  const grove = standaloneAppSet.find((app) => app.installationId === "grove");
  if (!grove) throw new Error("Grove must be in the standalone App set");
  const normalized = normalizeAppPublisherRecipe({
    appId: grove.appId,
    recipe: recipeOf(grove),
  });
  expect(normalized.recipe.format).toBe("assets");
  expect(normalized.recipe.assetBase).toBe("./");
});

it("lists the seven standalone starter Apps, with Tourtois first", () => {
  expect(standaloneAppSet.map((app) => app.installationId)).toEqual([
    "tourtois",
    "bonsai",
    "shed",
    "inkcap",
    "trellis",
    "prints",
    "grove",
  ]);
});

for (const installationId of ["inkcap", "prints"]) {
  it(`builds ${installationId} as digest-pinned assets rather than inline HTML`, () => {
    const app = standaloneAppSet.find(
      (item) => item.installationId === installationId,
    );
    if (!app) throw new Error(`${installationId} must be installed`);
    const normalized = normalizeAppPublisherRecipe({
      appId: app.appId,
      recipe: recipeOf(app),
    });
    expect(normalized.recipe.format).toBe("assets");
    expect(normalized.recipe.assetBase).toBe("./");
  });
}

const appDeclaration = Schema.fromJsonString(
  Schema.Struct({
    fungi: Schema.Struct({
      app: Schema.Struct({ icon: Schema.optional(Schema.String) }),
    }),
  }),
);

for (const app of standaloneAppSet) {
  it(`${app.installationId} declares an icon the candidate builder admits`, () => {
    const { fungi } = Schema.decodeUnknownSync(appDeclaration)(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../..",
          app.directory,
          "package.json",
        ),
        "utf8",
      ),
    );
    // The builder refuses a candidate whose icon names no registered Sigil.
    expect(fungi.app.icon === undefined || isSigilName(fungi.app.icon)).toBe(
      true,
    );
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

const artifactDigest = `sha256:${"b".repeat(64)}`;
const operationsDigest = `sha256:${"c".repeat(64)}`;
const builtRelease = (appId: string) =>
  Schema.decodeUnknownSync(releaseSchema)({
    appId,
    releaseId: `rel_${appId.slice(4)}`,
    artifact: {
      artifactRef: `artifact:${appId}`,
      artifactDigest,
      provenance: {
        sourceRevision: upstream,
        sourceTreeDigest: artifactDigest,
        buildRecipeDigest: artifactDigest,
      },
    },
  });
const defaultDeclaration = Schema.decodeUnknownSync(appDeclarationSchema)({
  capabilities: ["computer.readFile", "team.workbenchHost"],
  handlers: [],
  roles: [],
  commands: [],
  gills: [],
});
const operations = declaredOperationsSchema.parse({
  artifactDigest,
  digest: operationsDigest,
  anonymousMethods: [],
  capabilities: [
    {
      capability: "computer.readFile",
      operations: ["route:computer.readFile:open"],
    },
    { capability: "team.workbenchHost", operations: [] },
  ],
});
const approvalBody = Schema.Struct({
  storeGeneration: Schema.NonEmptyString,
  authorityVersion: Schema.Number,
  artifactDigest: Schema.String,
  command: Schema.Unknown,
});

/** Modeled owner transport backed by the real Installation/grant reducer. */
function starterRegistry(
  uiCheckFor: (installationId: string) => UiBootCheckOutcome = () => ({
    kind: "passed",
  }),
) {
  const records = new Map<string, Installation>();
  // Client fixture receipts are explicit operation evidence, not directory
  // projections. Real prepare/apply lifetime is qualified by owner/host tests.
  const receipts = new Map<string, InstallationOperation>();
  const approvals: unknown[] = [];
  const reduce = (
    installationId: string,
    command: Parameters<typeof applyInstallationCommand>[1],
    expectedVersion = records.get(installationId)?.authority.authorityVersion ??
      null,
  ) => {
    const current = records.get(installationId) ?? null;
    const outcome = applyInstallationCommand(
      command.kind === "install" ? null : current,
      command,
      {
        by: { kind: "member", memberId: "owner" },
        role: "owner",
        expectedVersion: command.kind === "install" ? null : expectedVersion,
        declaration: defaultDeclaration,
        declaredOperations: operations,
        now: 1,
        identity: {
          installationId,
          instanceId: current?.instanceId ?? instanceIds.instance.generate(),
        },
      },
    );
    if (Result.isSuccess(outcome))
      records.set(installationId, outcome.success.next);
    return outcome;
  };
  const route = (input: URL, init: RequestInit): Response => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
    if (input.pathname === "/api/installations") {
      if (init.method === "GET") return Response.json([...records.values()]);
      const body = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            installationId: Schema.String,
            release: releaseSchema,
          }),
        ),
      )(init.body ?? "");
      const requestId = new Headers(init.headers).get("Idempotency-Key");
      if (requestId === null)
        throw new Error("Installation correlation missing");
      const reminted = records.get(body.installationId)?.status === "deleted";
      const installationId =
        records.get(body.installationId)?.status === "deleted"
          ? `${body.installationId}-fixtureunique`
          : body.installationId;
      const current = records.get(installationId);
      const fresh = current === undefined || current.status === "deleted";
      const outcome = reduce(installationId, {
        kind: fresh ? "install" : "select-release",
        release: body.release,
        releasePin: "pinned",
      });
      const pending = installationOperationSchema.parse({
        requestId,
        requestedInstallationId: body.installationId,
        installationId,
        release: body.release,
        state: "pending",
      });
      receipts.set(
        requestId,
        installationOperationSchema.parse(
          Result.isFailure(outcome)
            ? {
                ...pending,
                state: "refused",
                status: 409,
                code: outcome.failure.code,
              }
            : {
                ...pending,
                state: "succeeded",
                installation: outcome.success.next,
                reference: {
                  generation: "fixture-generation",
                  instanceId: outcome.success.next.instanceId,
                  authorityVersion:
                    outcome.success.next.authority.authorityVersion,
                  status: outcome.success.next.status,
                },
                creation: reminted
                  ? "reminted"
                  : fresh
                    ? "fresh"
                    : "replacement",
                uiCheck: uiCheckFor(body.installationId),
              },
        ),
      );
      return Response.json(pending, { status: 202 });
    }
    if (input.pathname.endsWith("/status")) {
      const receipt = receipts.get(input.searchParams.get("requestId") ?? "");
      return receipt === undefined
        ? new Response(null, { status: 404 })
        : Response.json(receipt);
    }
    const installationId = input.pathname.split("/")[3];
    const current =
      installationId === undefined ? undefined : records.get(installationId);
    if (!current || installationId === undefined)
      return new Response(null, { status: 404 });
    if (init.method === "GET")
      return Response.json({
        storeGeneration: "fixture-generation",
        installationId,
        appId: current.appId,
        appName: installationId,
        artifactDigest: current.release.artifact.artifactDigest,
        permissions: {
          authority: current.authority,
          declaredOperations: operations,
        },
      });
    const body = Schema.decodeUnknownSync(Schema.fromJsonString(approvalBody))(
      init.body ?? "",
    );
    approvals.push(body);
    if (
      body.storeGeneration !== "fixture-generation" ||
      body.artifactDigest !== current.release.artifact.artifactDigest
    )
      return new Response(null, { status: 409 });
    // The same maintained command decoder and reducer own this modeled endpoint.
    const command = installationCommandSchema.parse(body.command);
    const outcome = reduce(installationId, command, body.authorityVersion);
    return Result.isFailure(outcome)
      ? Response.json(outcome.failure, { status: 409 })
      : Response.json(outcome.success.next);
  };
  return { records, approvals, receipts, reduce, route };
}

/**
 * An Oyster's owner routes for builds and installations over memory. Each
 * build answers `running` once, then `outcome(appId)`.
 */
function oyster(
  outcome: (appId: string) => "succeeded" | "failed" | "missing" = () =>
    "succeeded",
  registry = starterRegistry(),
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
        release: status === "succeeded" ? builtRelease(job.appId) : null,
      });
    }
    return registry.route(input, init);
  };
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) =>
    Promise.resolve(route(input, init)),
  );
  return calls;
}

let checkout: Extract<StarterAppSource, { kind: "checkout" }>;

const install = (
  published: string[],
  concurrency = 1,
  waitMs?: number,
  report: (message: string) => void = () => undefined,
) =>
  installStandaloneAppSet({
    source: checkout,
    concurrency,
    url: "https://oyster.test",
    key: "key",
    report,
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
    waitMs,
  });

it("does not treat an edge 502 as the outcome of a replacement installation", async () => {
  // The original diagnostic RED is preserved at 55419c46. This now observes
  // explicit correlated fixture receipts, not directory matches. It remains a
  // client transport proof, not real host prepare/apply lifetime acceptance.
  // Use an existing dashboard so a lost acknowledgement cannot justify fresh
  // consent, even though this fixture knows its replacement was committed.
  const registry = starterRegistry();
  const initial = registry.reduce("tourtois", {
    kind: "install",
    release: builtRelease("app_tourtois"),
    releasePin: "pinned",
  });
  expect(Result.isSuccess(initial)).toBe(true);
  const version = registry.records.get("tourtois")?.authority.authorityVersion;
  const jobs = new Map<string, string>();
  const handlerErrors: unknown[] = [];
  let lostAcknowledgement = false;
  let replacementPosts = 0;
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const input = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await text(request);
    const init: RequestInit = {
      method: request.method,
      headers: {
        authorization: request.headers.authorization ?? "",
        "Idempotency-Key": String(request.headers["idempotency-key"] ?? ""),
      },
      body: body || undefined,
    };
    let reply: Response;
    if (input.pathname === "/api/builds" && request.method === "POST") {
      const decoded = Schema.decodeUnknownSync(requestBody)(body);
      if (decoded.appId === undefined) throw new Error("Build App missing");
      const jobId = `build_${String(jobs.size)}`;
      jobs.set(jobId, decoded.appId);
      reply = Response.json(
        { jobId, status: "running", detail: null, release: null },
        { status: 202 },
      );
    } else if (input.pathname.startsWith("/api/builds/")) {
      const jobId = input.pathname.slice("/api/builds/".length);
      const appId = jobs.get(jobId);
      if (appId === undefined) throw new Error("Build missing");
      reply = Response.json({
        jobId,
        status: "succeeded",
        detail: null,
        release: builtRelease(appId),
      });
    } else {
      reply = registry.route(input, init);
      if (
        input.pathname === "/api/installations" &&
        request.method === "POST"
      ) {
        const decoded = Schema.decodeUnknownSync(requestBody)(body);
        if (decoded.installationId === "tourtois") replacementPosts += 1;
        if (!lostAcknowledgement) {
          if (reply.status !== 202)
            throw new Error("Replacement was not admitted");
          lostAcknowledgement = true;
          // The edge loses the upstream reply; the native fetch receives an
          // ordinary non-JSON 502, not a thrown or mocked transport exception.
          reply = new Response("<html>Bad Gateway</html>", { status: 502 });
        }
      }
    }
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    response.end(new Uint8Array(await reply.arrayBuffer()));
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      handlerErrors.push(error);
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Number }),
    )(server.address());
    const result = await installStandaloneAppSet({
      source: checkout,
      url: `http://127.0.0.1:${String(address.port)}`,
      key: "key",
      concurrency: 1,
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
      idle: () => Promise.resolve(),
    }).then(
      (value) => ({ kind: "completed" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    expect(handlerErrors).toEqual([]);
    expect(lostAcknowledgement).toBe(true);
    expect(replacementPosts).toBe(1);
    expect(registry.records.get("tourtois")?.authority.authorityVersion).toBe(
      (version ?? 0) + 1,
    );
    expect(registry.approvals).toEqual([]);
    if (result.kind === "rejected") throw result.error;
    expect(result.value.installed).toHaveLength(standaloneAppSet.length);
    expect(result.value.failed).toEqual([]);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
      server.closeAllConnections();
    });
  }
});

it("recovers a lost fresh acknowledgement only through the owner's creation receipt, without consent replay", async () => {
  const registry = starterRegistry();
  const calls = oyster(() => "succeeded", registry);
  const transport = fetch;
  let lost = false;
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const response = await transport(input, init);
    if (
      !lost &&
      input.pathname === "/api/installations" &&
      init.method === "POST"
    ) {
      lost = true;
      throw new TypeError("Install acknowledgement lost");
    }
    return response;
  });
  await install([]);
  expect(lost).toBe(true);
  expect(registry.approvals).toHaveLength(1);
  expect(
    calls.filter((call) => call === "POST /api/installations"),
  ).toHaveLength(standaloneAppSet.length);
  await install([]);
  expect(registry.approvals).toHaveLength(1);
});

it.each(["unavailable", "wrong-version", "generation"] as const)(
  "never approves defaults from a historical fresh completion with %s state",
  async (change) => {
    const registry = starterRegistry();
    const calls = oyster(() => "succeeded", registry);
    const transport = fetch;
    vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
      const response = await transport(input, init);
      if (
        change === "generation" &&
        input.pathname.endsWith("/grants") &&
        init.method === "GET"
      ) {
        const projection = Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Json),
        )(await response.json());
        return Response.json({
          ...projection,
          storeGeneration: "recreated-generation",
        });
      }
      if (!input.pathname.endsWith("/status") || change === "generation")
        return response;
      const operation = installationOperationSchema.parse(
        await response.json(),
      );
      if (operation.state !== "succeeded" || operation.installation === null)
        throw new Error("Fresh completion missing");
      const newer = installationSchema.parse({
        ...operation.installation,
        authority: {
          ...operation.installation.authority,
          authorityVersion: operation.reference.authorityVersion + 1,
        },
      });
      registry.records.set(operation.installationId, newer);
      return Response.json({
        ...operation,
        installation: change === "unavailable" ? null : newer,
      });
    });
    const result = await install([]);
    expect(result.failed[0]?.reason).toContain(
      change === "unavailable"
        ? "completed installation version is unavailable"
        : change === "generation"
          ? "approval snapshot changed"
          : "Installation outcome unconfirmed",
    );
    expect(registry.approvals).toEqual([]);
    expect(
      calls.filter(
        (call) => call.startsWith("PUT ") && call.endsWith("/grants"),
      ),
    ).toEqual([]);
  },
);

it("does not complete from a directory row while the correlated receipt is pending", async () => {
  const registry = starterRegistry();
  const calls = oyster(() => "succeeded", registry);
  const transport = fetch;
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  let held = true;
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const response = await transport(input, init);
    if (input.pathname.endsWith("/status") && held) {
      const receipt = installationOperationSchema.parse(await response.json());
      return Response.json({
        requestId: receipt.requestId,
        requestedInstallationId: receipt.requestedInstallationId,
        installationId: receipt.installationId,
        release: receipt.release,
        state: "pending",
      });
    }
    return response;
  });
  let completed = false;
  const observing = installOnOyster({
    url: "https://oyster.test",
    key: "key",
    installationId: "tourtois",
    release: builtRelease("app_tourtois"),
    idle: async () => {
      entered.resolve(undefined);
      await gate.promise;
    },
  }).then((value) => {
    completed = true;
    return value;
  });
  try {
    await entered.promise;
    expect(registry.records.has("tourtois")).toBe(true);
    expect(completed).toBe(false);
    expect(registry.approvals).toEqual([]);
    held = false;
    gate.resolve(undefined);
    expect((await observing).state).toBe("succeeded");
    expect(
      calls.filter((call) => call === "POST /api/installations"),
    ).toHaveLength(1);
  } finally {
    held = false;
    gate.resolve(undefined);
    await observing;
  }
});

it("honors the caller signal without a hidden authority-grant timer", async () => {
  oyster();
  const transport = fetch;
  const controller = new AbortController();
  const signals: (AbortSignal | null | undefined)[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    signals.push(init.signal);
    return transport(input, init);
  });
  try {
    expect(
      (
        await installOnOyster({
          url: "https://oyster.test",
          key: "key",
          installationId: "tourtois",
          release: builtRelease("app_tourtois"),
          signal: controller.signal,
        })
      ).state,
    ).toBe("succeeded");
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
    expect(timeout).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

it("stops only observation when the caller cancels; the admitted receipt remains readable", async () => {
  const registry = starterRegistry();
  const calls = oyster(() => "succeeded", registry);
  const transport = fetch;
  const controller = new AbortController();
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const response = await transport(input, init);
    if (!input.pathname.endsWith("/status")) return response;
    const receipt = installationOperationSchema.parse(await response.json());
    return Response.json({
      requestId: receipt.requestId,
      requestedInstallationId: receipt.requestedInstallationId,
      installationId: receipt.installationId,
      release: receipt.release,
      state: "pending",
    });
  });
  // Attach rejection observation before releasing the controlled cancellation.
  const observed = installOnOyster({
    url: "https://oyster.test",
    key: "key",
    installationId: "tourtois",
    release: builtRelease("app_tourtois"),
    signal: controller.signal,
    idle: async () => {
      entered.resolve(undefined);
      await gate.promise;
    },
  }).then(
    (operation) => ({ kind: "completed", operation }),
    (error: unknown) => ({ kind: "observation-stopped", error }),
  );
  try {
    await entered.promise;
    controller.abort();
    gate.resolve(undefined);
    const outcome = await observed;
    expect(outcome).toMatchObject({ kind: "observation-stopped" });
    if (!("error" in outcome))
      throw new Error("Observer unexpectedly completed");
    expect(outcome.error).toBeInstanceOf(InstallationObservationError);
    expect([...registry.receipts.values()]).toMatchObject([
      { state: "succeeded" },
    ]);
    expect(
      calls.filter((call) => call === "POST /api/installations"),
    ).toHaveLength(1);
    expect(registry.approvals).toEqual([]);
  } finally {
    controller.abort();
    gate.resolve(undefined);
    await observed;
  }
});

it.each(["refused", "unconfirmed"] as const)(
  "observes authoritative %s after an edge 502 without resubmitting",
  async (state) => {
    const registry = starterRegistry();
    const calls = oyster(() => "succeeded", registry);
    const transport = fetch;
    vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
      const response = await transport(input, init);
      if (input.pathname !== "/api/installations" || init.method !== "POST")
        return response;
      const pending = installationOperationSchema.parse(await response.json());
      registry.receipts.set(
        pending.requestId,
        installationOperationSchema.parse({
          ...pending,
          state,
          ...(state === "refused"
            ? { status: 422, code: "ui_mount_failed" }
            : { outcome: "interrupted" }),
        }),
      );
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    });
    const operation = await installOnOyster({
      url: "https://oyster.test",
      key: "key",
      installationId: "tourtois",
      release: builtRelease("app_tourtois"),
    });
    expect(operation.state).toBe(state);
    expect(
      calls.filter((call) => call === "POST /api/installations"),
    ).toHaveLength(1);
    expect(registry.approvals).toEqual([]);
  },
);

it("publishes, builds on the Computer and installs each App's own Release, Tourtois first", async () => {
  const calls = oyster();
  const published: string[] = [];
  const results = await install(published);
  // Each installed Release is the one its own seed revision built.
  expect(
    results.installed.map((result) => [
      result.installationId,
      result.seedRevision,
    ]),
  ).toEqual(
    standaloneAppSet.map((app) => [app.installationId, seedOf(app.appId)]),
  );
  expect(
    results.installed.every((result) => result.sourceRevision === upstream),
  ).toBe(true);
  expect(published).toEqual(standaloneAppSet.map((app) => app.installationId));
  expect(published[0]).toBe("tourtois");
  const installs = calls.filter((call) => call === "POST /api/installations");
  expect(installs).toHaveLength(standaloneAppSet.length);
  // Each App is installed only after its own build settled.
  expect(calls.slice(0, 7)).toEqual([
    "POST /api/builds",
    "GET /api/builds/build_0",
    "GET /api/builds/build_0",
    "POST /api/installations",
    "GET /api/installations/tourtois/status",
    "GET /api/installations/tourtois/grants",
    "PUT /api/installations/tourtois/grants",
  ]);
});

it("warns about each App whose recorded UI check did not pass, and still installs it", async () => {
  const registry = starterRegistry((installationId) =>
    installationId === "bonsai"
      ? {
          kind: "failed",
          code: "ui_mount_failed",
          diagnostics: {
            failedPredicate: "page_error",
            finalUrlPath: "/_boot/rel_bonsai/candidate/index.html",
            consoleErrors: ["\u001b[31mspoofed\u001b[0m"],
            pageErrors: [],
            failedRequests: [],
            droppedCount: 0,
          },
        }
      : installationId === "grove"
        ? { kind: "not_checked", code: "boot_runner_unavailable" }
        : { kind: "passed" },
  );
  oyster(() => "succeeded", registry);
  const reports: string[] = [];
  const results = await install([], 1, undefined, (message) =>
    reports.push(message),
  );
  expect(results.installed).toHaveLength(standaloneAppSet.length);
  expect(results.failed).toEqual([]);
  const warnings = reports.filter((line) => line.startsWith("Warning:")).sort();
  expect(warnings).toEqual([
    "Warning: bonsai is installed, but its UI check failed (ui_mount_failed: page_error).",
    "Warning: grove is installed, but its UI was not checked (boot_runner_unavailable).",
  ]);
});

it("provisions ordinary capabilities and approves shell access only for the chosen dashboard", async () => {
  const registry = starterRegistry();
  oyster(() => "succeeded", registry);
  await install([]);
  expect(registry.approvals).toHaveLength(1);
  for (const record of registry.records.values()) {
    const chosen = record.installationId === "tourtois";
    expect(
      record.authority.approvedGrants.map((grant) => grant.capability),
    ).toEqual(
      chosen
        ? ["computer.readFile", "team.workbenchHost"]
        : ["computer.readFile"],
    );
    expect(record.authority.authorityVersion).toBe(chosen ? 2 : 1);
  }
  expect(registry.approvals[0]).toMatchObject({
    storeGeneration: "fixture-generation",
    authorityVersion: 1,
    artifactDigest,
    command: { kind: "change-grants" },
  });
});

it("never reapproves existing, narrowed, revoked or tombstoned defaults on rerun", async () => {
  const registry = starterRegistry();
  oyster(() => "succeeded", registry);
  await install([]);
  expect(
    Result.isSuccess(
      registry.reduce("tourtois", {
        kind: "change-grants",
        changes: defaultDeclaration.capabilities.map((capability) => ({
          capability,
          grant: null,
        })),
      }),
    ),
  ).toBe(true);
  expect(
    Result.isSuccess(
      registry.reduce("bonsai", {
        kind: "change-grants",
        changes: [
          {
            capability: "computer.readFile",
            grant: {
              operations: ["route:computer.readFile:open"],
              resources: [{ kind: "computer", id: "chosen" }],
            },
          },
        ],
      }),
    ),
  ).toBe(true);
  expect(
    Result.isSuccess(
      registry.reduce("shed", { kind: "set-status", status: "deleted" }),
    ),
  ).toBe(true);
  expect(registry.records.get("shed")?.status).toBe("deleted");
  expect(
    Result.isSuccess(
      registry.reduce("trellis", { kind: "set-status", status: "disabled" }),
    ),
  ).toBe(true);
  registry.approvals.length = 0;
  const reinstalled = await install([]);
  expect(
    reinstalled.installed.find(
      (record) => record.installationId === "shed-fixtureunique",
    ),
  ).toBeDefined();
  expect(registry.approvals).toEqual([]);
  expect(registry.records.get("tourtois")?.authority.approvedGrants).toEqual(
    [],
  );
  expect(
    registry.records.get("bonsai")?.authority.approvedGrants[0]?.resources,
  ).toEqual([{ kind: "computer", id: "chosen" }]);
  expect(registry.records.get("shed")?.status).toBe("deleted");
  expect(registry.records.get("shed-fixtureunique")?.status).toBe("enabled");
  expect(
    registry.records
      .get("shed-fixtureunique")
      ?.authority.approvedGrants.map((row) => row.capability),
  ).not.toContain("team.workbenchHost");
  expect(registry.records.get("trellis")?.status).toBe("disabled");
});

it.each([
  "refused",
  "stale-cas",
  "changed-version",
  "changed-artifact",
  "malformed-projection",
  "lost-approval",
  "incomplete-receipt",
] as const)(
  "reports %s and never reapproves that existing record on rerun",
  async (fault) => {
    const registry = starterRegistry();
    const calls = oyster(() => "succeeded", registry);
    const transport = fetch;
    vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
      const path = input.pathname;
      if (path === "/api/installations/tourtois/grants") {
        if (init.method === "GET") {
          if (fault === "changed-version")
            registry.reduce("tourtois", {
              kind: "change-grants",
              changes: [{ capability: "team.workbenchHost", grant: null }],
            });
          if (fault === "malformed-projection") return Response.json({});
          if (fault === "changed-artifact") {
            const record = registry.records.get("tourtois");
            if (!record) throw new Error("Missing installed default");
            return Response.json({
              storeGeneration: "fixture-generation",
              installationId: "tourtois",
              appId: record.appId,
              appName: "tourtois",
              artifactDigest: `sha256:${"d".repeat(64)}`,
              permissions: {
                authority: record.authority,
                declaredOperations: operations,
              },
            });
          }
        } else {
          if (fault === "refused") return new Response(null, { status: 403 });
          if (fault === "stale-cas")
            registry.reduce("tourtois", {
              kind: "change-grants",
              changes: [{ capability: "team.workbenchHost", grant: null }],
            });
          const response = await transport(input, init);
          if (fault === "lost-approval")
            throw new TypeError("Approval response lost");
          if (fault === "incomplete-receipt") {
            const receipt = installationSchema.parse(await response.json());
            return Response.json({
              ...receipt,
              authority: {
                ...receipt.authority,
                approvedGrants: [],
                approval: null,
              },
            });
          }
          return response;
        }
      }
      return transport(input, init);
    });
    expect((await install([])).failed[0]?.installationId).toBe("tourtois");
    expect(registry.records.has("tourtois")).toBe(true);
    const grantReadsAndWrites = () =>
      calls.filter((call) =>
        call.endsWith("/api/installations/tourtois/grants"),
      );
    const atFailure = grantReadsAndWrites();
    const retained = registry.records.get("tourtois")?.authority.approvedGrants;
    // The next run may install other fresh defaults, but this one is not fresh.
    vi.stubGlobal("fetch", transport);
    await install([]);
    expect(grantReadsAndWrites()).toEqual(atFailure);
    expect(registry.records.get("tourtois")?.authority.approvedGrants).toEqual(
      retained,
    );
    expect(registry.approvals).toHaveLength(
      ["lost-approval", "incomplete-receipt", "stale-cas"].includes(fault)
        ? 1
        : 0,
    );
  },
);

it("uses owner creation evidence rather than an inventory preflight for consent", async () => {
  const registry = starterRegistry();
  registry.reduce("tourtois", {
    kind: "install",
    release: builtRelease("app_tourtois"),
    releasePin: "pinned",
  });
  oyster(() => "succeeded", registry);
  const transport = fetch;
  let inventories = 0;
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    if (input.pathname === "/api/installations" && init.method === "GET") {
      inventories++;
      return Promise.resolve(Response.json({}));
    }
    return transport(input, init);
  });
  await install([]);
  expect(inventories).toBe(0);
  expect(registry.approvals).toEqual([]);
});

it.each([
  "build-app",
  "install-identity",
  "install-artifact",
  "malformed-install",
] as const)("refuses %s before attempting approval", async (fault) => {
  const registry = starterRegistry();
  oyster(() => "succeeded", registry);
  const transport = fetch;
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const response = await transport(input, init);
    if (fault === "build-app" && input.pathname.startsWith("/api/builds/")) {
      const { status } = Schema.decodeUnknownSync(
        Schema.Struct({ status: Schema.String }),
      )(await response.clone().json());
      if (status === "succeeded")
        return Response.json({
          jobId: "build_0",
          status,
          detail: null,
          release: builtRelease("app_wrong"),
        });
    }
    if (input.pathname === "/api/installations" && init.method === "POST") {
      if (fault === "malformed-install")
        return Response.json({}, { status: 202 });
      const operation = installationOperationSchema.parse(
        await response.json(),
      );
      return Response.json(
        {
          ...operation,
          requestedInstallationId:
            fault === "install-identity"
              ? "wrong"
              : operation.requestedInstallationId,
          release: {
            ...operation.release,
            artifact: {
              ...operation.release.artifact,
              artifactDigest:
                fault === "install-artifact"
                  ? `sha256:${"d".repeat(64)}`
                  : operation.release.artifact.artifactDigest,
            },
          },
        },
        { status: 202 },
      );
    }
    return response;
  });
  expect((await install([])).failed[0]?.installationId).toBe("tourtois");
  expect(registry.approvals).toEqual([]);
  expect(registry.records.size).toBe(
    fault === "build-app" ? 0 : standaloneAppSet.length,
  );
});

it.each([
  ["failed", "bonsai build failed: Build exited with 1"],
  ["missing", "bonsai build is missing (404)"],
] as const)(
  "continues past a build that %s and reports the failed App",
  async (kind, message) => {
    const calls = oyster((appId) =>
      appId === "app_bonsai" ? kind : "succeeded",
    );
    const results = await install([], 1);
    expect(results.failed).toEqual([
      { installationId: "bonsai", reason: message },
    ]);
    expect(results.installed.map((result) => result.installationId)).toEqual(
      standaloneAppSet
        .filter((app) => app.installationId !== "bonsai")
        .map((app) => app.installationId),
    );
    expect(
      calls.filter((call) => call === "POST /api/installations"),
    ).toHaveLength(standaloneAppSet.length - 1);
  },
);

it("shows the older-store refusal instead of a bare publish failure", async () => {
  oyster(() => "succeeded");
  const result = await installStandaloneAppSet({
    source: checkout,
    url: "https://oyster.test",
    key: "key",
    report: () => undefined,
    publish: () =>
      Promise.resolve(
        Response.json(
          { error: olderOysterStoreCode, message: olderOysterStoreMessage },
          { status: 409 },
        ),
      ),
    concurrency: 1,
    pollMs: 1,
  });
  expect(result.failed[0]).toEqual({
    installationId: "tourtois",
    reason: olderOysterStoreMessage,
  });
});

it("gives up on a build that does not finish within its wait", async () => {
  oyster(() => "succeeded");
  const result = await installStandaloneAppSet({
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
  });
  expect(result.failed[0]?.reason).toContain("tourtois build did not finish");
});

it("cancels a build status read that hangs, within the build budget", async () => {
  const reads: AbortSignal[] = [];
  const route = (input: URL, init: RequestInit): Response => {
    if (input.pathname === "/api/installations") return Response.json([]);
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
  const result = await installStandaloneAppSet({
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
  });
  expect(result.failed[0]?.reason).toContain(
    "tourtois build did not finish (build_0)",
  );
  expect(reads).toHaveLength(standaloneAppSet.length);
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("runs builds two at a time on the one Computer, Tourtois first, and reports the Computer's phases", async () => {
  const registry = starterRegistry();
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
      // Hold the first build until the second really starts. Native Git metadata
      // reads can take longer than three poll ticks; that is not serialization.
      if (job.reads < 3 || started.length < 2)
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
          release: builtRelease(job.appId),
        }),
      );
    }
    return Promise.resolve(registry.route(input, init));
  });
  const results = await install([], 2, 2_000);
  expect(most).toBe(2);
  expect(started[0]).toBe("app_tourtois");
  expect(results.installed.map((result) => result.installationId)).toEqual(
    standaloneAppSet.map((app) => app.installationId),
  );
  expect(results.installed[0]?.timings.computer).toEqual({
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
      writeFileSync(
        join(work, "package.json"),
        readFileSync(
          resolve(
            import.meta.dirname,
            "../../../..",
            app.directory,
            "package.json",
          ),
        ),
      );
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
it("reads a build's status before its first idle wait", async () => {
  const calls: string[] = [];
  const registry = starterRegistry();
  let appId = "app_tourtois";
  // Every idle wait lands in the same log as the requests, so its place
  // relative to the first status read is exact.
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${input.pathname}`);
    const body = Schema.decodeUnknownSync(requestBody)(init.body ?? "{}");
    if (input.pathname === "/api/builds") {
      if (body.appId === undefined) throw new Error("Build App missing");
      appId = body.appId;
      return Promise.resolve(
        Response.json(
          { jobId: "build_0", status: "running", detail: null, release: null },
          { status: 202 },
        ),
      );
    }
    if (input.pathname.startsWith("/api/builds/"))
      return Promise.resolve(
        Response.json({
          jobId: "build_0",
          status: "succeeded",
          detail: null,
          release: builtRelease(appId),
        }),
      );
    return Promise.resolve(registry.route(input, init));
  });
  await installStandaloneAppSet({
    source: checkout,
    concurrency: 1,
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
    idle: () => {
      calls.push("sleep");
      return Promise.resolve();
    },
  });
  // Every build is already done at its first read, so nothing ever idles.
  expect(calls).not.toContain("sleep");
  expect(calls.slice(0, 4)).toEqual([
    "POST /api/builds",
    "GET /api/builds/build_0",
    "POST /api/installations",
    "GET /api/installations/tourtois/status",
  ]);
});

it("starts an App's build before unrelated Apps finish seeding", async () => {
  const events: string[] = [];
  const registry = starterRegistry();
  let appId = "app_tourtois";
  let tourtoisBuilding: () => void = () => undefined;
  const tourtoisBuild = new Promise<void>((resolveBuild) => {
    tourtoisBuilding = resolveBuild;
  });
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const body = Schema.decodeUnknownSync(requestBody)(init.body ?? "{}");
    if (input.pathname === "/api/builds") {
      if (body.appId === undefined) throw new Error("Build App missing");
      appId = body.appId;
      events.push(`build ${body.appId ?? ""}`);
      if (body.appId === "app_tourtois") tourtoisBuilding();
      return Promise.resolve(
        Response.json(
          { jobId: "build_0", status: "running", detail: null, release: null },
          { status: 202 },
        ),
      );
    }
    if (input.pathname.startsWith("/api/builds/"))
      return Promise.resolve(
        Response.json({
          jobId: "build_0",
          status: "succeeded",
          detail: null,
          release: builtRelease(appId),
        }),
      );
    return Promise.resolve(registry.route(input, init));
  });
  await installStandaloneAppSet({
    source: checkout,
    concurrency: 1,
    url: "https://oyster.test",
    key: "key",
    report: () => undefined,
    publish: async (app) => {
      // No later source finishes seeding until Tourtois has started building.
      if (app.installationId !== "tourtois") await tourtoisBuild;
      events.push(`seeded ${app.installationId}`);
      return Response.json({
        kind: "recorded",
        receipt: {
          seedRevision: seedOf(app.appId),
          sourceRevision: upstream,
        },
      });
    },
    pollMs: 1,
  });
  expect(events.slice(0, 3)).toEqual([
    "seeded tourtois",
    "build app_tourtois",
    "seeded bonsai",
  ]);
});

it("settles a build in flight and reports a failed seed", async () => {
  const events: string[] = [];
  const registry = starterRegistry();
  let appId = "app_tourtois";
  let tourtoisBuilding: () => void = () => undefined;
  const tourtoisBuild = new Promise<void>((resolveBuild) => {
    tourtoisBuilding = resolveBuild;
  });
  let seedFailed: () => void = () => undefined;
  const failed = new Promise<void>((resolveFailed) => {
    seedFailed = resolveFailed;
  });
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    const body = Schema.decodeUnknownSync(requestBody)(init.body ?? "{}");
    if (input.pathname === "/api/builds") {
      if (body.appId === undefined) throw new Error("Build App missing");
      appId = body.appId;
      events.push("build " + (body.appId ?? ""));
      tourtoisBuilding();
      return Response.json(
        { jobId: "build_0", status: "running", detail: null, release: null },
        { status: 202 },
      );
    }
    if (input.pathname.startsWith("/api/builds/")) {
      // Tourtois's build only finishes once the seed has already failed.
      await failed;
      events.push("build settled");
      return Response.json({
        jobId: "build_0",
        status: "succeeded",
        detail: null,
        release: builtRelease(appId),
      });
    }
    if (input.pathname === "/api/installations" && init.method === "POST")
      events.push("install");
    return registry.route(input, init);
  });
  const result = await installStandaloneAppSet({
    source: checkout,
    concurrency: 1,
    url: "https://oyster.test",
    key: "key",
    report: () => undefined,
    publish: async (app) => {
      if (app.installationId === "tourtois")
        return Response.json({
          kind: "recorded",
          receipt: {
            seedRevision: seedOf(app.appId),
            sourceRevision: upstream,
          },
        });
      await tourtoisBuild;
      events.push("seed failed " + app.installationId);
      seedFailed();
      return new Response(null, { status: 500 });
    },
    pollMs: 1,
  });
  expect(result.failed[0]).toEqual({
    installationId: "bonsai",
    reason: "bonsai source publish failed (500)",
  });
  expect(result.installed[0]?.installationId).toBe("tourtois");
  expect(events).toContain("build settled");
  const atReturn = [...events];
  // Nothing is left running behind the completed outcome.
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  expect(events).toEqual(atReturn);
});

it("settles an in-flight build and reports an approval failure", async () => {
  const registry = starterRegistry();
  const calls = oyster(() => "succeeded", registry);
  const transport = fetch;
  let startedSecond: () => void = () => undefined;
  const secondBuild = new Promise<void>((resolve) => {
    startedSecond = resolve;
  });
  let refusedFirst: () => void = () => undefined;
  const firstRefusal = new Promise<void>((resolve) => {
    refusedFirst = resolve;
  });
  vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
    if (input.pathname === "/api/builds" && init.method === "POST") {
      const body = Schema.decodeUnknownSync(requestBody)(init.body ?? "{}");
      if (body.appId === "app_bonsai") startedSecond();
    }
    if (input.pathname === "/api/builds/build_1") await firstRefusal;
    if (
      input.pathname === "/api/installations/tourtois/grants" &&
      init.method === "PUT"
    ) {
      await secondBuild;
      refusedFirst();
      return new Response(null, { status: 403 });
    }
    return transport(input, init);
  });
  const result = await install([], 2);
  expect(result.failed[0]).toEqual({
    installationId: "tourtois",
    reason: "tourtois approval failed (403)",
  });
  expect(calls.filter((call) => call === "POST /api/builds")).toHaveLength(
    standaloneAppSet.length,
  );
  expect(registry.records.get("bonsai")?.authority.authorityVersion).toBe(1);
  expect(registry.records.get("tourtois")?.authority.authorityVersion).toBe(1);
  const atRejection = [...calls];
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(calls).toEqual(atRejection);
});

it("uses committed App metadata rather than roster recipes or dirty files", async () => {
  oyster();
  const directory = mkdtempSync(join(tmpdir(), "starter-manifests-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  try {
    git("init", "-q", "-b", "main");
    for (const app of standaloneAppSet) {
      mkdirSync(join(directory, app.directory), { recursive: true });
      writeFileSync(
        join(directory, app.directory, "package.json"),
        JSON.stringify({
          fungi: {
            build: {
              entry: "committed.html",
              backend: null,
              maxOutputBytes: 1024,
            },
          },
        }),
      );
    }
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "App metadata",
    );
    const revision = "git:" + git("rev-parse", "HEAD").trim();
    writeFileSync(
      join(directory, "apps/tourtois/package.json"),
      "not committed JSON",
    );
    const entries: string[] = [];
    await installStandaloneAppSet({
      source: { kind: "checkout", directory, revision },
      url: "https://oyster.test",
      key: "key",
      report: () => undefined,
      publish: (app, located) => {
        entries.push(located.recipe.entry);
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
    expect(entries[0]).toBe("apps/tourtois/committed.html");
    expect(entries[1]).toBe("apps/bonsai/committed.html");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
