import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { memoryHost, fauxModelSource } from "@fungi.computer/shiitake/testing";
import { ShiitakeError } from "@fungi.computer/shiitake";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";

import { channelIds } from "../../src/channels/ids.js";
import { channelSessionDoor } from "../../src/standalone/channel-session-door.js";
import type { ConversationBinding } from "../../src/channels/binding.js";
import {
  createChannelConversations,
  type InboundEvent,
} from "../../src/channels/conversations.js";
import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";

it("classifies only the matching contract-closed request at the standalone host", () => {
  const door = channelSessionDoor(
    () => Promise.reject(new Error("No Session needed")),
    () => {
      // Classification requires no Session or grants.
    },
    () => {
      throw new Error("Classification requires no conversation owner");
    },
  );
  expect(
    door.errorKind(
      new ShiitakeError("contract", "closed", "Withdrawn", "ch:binding:event"),
      "ch:binding:event",
    ),
  ).toBe("closed_request");
  expect(
    door.errorKind(
      new ShiitakeError("contract", "closed", "Withdrawn", "ch:binding:event"),
      "ch:binding:other",
    ),
  ).toBeNull();
  expect(
    door.errorKind(
      new ShiitakeError(
        "runtime",
        "closed",
        "Different boundary",
        "ch:binding:event",
      ),
      "ch:binding:event",
    ),
  ).toBeNull();
  expect(
    door.errorKind(
      new ShiitakeError(
        "contract",
        "conflict",
        "Different cause",
        "ch:binding:event",
      ),
      "ch:binding:event",
    ),
  ).toBeNull();
  expect(
    door.errorKind(new Error("unavailable"), "ch:binding:event"),
  ).toBeNull();
});

/** The Oyster conversation law over real Shiitake and a shared SQLite store. */
it("admits one visitor turn into Shiitake, replays it once, and refuses changed or suspended work", async () => {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const host = await memoryHost({
    owner,
    meta: { schema: FungiMessageMetaSchema },
  });
  try {
    const bindingId = channelIds.binding.generate();
    const visitorId = channelIds.visitor.generate();
    const binding = {
      bindingId,
      lifecycle: "active" as const,
      selector: {
        provider: "web" as const,
        siteKey: channelIds.site.generate(),
        origins: ["https://example.com"],
      },
    };
    let active = true;
    const conversations = createChannelConversations({
      ...owner,
      binding: (id) =>
        id === bindingId
          ? { ...binding, lifecycle: active ? "active" : "suspended" }
          : null,
      door: channelSessionDoor(
        () => Promise.resolve(host.agent),
        () => {
          // This direct Shiitake host has no Team grants.
        },
        () => conversations,
      ),
      now: () => 1_000_000,
    });
    const event: InboundEvent = {
      bindingId,
      eventId: "visitor-message-1",
      conversation: visitorId,
      party: { kind: "visitor", visitorId },
      text: "Hello, Agent",
    };

    const accepted = await conversations.receive(event);
    expect(accepted).toMatchObject({ kind: "accepted", delivery: "new" });
    if (accepted.kind !== "accepted") throw new Error("Expected acceptance");
    const settled = await host.settle(accepted.sessionId);
    expect(settled.terminals).toMatchObject([
      { commandId: accepted.commandId, outcome: "completed" },
    ]);
    expect(
      settled.messages.filter(
        (message) =>
          message.value.role === "user" &&
          message.value.content === "Hello, Agent",
      ),
    ).toHaveLength(1);
    expect(await conversations.receive(event)).toEqual({
      ...accepted,
      delivery: "replay",
    });
    expect(
      (await host.agent.session(accepted.sessionId).read()).messages,
    ).toEqual(settled.messages);
    expect(await conversations.receive({ ...event, text: "changed" })).toEqual({
      kind: "denied",
      reason: "event_conflict",
    });
    active = false;
    expect(
      await conversations.receive({ ...event, eventId: "visitor-message-2" }),
    ).toEqual({
      kind: "denied",
      reason: "suspended",
    });
    expect(
      (await host.agent.session(accepted.sessionId).read()).terminals,
    ).toHaveLength(1);
  } finally {
    await host.close();
    database.close();
  }
});

