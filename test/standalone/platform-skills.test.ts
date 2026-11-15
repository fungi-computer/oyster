import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  admitSkill,
  newSkillAdmission,
  parseSkill,
} from "@fungi.computer/shiitake-extensions/skills/discovery";
import { describe, expect, it } from "vitest";

import { platformSkillFiles } from "../../src/platform-skills.generated.js";
import { renderPlatformSkills } from "../../scripts/platform-skills.mjs";

describe("the built-in skill bundle", () => {
  it("is what the generator would write from skills/ now", async () => {
    const committed = await readFile(
      join(import.meta.dirname, "../../src/platform-skills.generated.ts"),
      "utf8",
    );
    expect(await renderPlatformSkills()).toBe(committed);
  });

  it("holds only well-formed skills: each folder has a SKILL.md that parses and is admitted without a diagnostic", () => {
    const folders = new Set(
      platformSkillFiles.map(({ path }) => path.slice(0, path.indexOf("/"))),
    );
    const state = newSkillAdmission();
    for (const folder of folders) {
      const file = platformSkillFiles.find(
        ({ path }) => path === `${folder}/SKILL.md`,
      );
      expect(file, `${folder} has a SKILL.md`).toBeDefined();
      const { metadata } = parseSkill(file?.content ?? "", folder);
      admitSkill(state, {
        metadata,
        directoryName: folder,
        skillPath: `${folder}/SKILL.md`,
        location: `${folder}/SKILL.md`,
        displayLocation: `${folder}/SKILL.md`,
        origin: { kind: "platform" },
      });
    }
    expect(state.diagnostics).toEqual([]);
    expect(state.skills.map(({ name }) => name).sort()).toEqual(
      [...folders].sort(),
    );
    expect(new Set(state.skills.map(({ name }) => name)).size).toBe(
      state.skills.length,
    );
  });

  it("names no retained API, keeps each description under the prompt limit and states the override rule", () => {
    const retained =
      /sandbox_|dashboard\.promote|project_create|local_|Restart Agent|workspace: "memory"/u;
    for (const { path, content } of platformSkillFiles)
      expect(content, path).not.toMatch(retained);
    for (const { path, content } of platformSkillFiles) {
      if (!path.endsWith("/SKILL.md")) continue;
      const { metadata } = parseSkill(content, path.split("/")[0] ?? "");
      expect(metadata.description.length, path).toBeLessThan(512);
    }
    const computing = platformSkillFiles.find(
      ({ path }) => path === "fungible-computing/SKILL.md",
    );
    expect(computing?.content).toContain(".agents/skills/debug-fungi/SKILL.md");
    expect(computing?.content).toContain("`skill.load` returns yours");
  });
});
