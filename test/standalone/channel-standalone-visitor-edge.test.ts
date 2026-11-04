import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { fauxModelSource } from "@fungi.computer/shiitake/testing";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { z } from "zod";

import { channelIds } from "../../src/channels/ids.js";
import type { WebsiteBinding } from "../../src/channels/web-binding.js";
import { createChannelVisitors } from "../../src/channels/visitors.js";
import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import { standaloneVisitorEdge } from "../../src/standalone/visitor-edge.js";
import { proveVisitor } from "../../src/standalone/visitor-proof.js";
import type { EdgeVerifiedVisitor } from "../../src/channels/visitor-edge.js";
import type { AuthenticatedChannelVisitor } from "../../src/channels/visitor-channel.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";
import { defaultTenant, tenantScope } from "../../src/tenant.js";

const proofKey = ["fixture", "edge", "proof"].join("-").padEnd(40, "p");
/** The site is read from the binding owner on every visitor request. */
class WebsiteAgent extends StandaloneAgentBase {
  binding: WebsiteBinding | null = null;
  live: (bindingId: string, visitorId: string) => boolean = () => false;
  protected hostFor(): never {
    return unavailable();
  }
  protected override readChannelBinding(bindingId: string) {
    return Promise.resolve(
      this.binding?.bindingId === bindingId ? this.binding : null,
    );
  }
  protected override channelVisitorLive(bindingId: string, visitorId: string) {
    return Promise.resolve(this.live(bindingId, visitorId));
  }
  protected override channelProofKey() {
    return proofKey;
  }
  // Proof-only model stub; the production options are exercised below.
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      extensions: { roster: [], grants: [] },
      model: fauxModelSource([fauxAssistantMessage("A private Agent reply")]),
      meta: { schema: FungiMessageMetaSchema },
      instructions: this.channelInstructions({
        load: () => Promise.resolve({ revision: "website", text: "Reply." }),
      }),
      tools: [],
    });
  }
  close() {
    return this.closeShiitake();
  }
}