it("releases a visitor intake reservation only after the real Session host closed that request", async () => {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const host = await memoryHost({
    owner,
    meta: { schema: FungiMessageMetaSchema },
  });
  try {
    const binding: ConversationBinding = {
      bindingId: channelIds.binding.generate(),
      lifecycle: "active",
      selector: {
        provider: "web",
        siteKey: channelIds.site.generate(),
        origins: ["https://example.com"],
      },
    };
    const realDoor = channelSessionDoor(
      () => Promise.resolve(host.agent),
      () => undefined,
      () => conversations,
    );
    const conversations = createChannelConversations({
      ...owner,
      binding: (id) => (id === binding.bindingId ? binding : null),
      door: {
        ...realDoor,
        prompt: async (sessionId, input) => {
          // Pause acceptance at the same boundary as a racing visitor recall.
          await realDoor.withdraw(sessionId, input.requestId);
          return realDoor.prompt(sessionId, input);
        },
      },
      now: () => 1_000_000,
    });
    const visitorId = channelIds.visitor.generate();
    expect(
      await conversations.receive({
        bindingId: binding.bindingId,
        conversation: visitorId,
        eventId: "withdrawn-event",
        party: { kind: "visitor", visitorId },
        text: "Withdrawn before acceptance",
        sourceRequestId: "original-request",
      }),
    ).toEqual({ kind: "denied", reason: "event_conflict" });
    expect(
      owner.sql
        .exec(
          "SELECT event_id FROM hub_channel_intake WHERE binding_id=? AND event_id=?",
          binding.bindingId,
          "withdrawn-event",
        )
        .toArray(),
    ).toEqual([]);
  } finally {
    await host.close();
    database.close();
  }
});

/** The standalone Agent's real storage and Shiitake composition, without an inbound route. */
class ChannelAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      extensions: { roster: [], grants: [] },
      model: fauxModelSource([fauxAssistantMessage("Hello from Oyster")]),
      meta: { schema: FungiMessageMetaSchema },
      instructions: {
        load: () =>
          Promise.resolve({ revision: "channel-proof", text: "Reply." }),
      },
      tools: [],
    });
  }
  receive(event: InboundEvent, binding: ConversationBinding | null) {
    return this.channelConversations((id) =>
      id === binding?.bindingId ? binding : null,
    ).receive(event);
  }
  read(sessionId: string) {
    return this.shiitake().then((agent) => agent.session(sessionId).read());
  }
  close() {
    return this.closeShiitake();
  }
}

it("the standalone Agent uses its own store and refuses an unmapped binding", async () => {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  const state = agentDurableObjectState(() => 0);
  const tasks: Promise<unknown>[] = [];
  let settled = 0;
  const settleTasks = async () => {
    while (settled < tasks.length) {
      const pending = tasks.slice(settled);
      settled += pending.length;
      await Promise.all(pending);
    }
  };
  // Keep the real DO fixture's surface; replace only storage with the same
  // native SQLite adapter that Shiitake and the channel owner both consume.
  Object.defineProperty(state, "storage", {
    value: { ...state.storage, ...cloudflareStorageFixture(owner) },
  });
  Object.defineProperty(state, "waitUntil", {
    value: (work: Promise<unknown>) => {
      tasks.push(work);
    },
  });
  const agent = new ChannelAgent(state, agentEnv());
  try {
    const bindingId = channelIds.binding.generate();
    const visitorId = channelIds.visitor.generate();
    const event: InboundEvent = {
      bindingId,
      eventId: "standalone-message",
      conversation: visitorId,
      party: { kind: "visitor", visitorId },
      text: "Hello",
    };
    const binding: ConversationBinding = {
      bindingId,
      lifecycle: "active",
      selector: {
        provider: "web",
        siteKey: channelIds.site.generate(),
        origins: ["https://example.com"],
      },
    };
    expect(await agent.receive(event, null)).toEqual({
      kind: "denied",
      reason: "unmapped",
    });
    const accepted = await agent.receive(event, binding);
    expect(accepted).toMatchObject({ kind: "accepted", delivery: "new" });
    if (accepted.kind !== "accepted") throw new Error("Expected acceptance");
    expect(await agent.receive(event, binding)).toEqual({
      ...accepted,
      delivery: "replay",
    });
    await settleTasks();
    expect(
      (await agent.read(accepted.sessionId)).messages.filter(
        (message) => message.value.role === "user",
      ),
    ).toHaveLength(1);
    expect(
      await agent.receive(
        { ...event, eventId: "next-message" },
        {
          ...binding,
          lifecycle: "suspended",
        },
      ),
    ).toEqual({ kind: "denied", reason: "suspended" });
  } finally {
    try {
      await settleTasks();
    } finally {
      try {
        await agent.close();
      } finally {
        database.close();
      }
    }
  }
});
