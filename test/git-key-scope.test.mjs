// A key reaches an App's Git repository only through its own grants: clone
// needs App read, push App use. Ungranted, it is anonymous, and a private
// repository then asks for a key.
/* global Request */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOyster } from "../dist/host.js";

const installation = (installationId, visibility) => ({
  installationId,
  visibility,
  status: "enabled",
});
const installations = new Map([
  ["notes", installation("notes", "private")],
  ["board", installation("board", "private")],
  ["wiki", installation("wiki", "public")],
]);
const keys = {
  // App "notes" read only.
  reader: [
    { capability: "apps.read", targets: { kind: "selected", ids: ["notes"] } },
  ],
  // App "notes" use.
  writer: [
    { capability: "apps.use", targets: { kind: "selected", ids: ["notes"] } },
  ],
  // A device enrollment key reaches no App.
  enroll: [{ capability: "machine.enroll", targets: { kind: "all" } }],
};

function host() {
  const exchanges = [];
  const reply = { status: 200, headers: {}, body: new Uint8Array() };
  const unused = () => assert.fail("Git routes reach no App runtime");
  const app = createOyster({
    auth: {
      resolve: unused,
      authenticate: async (request) => {
        const who = request.headers.get("x-who");
        if (who === "owner")
          return {
            kind: "admitted",
            principal: {
              actor: { kind: "member", memberId: "owner" },
              role: "owner",
            },
          };
        return who === null
          ? { kind: "refused", status: 401 }
          : {
              kind: "admitted",
              principal: { actor: { kind: "team-key", keyId: who } },
            };
      },
    },
    keys: {
      live: async (keyId) =>
        keys[keyId] === undefined
          ? null
          : { keyId, owner: "owner", grantVersion: 1, grants: keys[keyId] },
    },
    artifacts: { get: unused, put: unused },
    installations: {
      get: async (id) => installations.get(id) ?? null,
      list: async () => [...installations.values()],
      generation: async () => "fixture",
      compareAndPut: unused,
    },
    instances: { get: unused },
    bootUi: unused,
    git: {
      writerOf: (principal) => ({ kind: "actor", actor: principal.actor }),
      git: async (selected) => ({
        read: async (writer, repository) => {
          exchanges.push({
            op: "read",
            installation: selected.installationId,
            writer: writer?.actor.kind ?? null,
            repository,
          });
          return reply;
        },
        push: async (writer, repository) => {
          exchanges.push({
            op: "push",
            installation: selected.installationId,
            writer: writer.actor.kind,
            repository,
          });
          return reply;
        },
      }),
    },
  });
  const clone = (installationId, who) =>
    app.request(
      new Request(
        `https://oyster.test/git/${installationId}/source.git/info/refs?service=git-upload-pack`,
        { headers: who === null ? {} : { "x-who": who } },
      ),
    );
  const push = (installationId, who) =>
    app.request(
      new Request(
        `https://oyster.test/git/${installationId}/source.git/info/refs?service=git-receive-pack`,
        { headers: { "x-who": who } },
      ),
    );
  return { clone, push, exchanges };
}

test("a key clones only the App repositories its grants name", async () => {
  const { clone, exchanges } = host();
  assert.equal((await clone("notes", "reader")).status, 200);
  assert.equal((await clone("notes", "writer")).status, 200);
  // Board is private and outside every key's grants: the key is anonymous.
  for (const who of ["reader", "writer", "enroll", "revoked"])
    assert.equal((await clone("board", who)).status, 401, who);
  assert.equal((await clone("board", "owner")).status, 200);
  // A public repository stays readable anonymously, even to an ungranted key.
  assert.equal((await clone("wiki", "enroll")).status, 200);
  assert.equal((await clone("wiki", null)).status, 200);
  assert.deepEqual(
    exchanges.map(({ installation, writer }) => [installation, writer]),
    [
      ["notes", "team-key"],
      ["notes", "team-key"],
      ["board", "member"],
      ["wiki", null],
      ["wiki", null],
    ],
  );
});

test("a key pushes only where its grants allow App use", async () => {
  const { push, exchanges } = host();
  assert.equal((await push("notes", "reader")).status, 401);
  assert.equal((await push("notes", "writer")).status, 200);
  assert.equal((await push("board", "writer")).status, 401);
  assert.equal((await push("board", "owner")).status, 200);
  assert.deepEqual(
    exchanges.map(({ op, installation }) => [op, installation]),
    [
      ["push", "notes"],
      ["push", "board"],
    ],
  );
});
