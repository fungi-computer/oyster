import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { fauxModelSource } from "@fungi.computer/shiitake/testing";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ownerOrKeyAuth } from "../../src/auth.js";
import { serveHost } from "../../src/authorization.js";
import { channelIds } from "../../src/channels/ids.js";
import type { WebsiteBinding } from "../../src/channels/web-binding.js";
import {
  AgentDirectory,
  StandaloneAgentBase,
} from "../../src/standalone/agents.js";
import {
  standaloneWebsiteApp,
  standaloneWebsiteRoutes,
  type StandaloneWebsiteControl,
  type StandaloneWebsiteEnv,
} from "../../src/standalone/website-channels.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";

const origin = "https://oyster.test";
const proofKey = ["fixture", "proof", "word"].join("-").padEnd(40, "p");
const addressKey = ["fixture", "address", "word"].join("-").padEnd(40, "a");
const owner = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
} as const;
const stranger = {
  actor: { kind: "member", memberId: "guest" },
  role: "member",
} as const;

/** The production Agent over a real store; only the model is a fixture. */
class WebsiteFixtureAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  protected override shiitakeOptions(): Promise<CloudflareShiitakeOptions> {
    return Promise.resolve({
      extensions: { roster: [], grants: [] },
      model: fauxModelSource([fauxAssistantMessage("The fern is fine")]),
      meta: { schema: FungiMessageMetaSchema },
      instructions: this.channelInstructions({
        load: () =>
          Promise.resolve({ revision: "owner", text: "OWNER SECRET BRIEF" }),
      }),
      tools: [],
    });
  }
  instructionsFor(sessionId: string) {
    return this.channelInstructions({
      load: () =>
        Promise.resolve({ revision: "owner", text: "OWNER SECRET BRIEF" }),
    }).load({
      sessionId,
      commandId: "command",
      signal: new AbortController().signal,
    });
  }
  close() {
    return this.closeShiitake();
  }
}

const cleanups: (() => void | Promise<void>)[] = [];

