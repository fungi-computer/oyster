import assert from "node:assert/strict";
import { test } from "node:test";
import { TextDecoder, TextEncoder } from "node:util";
import { stageUpgradeSources } from "../src/upgrade/private-stage.ts";

test("a failed second R2 page leaves only unsealed private parts, not a stage", async () => {
  const stored = new Map();
  const privateBucket = {
    async put(key, bytes) {
      stored.set(key, new Uint8Array(bytes));
      return { key };
    },
    async get(key) {
      const bytes = stored.get(key);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => bytes.buffer.slice(0) };
    },
  };
  const releases = {
    async list({ cursor } = {}) {
      if (cursor === "second") throw new Error("R2 listing unavailable");
      return {
        objects: [{ key: "releases/one", size: 3, etag: "one" }],
        truncated: true,
        cursor: "second",
      };
    },
    async get(key) {
      assert.equal(key, "releases/one");
      return {
        etag: "one",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    },
  };
  let snapshotsStarted = false;
  await assert.rejects(
    stageUpgradeSources({
      releases,
      privateBucket,
      snapshots: async function* () {
        snapshotsStarted = true;
        yield { kind: "complete", partCount: 0, unreachable: [] };
      },
      oldWorkerName: "old-oyster",
      oldVersion: "0.2.0",
    }),
    /R2 listing unavailable/,
  );
  assert.equal(snapshotsStarted, false);
  assert.equal(stored.size, 1);
  assert.equal(
    [...stored.keys()].some((key) => key.endsWith("/stage.json")),
    false,
  );
});

test("a normally ended DO stream without its terminal inventory cannot stage", async () => {
  const stored = new Map();
  const privateBucket = {
    async put(key, bytes) {
      stored.set(key, new Uint8Array(bytes));
      return { key };
    },
    async get(key) {
      const bytes = stored.get(key);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => bytes.buffer.slice(0) };
    },
  };
  const releases = {
    async list() {
      return { objects: [], truncated: false };
    },
  };
  await assert.rejects(
    stageUpgradeSources({
      releases,
      privateBucket,
      snapshots: async function* () {
        yield { kind: "part", name: "registry", bytes: new Uint8Array([3]) };
      },
      oldWorkerName: "old-oyster",
      oldVersion: "0.1.0",
    }),
    /Incomplete DO snapshot/,
  );
  assert.equal(stored.size, 1);
  assert.equal(
    [...stored.keys()].some((key) => key.endsWith("/stage.json")),
    false,
  );
});

test("an empty DO inventory cannot stage an old Oyster", async () => {
  const stored = [];
  await assert.rejects(
    stageUpgradeSources({
      releases: { list: async () => ({ objects: [], truncated: false }) },
      privateBucket: {
        put: async (key) => {
          stored.push(key);
          return { key };
        },
        get: async () => null,
      },
      snapshots: async function* () {
        yield { kind: "complete", partCount: 0, unreachable: [] };
      },
      oldWorkerName: "old-oyster",
      oldVersion: "0.0.1",
    }),
    /registry snapshot missing/,
  );
  assert.deepEqual(stored, []);
});

test("registry-only input stages checksummed private parts but never a certified manifest", async () => {
  const stored = new Map();
  const privateBucket = {
    async put(key, bytes) {
      stored.set(key, new Uint8Array(bytes));
      return { key };
    },
    async get(key) {
      const bytes = stored.get(key);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => bytes.buffer.slice(0) };
    },
  };
  const input = {
    releases: { list: async () => ({ objects: [], truncated: false }) },
    privateBucket,
    snapshots: async function* () {
      yield {
        kind: "part",
        name: "registry",
        bytes: new TextEncoder().encode("abc"),
      };
      yield {
        kind: "complete",
        partCount: 1,
        unreachable: ["unindexed MediaOperationDO IDs"],
      };
    },
    oldWorkerName: "old-oyster",
    oldVersion: "0.1.0",
  };
  const first = await stageUpgradeSources(input);
  const second = await stageUpgradeSources(input);
  assert.notEqual(first.stageKey, second.stageKey);
  assert.equal("manifestKey" in first, false);
  assert.equal(
    [...stored.keys()].some((key) => key.endsWith("/manifest.json")),
    false,
  );
  const stage = JSON.parse(
    new TextDecoder().decode(stored.get(first.stageKey)),
  );
  assert.equal(stage.kind, "oyster-unverified-stage-v1");
  assert.equal(stage.oldWorkerName, "old-oyster");
  assert.deepEqual(stage.unreachable, ["unindexed MediaOperationDO IDs"]);
  assert.deepEqual(
    stage.parts.map(({ name, sha256 }) => ({ name, sha256 })),
    [
      {
        name: "DO:registry",
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    ],
  );
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});
