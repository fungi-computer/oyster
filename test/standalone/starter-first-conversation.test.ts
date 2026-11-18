import { afterEach, expect, it, vi } from "vitest";
import {
  StandaloneAgentBase,
  type StandaloneAgentEnv,
} from "../../src/standalone/agents.js";
import { defaultTenant } from "../../src/tenant.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";

/**
 * The Agent half of the starter's no-Home fallback: the setup prompt kept on
 * the Agent's own record rides in its instructions until it has a Home, then
 * moves into that Home's AGENTS.md when it has none.
 */
const prompt = "## First conversation\nLoad setup-fungi and follow it.\n";
const actor = JSON.stringify({ kind: "owner" });
const key = "first-conversation";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The Home's AGENTS.md as this test holds it; `null` is an absent file. */
type HomeFile = { content: string | null; writers: string[]; fails: boolean };

class StarterAgent extends StandaloneAgentBase {
  home: HomeFile = { content: null, writers: [], fails: false };
  hasHome = false;
  protected hostFor(): never {
    return unavailable();
  }
  // The Home Computer's file, with the create-only rule the real one keeps.
  override replaceInstructions(
    writer: string,
    expected: string | null,
    content: string,
  ): ReturnType<StandaloneAgentBase["replaceInstructions"]> {
    if (this.home.fails) return Promise.reject(new Error("Computer offline"));
    if (!this.hasHome) return Promise.resolve({ error: "no_home" as const });
    if (this.home.content !== expected)
      return Promise.resolve({ error: "conflict" as const });
    this.home.content = content;
    this.home.writers.push(writer);
    return Promise.resolve({
      home: { name: "Home" },
      content,
      bytes: new TextEncoder().encode(content).byteLength,
      limit: 64 * 1024,
    });
  }
  async promptText(): Promise<string> {
    return (await this.agentInstructions()).text;
  }
  async promptRevision(): Promise<string> {
    return (await this.agentInstructions()).revision;
  }
}

/** What this Agent's store holds here: its policy-directory pin, or a kept prompt. */
type Stored =
  | Readonly<{ directoryName: string; tenantId: string }>
  | Readonly<{ content: string; actor: string }>;

/** One Agent over a map-backed store, and the directory's view of its Home. */
function starter(options: { kept?: boolean; home: boolean }) {
  const store = new Map<string, Stored>([
    [
      "app-policy-directory",
      { directoryName: "agents", tenantId: defaultTenant },
    ],
  ]);
  if (options.kept === true) store.set(key, { content: prompt, actor });
  const state = agentDurableObjectState(() => 0);
  Object.defineProperty(state, "storage", {
    value: {
      ...state.storage,
      get: (name: string) => Promise.resolve(store.get(name)),
      put: (name: string, value: Stored) => {
        store.set(name, value);
        return Promise.resolve();
      },
      delete: (name: string) => Promise.resolve(store.delete(name)),
    },
  });
  const env: StandaloneAgentEnv = agentEnv();
  const attachments = [
    {
      attachmentId: "starter-home:v1",
      agentId: "agent_fixture",
      computerId: "agent-fixture",
      version: 1,
      name: "Home",
      admission: null,
    },
  ];
  const agent = new StarterAgent(state, env);
  agent.hasHome = options.home;
  Object.defineProperty(env, "AGENT_DIRECTORY", {
    value: {
      getByName: () => ({
        agentComputerRevision: () => Promise.resolve(agent.hasHome ? 2 : 1),
        agentComputerSnapshot: () =>
          Promise.resolve({
            scopeId: "agents",
            agentId: "agent_fixture",
            projection: {
              revision: agent.hasHome ? 2 : 1,
              attachments: agent.hasHome ? attachments : [],
            },
          }),
      }),
    },
  });
  return { agent, store };
}

it("carries the kept setup prompt in its instructions while it has no Home", async () => {
  const { agent } = starter({ home: false });
  const bare = await agent.promptText();
  await agent.seedFirstConversation(prompt, actor);
  const text = await agent.promptText();
  expect(text).toBe(bare + "\n\n" + prompt);
  expect(await agent.promptRevision()).toBe("oyster-7+first-conversation");
});

it("keeps the first prompt it was given, and is seeded once", async () => {
  const { agent, store } = starter({ home: false });
  await agent.seedFirstConversation(prompt, actor);
  await agent.seedFirstConversation("something else", actor);
  expect(store.get(key)).toEqual({ content: prompt, actor });
});

it("moves the kept prompt into a Home that gains a Computer midway, as the owner, once", async () => {
  const { agent, store } = starter({ home: false, kept: true });
  expect(await agent.promptText()).toContain("First conversation");
  // The owner attaches a Computer during the interview.
  agent.hasHome = true;
  expect(await agent.promptText()).not.toContain("First conversation");
  expect(await agent.promptRevision()).toBe("oyster-7");
  expect(agent.home.content).toBe(prompt);
  expect(agent.home.writers).toEqual([actor]);
  expect(store.has(key)).toBe(false);
  await agent.promptText();
  expect(agent.home.writers).toEqual([actor]);
});

it("leaves an AGENTS.md the Home already has as it is, and drops the kept copy", async () => {
  const { agent, store } = starter({ home: true, kept: true });
  agent.home.content = "mine\n";
  expect(await agent.promptText()).not.toContain("First conversation");
  expect(agent.home.content).toBe("mine\n");
  expect(agent.home.writers).toEqual([]);
  expect(store.has(key)).toBe(false);
});

it("keeps carrying the prompt while the Home cannot be written, then moves it", async () => {
  const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { agent, store } = starter({ home: true, kept: true });
  agent.home.fails = true;
  expect(await agent.promptText()).toContain("First conversation");
  expect(store.has(key)).toBe(true);
  await vi.waitFor(() => {
    expect(failed).toHaveBeenCalledWith(
      "starter setup prompt move failed",
      expect.stringContaining("Computer offline"),
    );
  });
  agent.home.fails = false;
  expect(await agent.promptText()).not.toContain("First conversation");
  expect(agent.home.content).toBe(prompt);
  expect(store.has(key)).toBe(false);
});

it("leaves an Agent with no kept prompt exactly as it was", async () => {
  const noHome = starter({ home: false });
  expect(await noHome.agent.promptRevision()).toBe("oyster-7");
  expect(await noHome.agent.promptText()).not.toContain("First conversation");
  expect([...noHome.store.keys()]).toEqual(["app-policy-directory"]);
  const withHome = starter({ home: true });
  expect(await withHome.agent.promptRevision()).toBe("oyster-7");
  expect(withHome.agent.home.writers).toEqual([]);
  expect([...withHome.store.keys()]).toEqual(["app-policy-directory"]);
});
