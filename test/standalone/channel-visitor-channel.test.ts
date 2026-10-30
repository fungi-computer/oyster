import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { memoryHost } from "@fungi.computer/shiitake/testing";
import { parseSessionSnapshot } from "@fungi.computer/shiitake/client";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { expect, it } from "vitest";

import type { ConversationBinding } from "../../src/channels/binding.js";
import { createChannelConversations } from "../../src/channels/conversations.js";
import { channelIds } from "../../src/channels/ids.js";
import { createVisitorChannel } from "../../src/channels/visitor-channel.js";
import { createVisitorStreamSlots } from "../../src/channels/visitor-stream-slots.js";
import { createChannelVisitors } from "../../src/channels/visitors.js";
import { channelSessionDoor } from "./channel-session-door.fixture.js";

it("keeps identity in one store, conversations in another, and projects only the bearer visitor", async () => {
  const identityDb = new DatabaseSync(":memory:");
  const conversationDb = new DatabaseSync(":memory:");
  const identityStore = fromNodeSqlite(identityDb);
  const conversationStore = fromNodeSqlite(conversationDb);
  const host = await memoryHost({
    owner: conversationStore,
    meta: { schema: FungiMessageMetaSchema },
  });
  try {
    const firstBinding: ConversationBinding = {
      bindingId: channelIds.binding.generate(),
      lifecycle: "active",
      selector: {
        provider: "web",
        siteKey: channelIds.site.generate(),
        origins: ["https://example.com"],
      },
    };
    const secondBinding: ConversationBinding = {
      ...firstBinding,
      bindingId: channelIds.binding.generate(),
      selector: {
        provider: "web",
        siteKey: channelIds.site.generate(),
        origins: ["https://example.com"],
      },
    };
    let active = true;
    const binding = (id: string): ConversationBinding | null =>
      id === firstBinding.bindingId
        ? { ...firstBinding, lifecycle: active ? "active" : "suspended" }
        : id === secondBinding.bindingId
          ? secondBinding
          : null;
    const visitors = createChannelVisitors({
      ...identityStore,
      now: () => 1_000_000,
    });
    const conversations = createChannelConversations({
      ...conversationStore,
      binding,
      door: channelSessionDoor(
        () => Promise.resolve(host.agent),
        () => undefined,
        () => conversations,
      ),
      now: () => 1_000_000,
    });
    const channel = createVisitorChannel({
      binding,
      visitors: () => visitors,
      conversations: () => conversations,
      sessionDoor: () =>
        channelSessionDoor(
          () => Promise.resolve(host.agent),
          () => undefined,
          () => conversations,
        ),
      intake: (event) => conversations.receive(event),
      acquireStream: createVisitorStreamSlots(),
      now: () => 1_000_000,
    });
    if (firstBinding.selector.provider !== "web")
      throw new Error("Expected web binding");
    const first = await channel.mint(
      firstBinding.bindingId,
      firstBinding.selector.siteKey,
      "first-address",
    );
    const second = await channel.mint(
      firstBinding.bindingId,
      firstBinding.selector.siteKey,
      "second-address",
    );
    if (first.kind !== "granted" || second.kind !== "granted")
      throw new Error("Expected two visitors");
    const firstToken = first.credentials.accessToken;
    const secondToken = second.credentials.accessToken;
    const accepted = await channel.send(
      firstBinding.bindingId,
      firstToken,
      "original-request",
      "Hello from the first visitor",
    );
    expect(accepted).toMatchObject({ kind: "accepted", delivery: "new" });
    if (accepted.kind !== "accepted") throw new Error("Expected acceptance");
    expect(
      await channel.send(
        firstBinding.bindingId,
        firstToken,
        "original-request",
        "Hello from the first visitor",
      ),
    ).toEqual({ ...accepted, delivery: "replay" });
    await host.settle(accepted.sessionId);
    const firstDocument = await channel.open(
      firstBinding.bindingId,
      firstToken,
      {},
    );
    const secondDocument = await channel.open(
      firstBinding.bindingId,
      secondToken,
      {},
    );
    if (firstDocument.kind !== "session" || secondDocument.kind !== "session")
      throw new Error("Expected Session documents");
    const firstSnapshot = parseSessionSnapshot(firstDocument.snapshot);
    const secondSnapshot = parseSessionSnapshot(secondDocument.snapshot);
    expect(firstSnapshot.sessionId).toBe(first.credentials.visitorId);
    expect(secondSnapshot.sessionId).toBe(second.credentials.visitorId);
    expect(firstDocument.snapshot).toContain("Hello from the first visitor");
    expect(secondDocument.snapshot).not.toContain(
      "Hello from the first visitor",
    );
    expect(await channel.open(secondBinding.bindingId, firstToken, {})).toEqual(
      { kind: "unauthorized" },
    );
    expect(
      await channel.send(
        secondBinding.bindingId,
        firstToken,
        "foreign-request",
        "must not enter",
      ),
    ).toEqual({ kind: "unauthorized" });
    active = false;
    expect(await channel.open(firstBinding.bindingId, firstToken, {})).toEqual({
      kind: "unauthorized",
    });
    expect(
      await channel.send(
        firstBinding.bindingId,
        firstToken,
        "new-request",
        "must not enter",
      ),
    ).toEqual({ kind: "denied", reason: "suspended" });
    // The identity owner need not contain conversations, nor the Agent owner tokens.
    expect(
      identityDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='hub_channel_conversations'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      conversationDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='hub_channel_visitors'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    await host.close();
    identityDb.close();
    conversationDb.close();
  }
});