/** The production Agent's real option composition, unchanged. */
class OptionsAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
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
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(
  hostSecrets: Partial<StandaloneWebsiteEnv> = {
    OYSTER_WEBSITE_PROOF_KEY: proofKey,
    OYSTER_WEBSITE_ADDRESS_KEY: addressKey,
  },
) {
  const directoryDb = new DatabaseSync(":memory:");
  const directoryEnv = agentEnv();
  Object.defineProperty(directoryEnv, "OYSTER_ORIGIN", { value: origin });
  Object.defineProperty(directoryEnv, "OYSTER_OWNER_NAME", { value: "owner" });
  const directoryState = agentDurableObjectState(() => 0);
  Object.defineProperty(directoryState, "storage", {
    value: {
      ...directoryState.storage,
      ...cloudflareStorageFixture(fromNodeSqlite(directoryDb)),
    },
  });
  const directory = new AgentDirectory(directoryState, directoryEnv);
  const agents = new Map<string, WebsiteFixtureAgent>();
  const databases: DatabaseSync[] = [];
  const tasks: Promise<unknown>[] = [];
  const env = agentEnv();
  for (const [property, value] of Object.entries({
    OYSTER_ORIGIN: origin,
    OYSTER_OWNER_NAME: "owner",
    ...hostSecrets,
    AGENT_DIRECTORY: { getByName: () => directory },
    AGENTS: {
      getByName: (name: string) => {
        const existing = agents.get(name);
        if (existing !== undefined) return existing;
        const db = new DatabaseSync(":memory:");
        databases.push(db);
        const state = agentDurableObjectState(() => 0);
        Object.defineProperty(state, "storage", {
          value: {
            ...state.storage,
            ...cloudflareStorageFixture(fromNodeSqlite(db)),
          },
        });
        Object.defineProperty(state, "id", {
          value: { ...state.id, name },
        });
        Object.defineProperty(state, "waitUntil", {
          value: (work: Promise<unknown>) => {
            tasks.push(work);
          },
        });
        const agent = new WebsiteFixtureAgent(state, env);
        agents.set(name, agent);
        return agent;
      },
    },
  }))
    Object.defineProperty(env, property, { value, configurable: true });
  cleanups.push(async () => {
    for (const agent of agents.values()) await agent.close();
    for (const db of databases) db.close();
    directoryDb.close();
  });
  const chosen = directory.create(
    "Fern",
    "request-fern",
    owner,
    "owner-direct",
  );
  const created = directory.websiteCreate(
    owner,
    {
      agentId: chosen.agentId,
      selector: { provider: "web", origins: ["https://shop.example"] },
      persona: "Sell ferns kindly.",
    },
    "request-site",
  );
  if ("error" in created) throw new Error(`fixture: ${created.error}`);
  const app = standaloneWebsiteApp();
  const call = (path: string, init: RequestInit = {}) =>
    Promise.resolve(app.request(`${origin}${path}`, init, env));
  const base = (binding: WebsiteBinding) =>
    `/api/embed/v1/sites/${binding.selector.siteKey}`;
  const post = (
    binding: WebsiteBinding,
    part: string,
    token: string | null,
    body: Readonly<{ requestId?: string; text?: string }> = {},
    requestOrigin = origin,
  ) => {
    const headers = new Headers({
      origin: requestOrigin,
      "content-type": "application/json",
    });
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return call(`${base(binding)}${part}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };
  const credentials = z.object({
    visitorId: z.string(),
    accessToken: z.string(),
  });
  const mint = async (binding: WebsiteBinding) =>
    credentials.parse(await (await post(binding, "/visitors", null)).json());
  const settle = async () => {
    for (const task of tasks.splice(0)) await task;
  };
  return {
    directory,
    chosen,
    binding: created,
    call,
    post,
    base,
    mint,
    settle,
    env,
    agentFor: (binding: WebsiteBinding): WebsiteFixtureAgent => {
      const name = binding.agentId;
      env.AGENTS.getByName(name);
      const agent = agents.get(name);
      if (agent === undefined)
        throw new Error("The website Agent never opened");
      return agent;
    },
  };
}

describe("the public website surface", () => {
  it("serves the launcher, widget and sheet on the same paths as Hub", async () => {
    const { call } = fixture();
    const loader = await call("/embed/v1.js");
    expect(loader.status).toBe(200);
    expect(loader.headers.get("content-type")).toContain("text/javascript");
    expect((await loader.text()).length).toBeGreaterThan(1000);
    expect((await call("/embed/widget.js")).status).toBe(200);
    const sheet = await call("/styles.css");
    expect(sheet.headers.get("content-type")).toContain("text/css");
  });

  it("presents the chosen Agent and refuses a wrong or rotated site key", async () => {
    const { call, binding, directory, chosen } = fixture();
    const page = await call(`/embed/v1/s/${binding.selector.siteKey}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Fern");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://shop.example",
    );
    const wrong = await call(`/embed/v1/s/${channelIds.site.generate()}`);
    expect(wrong.status).toBe(404);
    const rotated = directory.websiteUpdate(owner, binding.bindingId, {
      expectedVersion: binding.authorityVersion,
      rotateSiteKey: true,
    });
    if ("error" in rotated) throw new Error(rotated.error);
    expect((await call(`/embed/v1/s/${binding.selector.siteKey}`)).status).toBe(
      404,
    );
    expect((await call(`/embed/v1/s/${rotated.selector.siteKey}`)).status).toBe(
      200,
    );
    expect(chosen.agentId).toBe(rotated.agentId);
  });

  it("refuses a visitor mint from an origin that is not the embed document", async () => {
    const { post, binding } = fixture();
    const response = await post(
      binding,
      "/visitors",
      null,
      {},
      "https://attacker.example",
    );
    expect(response.status).toBe(403);
  });

  it("refuses new visitors of a suspended site and of a rotated key", async () => {
    const { post, binding, directory } = fixture();
    expect((await post(binding, "/visitors", null)).status).toBe(201);
    const paused = directory.websiteUpdate(owner, binding.bindingId, {
      expectedVersion: binding.authorityVersion,
      lifecycle: "suspended",
    });
    if ("error" in paused) throw new Error(paused.error);
    const refused = await post(binding, "/visitors", null);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "suspended" });
    const resumed = directory.websiteUpdate(owner, binding.bindingId, {
      expectedVersion: paused.authorityVersion,
      lifecycle: "active",
      rotateSiteKey: true,
    });
    if ("error" in resumed) throw new Error(resumed.error);
    const stale = await post(binding, "/visitors", null);
    expect(stale.status).toBe(404);
  });

  it("limits how many visitors one network address may mint", async () => {
    const { post, binding } = fixture();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      statuses.push((await post(binding, "/visitors", null)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("closes the whole surface when the host secrets are missing or short", async () => {
    const { post, binding, mint } = fixture({
      OYSTER_WEBSITE_PROOF_KEY: proofKey,
      OYSTER_WEBSITE_ADDRESS_KEY: "short",
    });
    const response = await post(binding, "/visitors", null);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "website_unavailable" });
    await expect(mint(binding)).rejects.toThrow();
    const noProof = fixture({
      OYSTER_WEBSITE_ADDRESS_KEY: addressKey,
    });
    const visitor = await noProof.mint(noProof.binding);
    const session = await noProof.post(
      noProof.binding,
      "/session",
      visitor.accessToken,
    );
    expect(session.status).toBe(503);
  });

  it("requires Turnstile only where the owner asked for it", async () => {
    const f = fixture();
    const secured = f.directory.websiteUpdate(owner, f.binding.bindingId, {
      expectedVersion: f.binding.authorityVersion,
      turnstile: true,
    });
    if ("error" in secured) throw new Error(secured.error);
    Object.defineProperty(f.env, "TURNSTILE_SITE_KEY", {
      value: "1x".padEnd(24, "0"),
    });
    Object.defineProperty(f.env, "TURNSTILE_SECRET_KEY", {
      value: "1x".padEnd(35, "0"),
    });
    const keyed = f.env;
    const app = standaloneWebsiteApp();
    const mint = (token?: string) =>
      Promise.resolve(
        app.request(
          `${origin}${f.base(secured)}/visitors`,
          {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify(
              token === undefined ? {} : { turnstileToken: token },
            ),
          },
          keyed,
        ),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ success: false }))),
    );
    expect((await mint()).status).toBe(400);
    expect((await mint("bad")).status).toBe(403);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ success: true }))),
    );
    expect((await mint("good")).status).toBe(201);
  });
});

