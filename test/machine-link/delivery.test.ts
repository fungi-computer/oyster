import assert from "node:assert/strict";
import { test } from "node:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { BirdDogMail } from "@fungi.computer/bird-dog";
import type {
  PostEnvelope,
  PostDeliveryResult,
} from "@fungi.computer/carrier/post";
import type { MachineAgentHome } from "../../src/machine-link/home.js";
import { createHomeAwareAgentMailNamespace } from "../../src/machine-link/delivery.js";
import { deliverUndeliverableMail } from "../../src/machine-link/delivery.js";
import type { MachineLinkDispositionMail } from "../../src/machine-link/disposition.js";
import {
  agentMailRoute,
  machineAgentCodecs,
} from "@fungi.computer/shiitake/delegation";
import { createMachineLinkPostChannel } from "@fungi.computer/seam/machine-link-protocol";

/** The host composition: Shiitake's disclosure-owning route over this namespace. */
const homeAwareRoute = (
  options: Omit<
    Parameters<typeof createHomeAwareAgentMailNamespace>[0],
    "accepted"
  >,
) =>
  agentMailRoute(
    createHomeAwareAgentMailNamespace({
      ...options,
      accepted: machineAgentCodecs.accepted,
    }),
    () => Promise.resolve(undefined),
  );

const mail: BirdDogMail = {
  key: "one-mail",
  from: { kind: "agent", agentId: "sender", sessionId: "creator" },
  to: { kind: "agent", agentId: "receiver", sessionId: "local-session" },
  replyTo: [],
  content: "Do the task",
  createdAt: 1,
};
const envelope: PostEnvelope = {
  key: mail.key,
  kind: "agentMail",
  address: { scopeId: "team", agentId: "receiver" },
  event: mail,
};
const dispositionOriginal: MachineLinkDispositionMail = {
  key: mail.key,
  kind: "agentMail",
  address: { scopeId: "team", agentId: "receiver" },
  event: mail,
};
const undeliverableReply: MachineLinkDispositionMail = {
  key: `${mail.key}:reply:0`,
  kind: "agentMail",
  address: { scopeId: "team", agentId: "sender" },
  event: {
    key: `${mail.key}:reply:0`,
    from: { kind: "system", systemId: "hub" },
    to: mail.from,
    replyTo: [],
    content: "undeliverable",
    createdAt: 2,
    reply: { outcome: "undeliverable", reason: "recipient_offline" },
  },
};

await test("an expiry reply follows the original sender's current machine home", async () => {
  const sent: PostEnvelope[] = [];
  let accepted: Schema.Json | undefined;
  const held: PostDeliveryResult = {
    status: "accepted",
    receipt: {
      status: "held",
      reason: "recipient_offline",
      message: "waiting: recipient offline",
    },
  };
  assert.deepEqual(
    await deliverUndeliverableMail({
      identity: { teamId: "team", deviceId: "expired-device" },
      original: dispositionOriginal,
      reply: undeliverableReply,
      senderHome: { kind: "machine", deviceId: "sender-device" },
      hosted: {
        getByName: () => ({
          deliver: () => Promise.reject(new Error("hosted route not selected")),
        }),
      },
      machine: (deviceId, value) => {
        assert.equal(deviceId, "sender-device");
        sent.push(value);
        return Promise.resolve(held);
      },
      accepted: (receipt) => {
        accepted = receipt;
      },
    }),
    held,
  );
  assert.deepEqual(sent, [undeliverableReply]);
  assert.deepEqual(accepted, held.receipt);
});

await test(
  "the machine Post channel cannot promote a receiptless acknowledgment into Agent acceptance",
  { timeout: 1000 },
  async (t) => {
    const outbound = Effect.runSync(Deferred.make<string>());
    const acknowledgment = Effect.runSync(Deferred.make<string>());
    const limits = {
      maxInFlight: 32,
      maxFrameBytes: 512 * 1024,
      acknowledgmentMs: 10_000,
    };
    const hub = createMachineLinkPostChannel({
      limits,
      send: (text) => {
        Effect.runSync(Deferred.succeed(outbound, text));
      },
      receive: () => Promise.resolve("refused"),
    });
    const local = createMachineLinkPostChannel({
      limits,
      send: (text) => {
        Effect.runSync(Deferred.succeed(acknowledgment, text));
      },
      receive: () => Promise.resolve("accepted"),
    });
    t.after(() => {
      hub.close();
      local.close();
    });
    const route = homeAwareRoute({
      sender: { teamId: "team", agentId: "sender" },
      home: () =>
        Promise.resolve({
          kind: "machine",
          deviceId: "device",
        }),
      hosted: {
        getByName: () => ({
          deliver: () =>
            Promise.reject(new Error("Hosted fallback is forbidden")),
        }),
      },
      machine: (_deviceId, value) => hub.deliver(value),
    });
    const sending = route.namespace.getByName("receiver").deliver(envelope);
    await local.receive(await Effect.runPromise(Deferred.await(outbound)));
    await hub.receive(await Effect.runPromise(Deferred.await(acknowledgment)));
    await assert.rejects(sending, /valid acceptance or Held receipt/);
  },
);