it("mints centrally, sends to one dedicated website Agent, and never projects another visitor's text", async () => {
  const siteKey = channelIds.site.generate();
  const binding: WebsiteBinding = {
    bindingId: channelIds.binding.generate(),
    agentId: "agent_fixture",
    lifecycle: "active",
    authorityVersion: 1,
    persona: "Be kind to ferns.",
    selector: {
      provider: "web",
      siteKey,
      origins: ["https://oyster.test"],
    },
  };
  const identityDb = new DatabaseSync(":memory:");
  const identity = createChannelVisitors({
    ...fromNodeSqlite(identityDb),
    now: () => Date.now(),
  });
  const db = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(db);
  const tasks: Promise<unknown>[] = [];
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: { ...state.storage, ...cloudflareStorageFixture(owner) },
  });
  Object.defineProperty(state, "waitUntil", {
    value: (work: Promise<unknown>) => {
      tasks.push(work);
    },
  });
  const website = new WebsiteAgent(state, agentEnv());
  website.binding = binding;
  website.live = identity.live;
  const opened: string[] = [];
  const app = standaloneVisitorEdge({
    site: (_context, key) =>
      key === siteKey
        ? {
            binding,
            facts: {
              name: "Oyster",
              avatar: {
                v: 1,
                character: "mushroom",
                appearance: {},
                expression: "idle",
                renderStyle: "plain",
              },
              origins: ["https://oyster.test"],
            },
          }
        : null,
    visitors: () => identity,
    proofKey: () => proofKey,
    agent: (_context, _binding, visitor) => {
      opened.push(visitor.visitorId);
      return website;
    },
    addressHash: () => Promise.resolve("test-address"),
    turnstile: () => ({
      configuration: { kind: "disabled" },
      timeoutMs: 1000,
      onError: () => undefined,
    }),
    assetPath: (kind) => `/${kind}`,
    onError: (error) => {
      throw error;
    },
  });
  const url = (part: string) =>
    `https://oyster.test/api/embed/v1/sites/${siteKey}${part}`;
  const post = (
    part: string,
    token: string | null,
    body: Readonly<{ requestId?: string; text?: string; visitorId?: string }>,
  ) => {
    const headers = new Headers({
      origin: "https://oyster.test",
      "content-type": "application/json",
    });
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return app.request(url(part), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };
  try {
    const firstMint = await post("/visitors", null, {});
    const secondMint = await post("/visitors", null, {});
    expect(firstMint.status).toBe(201);
    expect(secondMint.status).toBe(201);
    const visitor = z.object({
      visitorId: z.string(),
      accessToken: z.string(),
    });
    const first = visitor.parse(await firstMint.json());
    const second = visitor.parse(await secondMint.json());
    const denied = await post("/session", `vt_${"z".repeat(43)}`, {});
    expect(denied.status).toBe(401);
    expect(opened).toEqual([]);

    const initial = await post("/session", first.accessToken, {});
    expect(initial.status).toBe(200);
    const message = await post("/messages", first.accessToken, {
      requestId: "first-request",
      text: "First visitor's private text",
    });
    expect(message.status).toBe(202);
    for (const task of tasks) await task;
    const admitted = await identity.authenticate(
      binding.bindingId,
      first.accessToken,
    );
    if (admitted === null) throw new Error("The visitor was not authenticated");
    const proven = await proveVisitor(
      binding.bindingId,
      // SAFETY: this test value came from the central owner after it
      // authenticated the bearer minted above; the assertion is internal.
      admitted as EdgeVerifiedVisitor<AuthenticatedChannelVisitor>,
      proofKey,
    );
    // The Agent verifies the signed assertion itself: a changed visitor, an
    // expired proof, a forged signature or another binding never opens a Session.
    await expect(
      website.openChannelVisitor(
        binding.bindingId,
        { ...proven, visitorId: second.visitorId },
        {},
      ),
    ).rejects.toThrow("unauthorized");
    await expect(
      website.openChannelVisitor(
        binding.bindingId,
        {
          ...proven,
          edgeProof: { ...proven.edgeProof, expiresAt: 1 },
        },
        {},
      ),
    ).rejects.toThrow("unauthorized");
    await expect(
      website.openChannelVisitor(
        binding.bindingId,
        {
          ...proven,
          edgeProof: { ...proven.edgeProof, signature: "A".repeat(43) },
        },
        {},
      ),
    ).rejects.toThrow("unauthorized");
    await expect(
      website.openChannelVisitor(channelIds.binding.generate(), proven, {}),
    ).rejects.toThrow("unavailable");

    const firstDocument = await post("/session", first.accessToken, {});
    const forged = await post("/session", second.accessToken, {
      visitorId: first.visitorId,
    });
    expect(forged.status).toBe(400);
    const secondDocument = await post("/session", second.accessToken, {});
    expect(firstDocument.status).toBe(200);
    expect(secondDocument.status).toBe(200);
    const firstText = await firstDocument.text();
    const secondText = await secondDocument.text();
    expect(firstText).toContain("First visitor's private text");
    expect(firstText).toContain("A private Agent reply");
    expect(secondText).not.toContain("First visitor's private text");
    expect(secondText).not.toContain("A private Agent reply");
    expect(secondText).not.toContain(first.visitorId);
    const events = await app.request(url("/conversation/events"), {
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = events.body?.getReader();
    if (reader === undefined) throw new Error("No event stream");
    const frame = await reader.read();
    const frameBytes: unknown = frame.value;
    if (!(frameBytes instanceof Uint8Array))
      throw new Error("No initial event frame");
    expect(new TextDecoder().decode(frameBytes)).toContain(
      "First visitor's private text",
    );
    await reader.cancel();

    // The owner reads the same conversations through the Agent's own owner reads.
    const conversations = await website.websiteConversations(binding.bindingId);
    expect(conversations.map(({ party }) => party)).toEqual(
      expect.arrayContaining([{ kind: "visitor", visitorId: first.visitorId }]),
    );
    const mine = conversations.find(
      ({ party }) =>
        party.kind === "visitor" && party.visitorId === first.visitorId,
    );
    if (mine === undefined) throw new Error("The owner cannot see the visit");
    const transcript = await website.websiteTranscript(
      binding.bindingId,
      mine.sessionId,
    );
    expect(transcript?.lines).toEqual([
      { role: "visitor", text: "First visitor's private text" },
      { role: "agent", text: "A private Agent reply" },
    ]);
    expect(
      await website.websiteTranscript(binding.bindingId, "unrelated-session"),
    ).toBeNull();

    // A suspended binding refuses every visitor RPC, even with a valid proof.
    website.binding = { ...binding, lifecycle: "suspended" };
    await expect(
      website.openChannelVisitor(binding.bindingId, proven, {}),
    ).rejects.toThrow("unavailable");
    await expect(
      website.sendChannelVisitor(binding.bindingId, proven, "later", "hi"),
    ).rejects.toThrow("unavailable");
  } finally {
    await website.close();
    db.close();
    identityDb.close();
  }
});

/** The real standalone Shiitake tool composition: a visitor's Session runs on
 * its Agent's own tools, admitted only while its website binding is active. */
class ToolPolicyAgent extends StandaloneAgentBase {
  binding: WebsiteBinding | null = null;
  protected hostFor(): never {
    return unavailable();
  }
  protected override readChannelBinding(bindingId: string) {
    return Promise.resolve(
      this.binding?.bindingId === bindingId ? this.binding : null,
    );
  }
  options() {
    return super.shiitakeOptions();
  }
  ensureConversations() {
    this.channelConversations().ensure();
  }
  close() {
    return this.closeShiitake();
  }
}

it("gives a visitor's Session the Agent's own Computer while its website is active, and nothing once it is not", async () => {
  const db = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(db);
  const binding: WebsiteBinding = {
    bindingId: channelIds.binding.generate(),
    agentId: "agent_fixture",
    lifecycle: "active",
    authorityVersion: 1,
    persona: "",
    selector: {
      provider: "web",
      siteKey: channelIds.site.generate(),
      origins: ["https://oyster.test"],
    },
  };
  const scope = tenantScope(defaultTenant, "https://oyster.test");
  const pin = {
    directoryName: scope.durableName("agents"),
    tenantId: defaultTenant,
  };
  const snapshot = {
    scopeId: pin.directoryName,
    agentId: "agent_fixture",
    projection: {
      revision: 1,
      attachments: [
        {
          attachmentId: "visitor-worker",
          agentId: "agent_fixture",
          computerId: "worker-1",
          name: "worker",
          version: 1,
          admission: null,
        },
      ],
    },
  };
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      ...cloudflareStorageFixture(owner),
      get: (key: string) =>
        Promise.resolve(key === "app-policy-directory" ? pin : undefined),
    },
  });
  const env = agentEnv();
  Object.defineProperty(env, "AGENT_DIRECTORY", {
    value: {
      getByName: () => ({
        agentComputerRevision: () => Promise.resolve(1),
        agentComputerSnapshot: () => Promise.resolve(snapshot),
      }),
    },
  });
  const agent = new ToolPolicyAgent(state, env);
  agent.binding = binding;
  const visitorSession = "test-visitor-session";
  const visitorId = channelIds.visitor.generate();
  try {
    // Seed an owned row only to inspect capability acquisition without
    // starting a model run; the HTTP proofs create the real row.
    agent.ensureConversations();
    owner.sql.exec(
      "INSERT INTO hub_channel_conversations (binding_id,conversation,session_id,party_json,created_at,last_event_at) VALUES (?,?,?,?,?,?)",
      binding.bindingId,
      visitorId,
      visitorSession,
      JSON.stringify({ kind: "visitor", visitorId }),
      Date.now(),
      Date.now(),
    );
    const options = await agent.options();
    if (options.tools === undefined || !("sources" in options.tools))
      throw new Error("The real Agent has no capability sources");
    // The channel decides admission only; the Agent's own grants are untouched.
    expect(options.tools.access).toBeUndefined();
    const computer = options.tools.sources?.find(
      (source) => source.id === "agent-computers",
    );
    if (computer === undefined) throw new Error("No Agent Computer source");
    const acquire = async (sessionId: string) => {
      const lease = await computer.acquire({
        session: { sessionId },
        signal: new AbortController().signal,
        invalidate: () => undefined,
      });
      const denied = lease.snapshot.version === "channel-denied";
      const modules = lease.snapshot.modules.length;
      await lease.release();
      return { denied, modules };
    };
    const active = await acquire(visitorSession);
    expect(active.denied).toBe(false);
    expect(active.modules).toBeGreaterThan(0);
    // An owner Session has no channel row and is never affected.
    expect((await acquire("owner-session")).denied).toBe(false);
    agent.binding = { ...binding, lifecycle: "suspended" };
    expect(await acquire(visitorSession)).toEqual({ denied: true, modules: 0 });
    agent.binding = null;
    expect(await acquire(visitorSession)).toEqual({ denied: true, modules: 0 });
    expect((await acquire("owner-session")).denied).toBe(false);
    // A binding that names another Agent is not this Agent's to serve.
    agent.binding = { ...binding, agentId: "agent_other" };
    expect((await acquire(visitorSession)).denied).toBe(true);
  } finally {
    await agent.close();
    db.close();
  }
});
