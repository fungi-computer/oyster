import assert from "node:assert/strict";
import test from "node:test";
import type * as Schema from "effect/Schema";
import type { PostDeliveryResult } from "@fungi.computer/carrier/post";
import type { MachineAgentHome } from "../../src/machine-link/home.js";
import type { MachineAgentOperation } from "@fungi.computer/seam/machine-link-protocol";
import { createMachineAgentClient } from "../../src/machine-link/client.js";
import { machineAgentCodecs } from "@fungi.computer/shiitake/delegation";

function fixture(home: MachineAgentHome, failure?: Error) {
  const calls: MachineAgentOperation[] = [];
  let hosted = 0;
  let homeReads = 0;
  const client = createMachineAgentClient({
    identity: () => ({ teamId: "team", agentId: "sender" }),
    codecs: machineAgentCodecs,
    home: () => {
      homeReads++;
      return Promise.resolve(home);
    },
    links: {
      getByName: (name) => {
        assert.equal(
          name,
          JSON.stringify({ teamId: "team", deviceId: "device" }),
        );
        return {
          deliver: (): Promise<PostDeliveryResult> =>
            Promise.resolve("refused"),
          operation: (identity, caller, agentId, operation) => {
            assert.deepEqual(identity, { teamId: "team", deviceId: "device" });
            assert.deepEqual(caller, { kind: "hosted", agentId: "sender" });
            assert.equal(agentId, "recipient");
            calls.push(operation);
            if (failure !== undefined) return Promise.reject(failure);
            return Promise.resolve({ sessionId: "actual-port-session" });
          },
        };
      },
    },
    hosted: {
      getByName: () => ({
        fetch: () => {
          hosted++;
          return Promise.resolve(
            Response.json({ sessionId: "hosted-session" }, { status: 201 }),
          );
        },
        deliver: (): Promise<PostDeliveryResult> => Promise.resolve("refused"),
        settlement: () => Promise.resolve(undefined),
      }),
    },
  });
  return { client, calls, hosted: () => hosted, homeReads: () => homeReads };
}

const request = (body: Schema.Json) =>
  new Request("https://agent.internal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const machine: MachineAgentHome = {
  kind: "machine",
  deviceId: "device",
};

await test("directory session creation keeps request identity and the Local port's result", async () => {
  const f = fixture(machine);
  const response = await f.client.dispatch(
    "recipient",
    request({ requestId: "caller-request" }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { sessionId: "actual-port-session" });
  assert.deepEqual(f.calls, [
    { type: "createSession", requestId: "caller-request" },
  ]);
  assert.equal(f.hosted(), 0);
  assert.equal(f.homeReads(), 1);
});

await test("unavailable Local session transport never dispatches to a hosted Agent", async () => {
  const f = fixture(machine, new Error("Local transport closed"));
  const response = await f.client.dispatch(
    "recipient",
    request({ requestId: "caller-request" }),
  );
  assert.equal(response.status, 500);
  assert.equal(f.hosted(), 0);
  assert.equal(f.homeReads(), 1);
});

await test("the maintained Session request decoder refuses excess properties before I/O", async () => {
  const f = fixture(machine);
  const response = await f.client.dispatch(
    "recipient",
    request({ requestId: "request", sessionId: "invented" }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(f.calls, []);
  assert.equal(f.hosted(), 0);
});

await test("an explicitly hosted home uses the ordinary hosted dispatch", async () => {
  const f = fixture({ kind: "hosted" });
  const response = await f.client.dispatch(
    "recipient",
    request({ requestId: "request" }),
  );
  assert.equal(response.status, 201);
  assert.equal(f.hosted(), 1);
  assert.deepEqual(f.calls, []);
});
