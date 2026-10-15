import { approvedInstallation } from "../dist/testing/index.js";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { instanceIds } from "@fungi.computer/oyster";
import type { Installation } from "@fungi.computer/oyster/apps";
import type { AppStorageAdmission } from "@fungi.computer/oyster/app-storage";
import { createOysterRootData } from "../src/root-data.js";

const release = Schema.decodeUnknownSync(releaseSchema)({
  appId: "app_notes",
  releaseId: "rel_notes",
  artifact: {
    artifactRef: "artifact:notes",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    provenance: {
      sourceRevision: `git:${"b".repeat(40)}`,
      sourceTreeDigest: `sha256:${"c".repeat(64)}`,
      buildRecipeDigest: `sha256:${"d".repeat(64)}`,
    },
  },
});
const declaration = Schema.decodeUnknownSync(appDeclarationSchema)({
  displayName: "Notes",
  icon: "Notebook",
  capabilities: ["app.storage"],
  handlers: ["file.open"],
  roles: ["files"],
  commands: [],
  gills: [],
  storage: [{ key: "desktop", scopes: ["team", "member"], maxBytes: 16384 }],
});

async function fixture(hasUi = true, declared = declaration) {
  const database = new DatabaseSync(":memory:");
  const sqlite = fromNodeSqlite(database);
  let installations: Installation[] = [
    await approvedInstallation({
      installationId: "notes",
      instanceId: instanceIds.instance.generate(),
      release,
      declaration,
    }),
  ];
  const options = {
    installations: { list: () => Promise.resolve(installations) },
    resolveRelease: () =>
      Promise.resolve({
        declaration: declared,
        ui: hasUi
          ? {
              kind: "html" as const,
              artifactRef: release.artifact.artifactRef,
              digest: release.artifact.artifactDigest,
            }
          : null,
      }),
    sql: sqlite.sql,
    commit: <A>(body: () => A) =>
      Effect.try({
        try: () => sqlite.transactionSync(body),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Commit failed", { cause }),
      }),
  };
  const root = createOysterRootData(options);
  return {
    root,
    database,
    installations: () => installations,
    replace: (next: Installation[]) => {
      installations = next;
    },
    reopen: () => createOysterRootData(options),
  };
}

await describe("standalone Oyster workbench data", async () => {
  await it("projects the installation and Release metadata without Hub administration", async () => {
    const { root, database } = await fixture();
    try {
      assert.deepEqual(await root.directory(), {
        apps: [
          {
            address: { kind: "installation", installationId: "notes" },
            installationId: "notes",
            surfaceId: "installation:notes",
            appId: "app_notes",
            displayName: "Notes",
            icon: "Notebook",
            releaseId: "rel_notes",
            authorityVersion: 1,
            enforcement: null,
            handlers: ["file.open"],
            roles: ["files"],
            declaredCapabilities: ["app.storage"],
            commands: [],
            gills: [],
            availability: "available",
            surface: { stableRoute: "/apps/notes/" },
            surfacePath: "/apps/notes/",
          },
        ],
        // No PUT route and no stored choice exist in standalone: per the ADR,
        // the first available listed App declaring a role is its effective
        // holder, and the choice is never "chosen".
        roles: {
          dashboard: { surfaceId: null, chosen: false },
          inbox: { surfaceId: null, chosen: false },
          files: { surfaceId: "installation:notes", chosen: false },
          media: { surfaceId: null, chosen: false },
          sessions: { surfaceId: null, chosen: false },
          terminal: { surfaceId: null, chosen: false },
        },
      });
    } finally {
      database.close();
    }
  });

  await it("reads live status, excludes deletions and uses canonical installation paths", async () => {
    const { root, database, installations, replace } = await fixture();
    try {
      const original = installations()[0];
      if (original === undefined) throw new Error("Installation missing");
      replace([
        {
          ...original,
          installationId: "notes-one",
          status: "disabled",
          authorityVersion: 2,
        },
        { ...original, installationId: "deleted", status: "deleted" },
      ]);
      const directory = await root.directory();
      assert.equal(directory.apps.length, 1);
      assert.partialDeepStrictEqual(directory.apps[0], {
        installationId: "notes-one",
        surfaceId: "installation:notes-one",
        authorityVersion: 2,
        availability: "unavailable",
        surface: null,
        surfacePath: "/apps/notes-one/",
      });
      replace([{ ...original, authorityVersion: 3 }]);
      assert.partialDeepStrictEqual((await root.directory()).apps[0], {
        authorityVersion: 3,
        availability: "available",
      });
    } finally {
      database.close();
    }
  });

  await it("does not advertise a backend-only App as a launchable surface or invent destinations", async () => {
    const { root, database } = await fixture(false);
    try {
      const directory = await root.directory();
      assert.partialDeepStrictEqual(directory.apps[0], {
        availability: "unavailable",
        surface: null,
      });
      // The only App declaring "files" is unavailable, so no App is its
      // effective holder.
      assert.deepEqual(directory.roles.files, {
        surfaceId: null,
        chosen: false,
      });
      assert.deepEqual(root.platformDestinations(), []);
    } finally {
      database.close();
    }
  });

  await it("uses the injected SQLite owner for desktop persistence, CAS and invalidation", async () => {
    const { root, database, reopen } = await fixture();
    let active = true;
    const authorize = () =>
      Effect.sync((): AppStorageAdmission => ({
        address: "installation:notes",
        appId: release.appId,
        memberId: "authenticated-owner",
        membershipVersion: 1,
        isOwner: true,
        keys: declaration.storage ?? [],
        assertCurrent: () => {
          if (!active) throw new Error("Owner admission revoked");
        },
      }));
    const view = root.storage.open(authorize);
    try {
      const value = {
        version: 1,
        items: [],
        launcher: { pinned: ["installation:notes"], hidden: [] },
      };
      const saved = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(view.events("desktop"));
            assert.deepEqual(Array.from(yield* pull), [null]);
            const written = yield* view.write({
              key: "desktop",
              scope: "member",
              basedOn: null,
              value,
            });
            assert.deepEqual(Array.from(yield* pull), [
              {
                appId: "app_notes",
                key: "desktop",
                scope: "member",
                revision: written.revision,
              },
            ]);
            return written;
          }),
        ),
      );
      const reopened = reopen().storage.open(authorize);
      assert.partialDeepStrictEqual(
        await Effect.runPromise(reopened.read("desktop")),
        {
          value,
          source: "member",
          member: { revision: saved.revision },
        },
      );
      await assert.rejects(
        Effect.runPromise(
          reopened.write({
            key: "desktop",
            scope: "member",
            basedOn: saved.revision + 1,
            value: {},
          }),
        ),
        { code: "conflict" },
      );
      active = false;
      await assert.rejects(Effect.runPromise(view.read("desktop")), {
        code: "unavailable",
      });
    } finally {
      database.close();
    }
  });
});

await it("projects the same declared call list for standalone consent", async () => {
  const calls = [
    { appId: "app_bonsai", methods: ["files.read", "files.save"] },
  ];
  const { root, database } = await fixture(true, {
    ...declaration,
    capabilities: ["app.storage", "apps.call"],
    calls,
  });
  try {
    assert.deepEqual((await root.directory()).apps[0]?.calls, calls);
  } finally {
    database.close();
  }
});
