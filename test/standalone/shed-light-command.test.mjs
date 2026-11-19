/* global AbortController */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Self-host runs Shed's light shell through the standalone COMPUTER binding,
// whose exec decoder is strict: whatever Shed sends must decode there.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { computerFrameMethods } =
  await import("../../src/standalone/computer.ts");
const { appBackend } = await import("../../../../apps/shed/backend/methods.ts");
const { runLightCommand } =
  await import("../../../../apps/shed/src/light-shell/connector.ts");
const { createCapabilityRegistry } = await import("@fungi.computer/agar");
const { appMethods } = await import("@fungi.computer/agar/backend");
hooks.deregister();

test("Shed's light shell command runs end to end through the standalone COMPUTER binding", async () => {
  const exec = computerFrameMethods.COMPUTER.exec;
  const unexpected = () =>
    Promise.reject(new Error("Unexpected host binding call"));
  const sent = [];
  const COMPUTER = {
    ports: unexpected,
    processes: unexpected,
    processStart: unexpected,
    processKill: unexpected,
    read: unexpected,
    preview: unexpected,
    // The binding decodes Shed's arguments and the host's reply exactly as
    // the standalone Instance does.
    exec: async (input) => {
      const [decoded] = exec.decodeArgs([input]);
      sent.push(decoded);
      return exec.decodeResult({
        requestId: "0199caff-aaaa-7000-8000-aaaaaaaaaaaa",
        status: "succeeded",
        output: {
          status: "completed",
          exitCode: 0,
          stdout: "src\n",
          stderr: "",
          truncated: false,
        },
      });
    },
  };
  // The light shell's own connector calls Shed's method as the page does.
  const capabilities = createCapabilityRegistry();
  capabilities.provide(appMethods, {
    call: (method, input) =>
      appBackend.call(
        method,
        JSON.parse(input),
        { env: { COMPUTER } },
        {
          scope: { kind: "standalone", tenant: "default" },
          actor: { kind: "member", memberId: "member-a" },
          computerId: "computer-a",
        },
      ),
  });
  const result = await runLightCommand(
    capabilities,
    { command: "ls", cwd: "/workspace", env: {} },
    new AbortController().signal,
  );
  assert.equal(result.stdout, "src\n");
  assert.equal(result.exitCode, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cwd, "/workspace");
  assert.ok(!("refusals" in sent[0]), "nothing the binding rejects is sent");
});
