import assert from "node:assert/strict";
import { test } from "node:test";
import { isMachineLinkOnline } from "../../src/machine-link/presence.js";

await test("a current machine socket with a fresh platform auto-pong is online", () => {
  assert.equal(isMachineLinkOnline(true, new Date(1_000_000), 1_000_000), true);
});

await test("a silent machine becomes offline at ninety seconds even with its socket retained", () => {
  const pong = new Date(1_000_000);
  assert.equal(isMachineLinkOnline(true, pong, 1_089_999), true);
  assert.equal(isMachineLinkOnline(true, pong, 1_090_000), false);
  assert.equal(isMachineLinkOnline(true, pong, 1_090_001), false);
});

await test("a clock rollback cannot turn a future-dated platform pong into fresh presence", () => {
  assert.equal(isMachineLinkOnline(true, new Date(1_000_000), 999_999), false);
});

await test("a missing socket or a socket without its own auto-pong is offline", () => {
  assert.equal(
    isMachineLinkOnline(false, new Date(1_000_000), 1_000_000),
    false,
  );
  assert.equal(isMachineLinkOnline(true, null, 1_000_000), false);
  assert.equal(isMachineLinkOnline(false, null, 1_000_000), false);
});
