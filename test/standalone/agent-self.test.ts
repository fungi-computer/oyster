import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it } from "vitest";
import { AgentDirectory } from "../../src/standalone/agents.js";
import { agentDurableObjectState, agentEnv } from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";
import { seededAvatar } from "@fungi.computer/sprite/avatar";
import { invokeModuleOperation } from "@fungi.computer/mycelium/remote";
import { createSelfSource } from "../../src/standalone/agent-self.js";

it("lets an Agent rename only itself, with typed duplicate refusal and no-op repeats", async () => {
  const database = new DatabaseSync(":memory:");
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      ...cloudflareStorageFixture(fromNodeSqlite(database)),
    },
  });
  const directory = new AgentDirectory(state, agentEnv());
  const owner = {
    actor: { kind: "member", memberId: "owner" },
    role: "owner",
  } as const;
  try {
    const moss = directory.create("Moss", "moss", owner, "owner-direct");
    const fern = directory.create("Fern", "fern", owner, "owner-direct");
    const self = { actor: { kind: "agent", agentId: moss.agentId } } as const;
    expect(directory.rename(moss.agentId, "Crumb", self)).toMatchObject({
      agentId: moss.agentId,
      name: "Crumb",
    });
    const revision = directory.revision();
    expect(directory.rename(moss.agentId, "Crumb", self)).toMatchObject({
      name: "Crumb",
    });
    expect(directory.revision()).toBe(revision);
    expect(directory.rename(fern.agentId, "Stolen", self)).toEqual({
      error: "not_granted",
    });
    expect(directory.rename(moss.agentId, "Fern", self)).toEqual({
      error: "name_taken",
    });
    expect(directory.rename(moss.agentId, "Owner choice", owner)).toMatchObject(
      { name: "Owner choice" },
    );
    const avatar = seededAvatar("crumb");
    expect(directory.setAvatar(moss.agentId, avatar, self)).toMatchObject({
      avatar,
    });
    const avatarRevision = directory.revision();
    expect(directory.setAvatar(moss.agentId, avatar, self)).toMatchObject({
      avatar,
    });
    expect(directory.revision()).toBe(avatarRevision);
    expect(directory.setAvatar(fern.agentId, avatar, self)).toEqual({
      error: "not_granted",
    });
    const lease = await createSelfSource({
      agentId: moss.agentId,
      directory: () => Promise.resolve(directory),
      isChannelSession: () => false,
    }).acquire({
      session: { sessionId: "owner-session" },
      signal: new AbortController().signal,
      invalidate: () => undefined,
    });
    const module = lease.snapshot.modules[0];
    if (module === undefined) throw new Error("self module missing");
    const context = {
      executionId: "self",
      deadlineAt: null,
      signal: new AbortController().signal,
    };
    await expect(
      invokeModuleOperation(module, "rename", { name: "Crumb" }, context),
    ).resolves.toMatchObject({
      name: "Crumb",
      avatar: { v: 1, character: "mushroom" },
    });
    await expect(
      invokeModuleOperation(module, "rename", { name: "Fern" }, context),
    ).resolves.toEqual({ error: "name_taken" });
    await expect(
      invokeModuleOperation(
        module,
        "rename",
        {
          name: "Stolen",
          agentId: fern.agentId,
        },
        context,
      ),
    ).rejects.toBeDefined();
    for (const hidden of ["Cr\u202Eumb", "Cr\u200Bumb", "Cr\u2066umb"]) {
      await expect(
        invokeModuleOperation(module, "rename", { name: hidden }, context),
      ).rejects.toBeDefined();
      // The owner's rename is held to the same shape.
      expect(() => directory.rename(moss.agentId, hidden, owner)).toThrow();
    }
    await expect(
      invokeModuleOperation(module, "setAvatar", { avatar }, context),
    ).resolves.toEqual({ avatar });
    await lease.release();
  } finally {
    database.close();
  }
});

it("never offers standalone self tools in a channel Session or without a Session", async () => {
  const source = createSelfSource({
    agentId: "self",
    directory: () => {
      throw new Error("A visitor must not reach the directory");
    },
    isChannelSession: (id) => id === "visitor",
  });
  const acquire = (session?: { sessionId: string }) => {
    const context = {
      signal: new AbortController().signal,
      invalidate: () => undefined,
    };
    return source.acquire(
      session === undefined ? context : { ...context, session },
    );
  };
  for (const session of [undefined, { sessionId: "visitor" }]) {
    const lease = await acquire(session);
    expect(lease.snapshot.modules).toEqual([]);
    await lease.release();
  }
});