function fixture(initial: MachineAgentHome | null) {
  let home = initial;
  const hosted: PostEnvelope[] = [];
  const machine: { deviceId: string; envelope: PostEnvelope }[] = [];
  let outcome: PostDeliveryResult | Error = "refused";
  const result = () =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  const route = homeAwareRoute({
    sender: { teamId: "team", agentId: "sender" },
    home: () => Promise.resolve(home),
    hosted: {
      getByName: () => ({
        deliver: (value) => {
          hosted.push(value);
          return result();
        },
      }),
    },
    machine: (deviceId, value) => {
      machine.push({ deviceId, envelope: value });
      return result();
    },
  });
  return {
    hosted,
    machine,
    deliver: (value = envelope) =>
      route.namespace.getByName("receiver").deliver(value),
    project: (value: MachineAgentHome | null) => {
      home = value;
    },
    respond: (value: PostDeliveryResult | Error) => {
      outcome = value;
    },
  };
}

await test("ordinary Carrier/BirdDog route selects current home on every attempt, forwarding without rewriting", async () => {
  const route = fixture({
    kind: "machine",
    deviceId: "laptop",
  });
  assert.equal(await route.deliver(), "refused");
  assert.equal(route.hosted.length, 0);
  assert.deepEqual(route.machine, [{ deviceId: "laptop", envelope }]);
  route.project({ kind: "hosted" });
  assert.equal(await route.deliver(), "refused");
  assert.deepEqual(route.hosted, [envelope]);
  assert.equal(route.machine.length, 1);
});

await test("unknown targets and foreign/forged addresses never dispatch", async () => {
  const route = fixture(null);
  assert.equal(await route.deliver(), "refused");
  route.project({ kind: "machine", deviceId: "laptop" });
  assert.equal(
    await route.deliver({
      ...envelope,
      address: { scopeId: "other-team", agentId: "receiver" },
    }),
    "refused",
  );
  assert.equal(
    await route.deliver({
      ...envelope,
      event: { ...mail, from: { ...mail.from, agentId: "forged" } },
    }),
    "refused",
  );
  assert.equal(
    await route.deliver({ ...envelope, key: "changed-key" }),
    "refused",
  );
  assert.equal(route.hosted.length + route.machine.length, 0);
});

await test("offline failure stays retryable; receiptless acknowledgment cannot become command acceptance", async () => {
  const route = fixture({
    kind: "machine",
    deviceId: "laptop",
  });
  route.respond(new Error("recipient_offline"));
  await assert.rejects(route.deliver(), /recipient_offline/u);
  assert.equal(route.hosted.length, 0);
  route.respond("accepted");
  await assert.rejects(route.deliver(), /valid acceptance or Held receipt/u);
});

await test("the machine Post route forwards typed Held custody without treating it as command acceptance", async () => {
  const route = fixture({
    kind: "machine",
    deviceId: "laptop",
  });
  const receipt = {
    status: "held",
    reason: "recipient_offline",
    message: "waiting: recipient offline",
  } as const;
  const acknowledgment = { status: "accepted", receipt } as const;
  route.respond(acknowledgment);
  assert.deepEqual(await route.deliver(), acknowledgment);
  assert.equal(route.machine.length, 1);
  assert.equal(route.hosted.length, 0);
});

await test("the existing reply-disclosure check still runs before home transport", async () => {
  const route = fixture({
    kind: "machine",
    deviceId: "laptop",
  });
  // The ordinary route owns reply authorization. A reply without a disclosed
  // original settlement is refused before our namespace is invoked.
  assert.equal(
    await route.deliver({
      ...envelope,
      event: {
        ...mail,
        reply: { commandId: "original-command", outcome: "completed" },
      },
    }),
    "refused",
  );
  assert.equal(route.hosted.length + route.machine.length, 0);
});
