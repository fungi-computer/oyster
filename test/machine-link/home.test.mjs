import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { decodeMachineAgentHome } from "../../src/machine-link/home.ts";

test("a Team directory home distinguishes hosted delivery from a joined machine", () => {
  assert.deepEqual(decodeMachineAgentHome({ kind: "hosted" }), {
    kind: "hosted",
  });
  assert.deepEqual(
    decodeMachineAgentHome({ kind: "machine", deviceId: "device-one" }),
    { kind: "machine", deviceId: "device-one" },
  );
});

test("directory homes survive their JSON transport representation", () => {
  for (const home of [
    { kind: "hosted" },
    { kind: "machine", deviceId: "device-one" },
    { kind: "machine", deviceId: "d".repeat(256) },
  ]) {
    assert.deepEqual(
      decodeMachineAgentHome(JSON.parse(JSON.stringify(home))),
      home,
    );
  }
});

test("a machine home requires one bounded opaque device identity", () => {
  assert.throws(
    () => decodeMachineAgentHome({ kind: "machine" }),
    Schema.isSchemaError,
  );
  for (const invalid of [null, false, 1, [], {}, "", "x".repeat(257)]) {
    assert.throws(
      () => decodeMachineAgentHome({ kind: "machine", deviceId: invalid }),
      Schema.isSchemaError,
    );
  }
});

test("routing carries no member identity: the superseded member-bearing home is refused", () => {
  // Member authorization stays with the enrollment owner, never the projection.
  assert.throws(
    () =>
      decodeMachineAgentHome({
        kind: "machine",
        deviceId: "device-one",
        memberId: "member-one",
      }),
    Schema.isSchemaError,
  );
});

test("home decoding refuses other JSON shapes and mixed routing representations", () => {
  for (const input of [
    null,
    [],
    1,
    "hosted",
    {},
    { kind: "desktop" },
    { kind: "hosted", deviceId: "device-one" },
    { kind: "machine", deviceId: "device-one", url: "https://example.test" },
    { kind: "machine", agentId: "agent-one", teamId: "team-one" },
  ]) {
    assert.throws(() => decodeMachineAgentHome(input), Schema.isSchemaError);
  }
});