describe("a website visitor's conversation", () => {
  it("answers with the persona added, keeps visitors apart and reads back to the owner", async () => {
    const f = fixture();
    const first = await f.mint(f.binding);
    const second = await f.mint(f.binding);
    const sent = await f.post(f.binding, "/messages", first.accessToken, {
      requestId: "ask-1",
      text: "Do you sell ferns?",
    });
    expect(sent.status).toBe(202);
    await f.settle();
    const firstView = await (
      await f.post(f.binding, "/session", first.accessToken)
    ).text();
    const secondView = await (
      await f.post(f.binding, "/session", second.accessToken)
    ).text();
    expect(firstView).toContain("Do you sell ferns?");
    expect(firstView).toContain("The fern is fine");
    expect(secondView).not.toContain("Do you sell ferns?");

    const agent = f.agentFor(f.binding);
    const conversations = await agent.websiteConversations(f.binding.bindingId);
    const mine = conversations.find(
      ({ party }) =>
        party.kind === "visitor" && party.visitorId === first.visitorId,
    );
    if (mine === undefined) throw new Error("The owner cannot see the visit");
    const transcript = await agent.websiteTranscript(
      f.binding.bindingId,
      mine.sessionId,
    );
    expect(transcript?.lines).toEqual([
      { role: "visitor", text: "Do you sell ferns?" },
      { role: "agent", text: "The fern is fine" },
    ]);
    // The visitor's Session adds the owner's persona to the Agent's own brief.
    const instructions = await agent.instructionsFor(mine.sessionId);
    expect(instructions.text).toContain("OWNER SECRET BRIEF");
    expect(instructions.text).toContain("Sell ferns kindly.");
  });
});

