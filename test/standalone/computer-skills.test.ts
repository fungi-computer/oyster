import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import type { FilesPort } from "@fungi.computer/knapsack";
import { describe, expect, it } from "vitest";

import { StandaloneAgentBase } from "../../src/standalone/agents.js";
import {
  agentDurableObjectState,
  agentEnv,
  unavailable,
} from "./agent-do-state.fixture.js";
import { cloudflareStorageFixture } from "./cloudflare-storage.fixture.js";
import {
  computerSkillsEmpty,
  createComputerSkillSource,
  type SkillComputer,
} from "../../src/standalone/computer-skill-source.js";

const signal = new AbortController().signal;

/**
 * An in-memory Computer: the Files port answers the way the real workspace
 * port does for these calls (absolute result paths, a limit with a truncated
 * flag, paged reads, an error for a path that is not there).
 */
function computer(
  name: string,
  files: Readonly<Record<string, string>>,
): SkillComputer {
  const encoder = new TextEncoder();
  const absolute = (path: string) => (path.startsWith("/") ? path : `/${path}`);
  const port: FilesPort = {
    read: (input) => {
      const text = files[absolute(input.path).slice(1)];
      if (text === undefined)
        return Promise.reject(new Error(`ENOENT ${input.path}`));
      const bytes = encoder.encode(text);
      const page = bytes.subarray(input.offset, input.offset + input.limit);
      const next = input.offset + page.byteLength;
      return Promise.resolve({
        path: input.path,
        content: new TextDecoder().decode(page),
        offset: input.offset,
        nextOffset: next < bytes.byteLength ? next : null,
        truncated: next < bytes.byteLength,
      });
    },
    glob: (input) => {
      const root = `${absolute(input.path).slice(1)}/`;
      const tail = input.pattern.replace("**/", "");
      const found = Object.keys(files)
        .filter(
          (path) =>
            path.startsWith(root) &&
            (tail === "*" || path.endsWith(`/${tail}`)),
        )
        .sort();
      if (
        found.length === 0 &&
        !Object.keys(files).some((p) => p.startsWith(root))
      )
        return Promise.reject(new Error(`ENOENT ${input.path}`));
      return Promise.resolve({
        path: input.path,
        results: found
          .slice(0, input.limit)
          .map((path) => ({ path: `/${path}`, type: "file" as const })),
        truncated: found.length > input.limit ? ("limit" as const) : null,
      });
    },
    list: () => Promise.reject(new Error("not used")),
    grep: () => Promise.reject(new Error("not used")),
    replace: () => Promise.reject(new Error("not used")),
  };
  return { name, port };
}

const skill = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const source = (...computers: SkillComputer[]) =>
  createComputerSkillSource({ computers: () => Promise.resolve(computers) });

