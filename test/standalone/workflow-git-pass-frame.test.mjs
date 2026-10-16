import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

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
const { instanceIds } = await import("@fungi.computer/oyster");
const { OysterBinding } = await import("../../src/standalone/instance.ts");
hooks.deregister();

// The real Computer frame entry returns to the originating Instance. That
// Instance, not guest arguments, owns stored-node admission and pass minting.
test("Workflow pass packets preserve immutable frame authority and carry no guest-selected scope", async () => {
  const props = {
    instanceId: instanceIds.instance.generate(),
    frameId: "app_frame_7rid3mf288uvsdldxmu5l",
    binding: "COMPUTER",
  };
  const reply = {
    passId: "pass_fixture",
    remote: "https://git.team.internal/workflow/pass_fixture/project.git",
    expiresAt: 62000,
  };
  let delivered = reply;
  const packets = [];
  const computer = new OysterBinding(
    { props },
    {
      INSTANCES: {
        getByName(instanceId) {
          assert.equal(instanceId, props.instanceId);
          return {
            async bindingCall(authority, method, args) {
              packets.push({ authority, method, args });
              return { kind: "result", value: delivered };
            },
          };
        },
      },
    },
  );
  assert.deepEqual(await computer.workflowGitPass({}), {
    kind: "result",
    value: reply,
  });
  assert.deepEqual(packets, [
    { authority: props, method: "workflowGitPass", args: [{}] },
  ]);
  for (const input of [
    { repository: "another" },
    { memberId: "another" },
    { runId: "another" },
    { scope: "write" },
  ])
    assert.deepEqual(await computer.workflowGitPass(input), {
      kind: "local_refusal",
      code: "invalid_invocation_facts",
    });
  assert.equal(packets.length, 1);
  for (const invalid of [
    { ...reply, token: "credential-canary" },
    { ...reply, remote: "https://user:secret@git.invalid/project.git" },
    { ...reply, expiresAt: 0 },
  ]) {
    delivered = invalid;
    await assert.rejects(computer.workflowGitPass({}));
  }
});