describe("the Agent a website runs on", () => {
  it("runs a visitor's Session on the chosen Agent's own tools while the site is active, and refuses it once paused", async () => {
    const f = fixture();
    const db = new DatabaseSync(":memory:");
    const sql = fromNodeSqlite(db);
    const state = agentDurableObjectState(() => 0);
    Object.defineProperty(state, "storage", {
      value: { ...state.storage, ...cloudflareStorageFixture(sql) },
    });
    Object.defineProperty(state, "id", {
      value: { ...state.id, name: f.binding.agentId },
    });
    const agent = new OptionsAgent(state, f.env);
    cleanups.push(async () => {
      await agent.close();
      db.close();
    });
    const options = await agent.options();
    if (options.tools === undefined || !("sources" in options.tools))
      throw new Error("The Agent has no capability sources");
    // The channel admits or refuses a run; it never changes the Agent's grants.
    expect(options.tools.access).toBeUndefined();
    agent.ensureConversations();
    const visitorId = channelIds.visitor.generate();
    sql.sql.exec(
      "INSERT INTO hub_channel_conversations (binding_id,conversation,session_id,party_json,created_at,last_event_at) VALUES (?,?,?,?,?,?)",
      f.binding.bindingId,
      visitorId,
      "visitor-session",
      JSON.stringify({ kind: "visitor", visitorId }),
      Date.now(),
      Date.now(),
    );
    const sources = options.tools.sources ?? [];
    expect(sources.map(({ id }) => id)).toContain("agent-computers");
    const denied = async (sessionId: string) => {
      const verdicts: boolean[] = [];
      for (const source of sources) {
        const lease = await source.acquire({
          session: { sessionId },
          signal: new AbortController().signal,
          invalidate: () => undefined,
        });
        verdicts.push(lease.snapshot.version === "channel-denied");
        await lease.release();
      }
      return verdicts;
    };
    expect(await denied("visitor-session")).not.toContain(true);
    expect(await denied("owner-session")).not.toContain(true);
    const paused = f.directory.websiteUpdate(owner, f.binding.bindingId, {
      expectedVersion: f.binding.authorityVersion,
      lifecycle: "suspended",
    });
    if ("error" in paused) throw new Error(paused.error);
    expect(await denied("visitor-session")).not.toContain(false);
    expect(await denied("owner-session")).not.toContain(true);
  });
});

describe("the owner's website controls", () => {
  const control = (calls: string[]): StandaloneWebsiteControl => ({
    read: () => {
      calls.push("read");
      return Promise.resolve({ embedOrigin: origin, agents: [], websites: [] });
    },
    create: () => {
      calls.push("create");
      return Promise.resolve({ error: "invalid_input" });
    },
    update: () => {
      calls.push("update");
      return Promise.resolve({ error: "not_found" });
    },
    conversations: () => {
      calls.push("conversations");
      return Promise.resolve([]);
    },
    transcript: () => {
      calls.push("transcript");
      return Promise.resolve(null);
    },
  });
  const ownerKey = ["fixture", "owner", "word"].join("-").padEnd(30, "o");
  const served = (calls: string[]) =>
    serveHost(
      standaloneWebsiteRoutes(control(calls)),
      ownerOrKeyAuth(ownerKey, "owner", () => ({
        verify: () =>
          Promise.resolve({ kind: "error", error: { code: "denied" } }),
      })).authenticate,
      { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
    );

  const bindingId = channelIds.binding.generate();
  const every = [
    ["GET", "/api/websites"],
    ["POST", "/api/websites"],
    ["PUT", `/api/websites/${bindingId}`],
    ["GET", `/api/websites/${bindingId}/conversations`],
    ["GET", `/api/websites/${bindingId}/conversations/some-session`],
  ] as const;

  it("refuses a visitor's token on every owner route", async () => {
    const f = fixture();
    const visitor = await f.mint(f.binding);
    const calls: string[] = [];
    const app = served(calls);
    for (const [method, path] of every) {
      const response = await app.request(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${visitor.accessToken}`,
          "content-type": "application/json",
        },
        body: method === "GET" ? null : "{}",
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it("admits the owner directly, and never through an App", async () => {
    const calls: string[] = [];
    const app = served(calls);
    const asOwner = await app.request(`${origin}/api/websites`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    expect(asOwner.status).toBe(200);
    const mediated = await app.request(`${origin}/api/websites`, {
      headers: {
        authorization: `Bearer ${ownerKey}`,
        "X-Oyster-Installation": "notes",
      },
    });
    expect(mediated.status).toBe(403);
    expect(calls).toEqual(["read"]);
  });

  it("lets only the owner principal change a binding", () => {
    const f = fixture();
    const denied = f.directory.websiteUpdate(stranger, f.binding.bindingId, {
      expectedVersion: f.binding.authorityVersion,
      lifecycle: "suspended",
    });
    expect(denied).toEqual({ error: "not_granted" });
    expect(f.directory.websiteList(stranger)).toEqual({ error: "not_granted" });
    expect(f.directory.websiteList(owner)).toEqual([f.binding]);
  });
});