describe("skills on an Agent's Computer", () => {
  it("lists a skill folder by name and description, without its body", async () => {
    const found = await source(
      computer("studio", {
        ".agents/skills/watering/SKILL.md": skill(
          "watering",
          "Water the ferns on a schedule",
        ),
        ".agents/skills/watering/reference/plants.md": "Ferns like shade.",
      }),
    ).catalog(signal);
    expect(found.skills).toEqual([
      {
        name: "watering",
        description: "Water the ferns on a schedule",
        location: "/.agents/skills/watering/SKILL.md",
        displayLocation: "/.agents/skills/watering/SKILL.md",
        origin: { kind: "project" },
      },
    ]);
    expect(JSON.stringify(found)).not.toContain("Do the thing.");
    expect(found.diagnostics).toEqual([]);
  });

  it("loads the body without its frontmatter, lists supporting files and reads one", async () => {
    const watering = source(
      computer("studio", {
        ".agents/skills/watering/SKILL.md": skill(
          "watering",
          "Water the ferns",
          "Water weekly.",
        ),
        ".agents/skills/watering/reference/plants.md": "Ferns like shade.",
        ".agents/skills/watering/notes.txt": "n",
      }),
    );
    const loaded = await watering.read("watering", undefined, signal);
    expect(loaded).toMatchObject({
      name: "watering",
      file: "SKILL.md",
      content: "Water weekly.\n",
      baseDirectory: "/.agents/skills/watering",
      supportingFiles: ["notes.txt", "reference/plants.md"],
    });
    const support = await watering.read(
      "watering",
      "reference/plants.md",
      signal,
    );
    expect(support.content).toBe("Ferns like shade.");
    await expect(
      watering.read("watering", "../other/SKILL.md", signal),
    ).rejects.toThrow();
    await expect(watering.read("missing", undefined, signal)).rejects.toThrow(
      "Unknown or hidden skill",
    );
  });

  it("refuses a malformed SKILL.md and says why, while the good skills still load", async () => {
    const found = await source(
      computer("studio", {
        ".agents/skills/good/SKILL.md": skill("good", "A fine skill"),
        ".agents/skills/bare/SKILL.md": "No frontmatter at all.\n",
        ".agents/skills/yaml/SKILL.md": "---\nname: [oops\n---\nbody\n",
        ".agents/skills/types/SKILL.md": "---\ndescription: 7\n---\nbody\n",
        ".agents/skills/blank/SKILL.md": "---\nname: blank\n---\nbody\n",
      }),
    ).catalog(signal);
    expect(found.skills.map(({ name }) => name)).toEqual(["good"]);
    const reasons = Object.fromEntries(
      found.diagnostics.map((item) => [item.path, item.message]),
    );
    expect(reasons["/.agents/skills/bare/SKILL.md"]).toBe(
      "SKILL.md requires YAML frontmatter",
    );
    expect(reasons["/.agents/skills/yaml/SKILL.md"]).toBe(
      "Skill frontmatter is not valid YAML",
    );
    expect(reasons["/.agents/skills/types/SKILL.md"]).toBe(
      "Skill frontmatter has invalid field types",
    );
    expect(reasons["/.agents/skills/blank/SKILL.md"]).toBe(
      "description is required",
    );
  });

  it("refuses an oversized SKILL.md and an oversized supporting file", async () => {
    const huge = skill("huge", "Too big", "x".repeat(130 * 1024));
    const roomy = source(
      computer("studio", {
        ".agents/skills/huge/SKILL.md": huge,
        ".agents/skills/ok/SKILL.md": skill("ok", "Fine"),
        ".agents/skills/ok/big.md": "y".repeat(130 * 1024),
      }),
    );
    const found = await roomy.catalog(signal);
    expect(found.skills.map(({ name }) => name)).toEqual(["ok"]);
    expect(
      found.diagnostics.find((item) => item.path.includes("/huge/"))?.message,
    ).toBe("Skill file exceeds the 128 KiB bound");
    await expect(roomy.read("ok", "big.md", signal)).rejects.toThrow(
      "Skill file exceeds the 128 KiB bound",
    );
  });

  it("lets the first name win, in .fungi/skills before .agents/skills, and says so", async () => {
    const found = await source(
      computer("studio", {
        ".fungi/skills/herdr/SKILL.md": skill("herdr", "The project's own"),
        ".agents/skills/herdr/SKILL.md": skill("herdr", "A shared one"),
      }),
    ).catalog(signal);
    expect(found.skills.map(({ description }) => description)).toEqual([
      "The project's own",
    ]);
    expect(found.diagnostics.map(({ reason }) => reason)).toEqual([
      "collision",
    ]);
    expect(found.diagnostics[0]?.message).toContain("herdr");
  });

  it("skips a skill that turns model invocation off and a dot folder inside a root", async () => {
    const found = await source(
      computer("studio", {
        ".agents/skills/quiet/SKILL.md":
          "---\nname: quiet\ndescription: Hidden\ndisable-model-invocation: true\n---\nbody\n",
        ".agents/skills/.cache/stale/SKILL.md": skill("stale", "Stale"),
      }),
    ).catalog(signal);
    expect(found.skills).toEqual([]);
    expect(found.diagnostics.map(({ reason }) => reason).sort()).toEqual([
      "skipped",
      "skipped",
    ]);
  });

  it("names the Computer in a skill's location only when the Agent has several", async () => {
    const files = {
      ".agents/skills/watering/SKILL.md": skill("watering", "W"),
    };
    const [one] = (await source(computer("studio", files)).catalog(signal))
      .skills;
    expect(one?.location).toBe("/.agents/skills/watering/SKILL.md");
    const [two] = (
      await source(computer("studio", files), computer("laptop", {})).catalog(
        signal,
      )
    ).skills;
    expect(two?.location).toBe(
      "computer://studio/.agents/skills/watering/SKILL.md",
    );
  });

  it("finds nothing, quietly, on a Computer without a skills folder or without any Computer", async () => {
    expect(
      (await source(computer("studio", { "notes.md": "n" })).catalog(signal))
        .skills,
    ).toEqual([]);
    const none = await source().catalog(signal);
    expect(none.skills).toEqual([]);
    expect(none.diagnostics.map(({ reason }) => reason)).toEqual(["empty"]);
    expect(computerSkillsEmpty).toContain(".agents/skills/<name>/SKILL.md");
  });

  it("admits at most 64 skills", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `.agents/skills/skill-${String(index).padStart(2, "0")}/SKILL.md`,
        skill(`skill-${String(index).padStart(2, "0")}`, "A skill"),
      ]),
    );
    const found = await source(computer("studio", files)).catalog(signal);
    expect(found.skills).toHaveLength(64);
    expect(found.diagnostics.some(({ reason }) => reason === "bound")).toBe(
      true,
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

describe("the Agent a Computer's skills reach", () => {
  it("offers skill discovery with the owner's other extensions, and grants it prompt, run tools and commands only", async () => {
    const db = new DatabaseSync(":memory:");
    const state = agentDurableObjectState(() => 0);
    Object.defineProperty(state, "storage", {
      value: {
        ...state.storage,
        ...cloudflareStorageFixture(fromNodeSqlite(db)),
      },
    });
    const agent = new OptionsAgent(state, agentEnv());
    try {
      const { extensions } = await agent.options();
      const ids = extensions.roster.map(({ manifest }) => manifest.id);
      expect(ids).toContain("botanical-skills");
      // Skills come beside the ordinary roster, never in place of it.
      expect(ids).toContain("botanical-almanac");
      expect(ids).toContain("botanical-session-question");
      const grant = extensions.grants.find(
        ({ id }) => id === "botanical-skills",
      );
      expect([...(grant?.capabilities ?? [])].sort()).toEqual([
        "commands",
        "prompt",
        "run_tools",
      ]);
    } finally {
      await agent.close();
      db.close();
    }
  });
});
