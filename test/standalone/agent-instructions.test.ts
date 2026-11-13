import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { describe, expect, it } from "vitest";

import {
  createAgentInstructions,
  withOwnerInstructions,
  type LoadedInstructions,
} from "../../src/agent-instructions.js";
import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";

describe("an Agent's standing instructions", () => {
  it("start empty, replace on every write and count each edit", () => {
    const sql = fromNodeSqlite(new DatabaseSync(":memory:")).sql;
    const store = createAgentInstructions(sql);
    expect(store.read()).toEqual({ instructions: "", version: 0 });
    expect(store.write("Be brief.")).toEqual({
      instructions: "Be brief.",
      version: 1,
    });
    expect(store.write("Be kind.")).toEqual({
      instructions: "Be kind.",
      version: 2,
    });
    expect(store.write("")).toEqual({ instructions: "", version: 3 });
  });

  it("refuse text past the bound without changing what is stored", () => {
    const sql = fromNodeSqlite(new DatabaseSync(":memory:")).sql;
    const store = createAgentInstructions(sql);
    store.write("Be brief.");
    expect(() => store.write("x".repeat(4_001))).toThrow();
    expect(store.read()).toEqual({ instructions: "Be brief.", version: 1 });
    expect(store.write("x".repeat(4_000)).version).toBe(2);
  });

  it("come after the fixed instructions and never replace them", () => {
    const fixed: LoadedInstructions = {
      revision: "oyster-7",
      text: "FIXED RULES",
    };
    expect(
      withOwnerInstructions(fixed, { instructions: "  ", version: 4 }),
    ).toBe(fixed);
    const composed = withOwnerInstructions(fixed, {
      instructions: "Answer in French.",
      version: 2,
    });
    expect(composed.revision).toBe("oyster-7+owner-2");
    expect(composed.text.startsWith("FIXED RULES\n")).toBe(true);
    expect(composed.text.endsWith("Answer in French.")).toBe(true);
    expect(composed.text.indexOf("FIXED RULES")).toBeLessThan(
      composed.text.indexOf("Answer in French."),
    );
  });
});

/** The production Agent's real option composition, unchanged. */
class OptionsAgent extends StandaloneAgentBase {
  protected hostFor(): never {
    return unavailable();
  }
  options() {
    return super.shiitakeOptions();
  }
  close() {
    return this.closeShiitake();
  }
}

describe("the Agent a turn runs on", () => {
  it("loads Oyster's fixed instructions, then the owner's, and a new edit on the next load", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = fromNodeSqlite(db);
    const state = agentDurableObjectState(() => 0);
    Object.defineProperty(state, "storage", {
      value: { ...state.storage, ...cloudflareStorageFixture(sql) },
    });
    const agent = new OptionsAgent(state, agentEnv());
    try {
      const { instructions } = await agent.options();
      const load = () =>
        instructions.load({
          sessionId: "session",
          commandId: "command",
          signal: new AbortController().signal,
        });
      const plain = await load();
      expect(plain.revision).toBe("oyster-7");
      expect(agent.readInstructions()).toBe("");
      agent.writeInstructions("Always answer in French.");
      const written = await load();
      expect(written.revision).toBe("oyster-7+owner-1");
      expect(written.text.startsWith(plain.text)).toBe(true);
      expect(written.text).toContain("Always answer in French.");
      agent.writeInstructions("Always answer in Spanish.");
      const edited = await load();
      expect(edited.revision).toBe("oyster-7+owner-2");
      expect(edited.text).not.toContain("French");
      expect(edited.text).toContain("Always answer in Spanish.");
      agent.writeInstructions("");
      expect((await load()).text).toBe(plain.text);
    } finally {
      await agent.close();
      db.close();
    }
  });
});
