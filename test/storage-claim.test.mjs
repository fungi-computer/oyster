/* global Response */
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import { afterEach, it, vi } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createAppStorage } from "../dist/app-storage.js";
import { createOyster } from "../dist/host.js";
import { approvedInstallation } from "../dist/testing/index.js";
import { oysterStorageHandle } from "../dist/page/storage.js";
import { expectClaimConformance } from "../../agar/test/storage-claim-conformance.fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("settles two frames' concurrent claims through the Oyster host on one value with no refusal", async () => {
  const database = new DatabaseSync(":memory:");
  const native = fromNodeSqlite(database);
  const store = createAppStorage({
    sql: native.sql,
    commit: (body) =>
      Effect.try({
        try: () => native.transactionSync(body),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Commit unavailable", { cause }),
      }),
  });
  const installation = await approvedInstallation({
    installationId: "grove",
    instanceId: null,
    release: {
      appId: "app_grove",
      releaseId: "rel_grove",
      artifact: {
        artifactRef: `artifact:sha256-${"a".repeat(64)}`,
        artifactDigest: `sha256:${"a".repeat(64)}`,
        provenance: {
          sourceRevision: `git:${"a".repeat(40)}`,
          sourceTreeDigest: `sha256:${"a".repeat(64)}`,
          buildRecipeDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    },
    declaration: {
      capabilities: [],
      handlers: [],
      roles: [],
    },
  });
  const view = (installationId, ownerId) =>
    store.open(() =>
      Effect.succeed({
        address: installationId,
        appId: "app_grove",
        memberId: ownerId,
        membershipVersion: 1,
        isOwner: true,
        keys: [{ key: "first-session", scopes: ["member"], maxBytes: 1024 }],
        assertCurrent: () => undefined,
      }),
    );
  const run = (program) =>
    Effect.runPromise(
      program.pipe(
        Effect.match({
          onSuccess: (value) => ({ kind: "accepted", value }),
          onFailure: (cause) => ({
            kind: "rejected",
            code: cause.code,
          }),
        }),
      ),
    );
  const app = createOyster({
    tenantId: "default",
    auth: {
      authenticate: () =>
        Promise.resolve({
          kind: "admitted",
          principal: {
            actor: { kind: "member", memberId: "owner" },
            role: "owner",
          },
        }),
    },
    artifacts: {
      get: () => Promise.reject(new Error("Private Release read forbidden")),
      put: () => Promise.reject(new Error("Read only")),
    },
    installations: {
      list: () => Promise.resolve([installation]),
      get: (id) => Promise.resolve(id === "grove" ? installation : null),
    },
    instances: {
      get: () => {
        throw new Error("No Instance expected");
      },
    },
    workbench: {
      directory: () => Promise.resolve({ apps: [], roles: {} }),
      storage: (installationId, ownerId) => {
        const storage = view(installationId, ownerId);
        return {
          read: (key) => run(storage.read(key)),
          write: (input) => run(storage.write(input)),
          reset: (input) => run(storage.reset(input)),
          claim: (input) => run(storage.claim(input)),
          events: () =>
            Promise.resolve(new Response("event: ready\ndata: {}\n\n")),
        };
      },
    },
  });
  const statuses = [];
  vi.stubGlobal("fetch", async (input, init) => {
    const response = await app.request(input, init);
    statuses.push(response.status);
    return response;
  });
  try {
    await expectClaimConformance({
      first: oysterStorageHandle("grove"),
      second: oysterStorageHandle("grove"),
      key: "first-session",
      statuses: () => statuses,
    });
  } finally {
    database.close();
  }
});
