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

  it("ships setup-fungi: at most 3 questions, propose then act, then hand off once", () => {
    const setup = platformSkillFiles.find(
      ({ path }) => path === "setup-fungi/SKILL.md",
    );
    const raw = setup?.content ?? "";
    const text = raw.replace(/\s+/gu, " ");
    expect(parseSkill(raw, "setup-fungi").metadata.name).toBe("setup-fungi");
    expect(text).toContain("at most 3 questions");
    expect(text).toContain('"Do it", "Change something", "Skip"');
    expect(text).toContain('Delete the "First conversation" section');
    expect(text).toContain("call `setup.finish()` once");
    expect(text).toContain("`gitTeam.clone`");
    expect(text.indexOf("First result")).toBeLessThan(
      text.indexOf("call `setup.finish()`"),
    );
    expect(text).not.toMatch(/Shed|Trellis|Bonsai/u);
  });

  it("ends setup with a one-time naming offer that renames only when the person picks a name", () => {
    const text = (
      platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
        ?.content ?? ""
    ).replace(/\s+/gu, " ");
    const finish = text.slice(text.indexOf("5. Finish."));
    const offer = finish.slice(finish.indexOf("Offer a name"));
    expect(offer).toContain("Keep Shiitake");
    expect(offer).toContain("two names you suggest");
    expect(offer).toContain("free text");
    expect(offer).toContain("`self.rename`");
    expect(offer).toMatch(/only when they pick a new name/u);
    expect(offer).toMatch(/does not count against the 3 questions/u);
    expect(offer).toMatch(/When the `self` tool is absent, skip it/u);
    // Once, and before the hand-off.
    expect(finish.split("Offer a name")).toHaveLength(2);
    expect(finish.indexOf("Offer a name")).toBeLessThan(
      finish.indexOf("call `setup.finish()`"),
    );
  });

  it("offers dashboard widgets only for what was set up, adds one only when tapped, and never the hidden Apps", () => {
    const text = (
      platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
        ?.content ?? ""
    ).replace(/\s+/gu, " ");
    const finish = text.slice(text.indexOf("5. Finish."));
    const offer = finish.slice(
      finish.indexOf("Offer"),
      finish.indexOf("Delete the"),
    );
    const dashboard = offer.slice(offer.indexOf("Add to your dashboard") - 80);
    expect(dashboard).toContain("Add to your dashboard");
    for (const widget of [
      "Grove Inbox",
      "Inkcap Recent Files",
      "Prints Recent Outputs",
    ])
      expect(dashboard).toContain(widget);
    expect(dashboard).toContain("`widgets.available`");
    expect(dashboard).toContain("`layout.get`");
    expect(dashboard).toContain("`layout.place`");
    expect(dashboard).toMatch(/basedOn/u);
    expect(dashboard).toMatch(/only when the person taps/u);
    expect(dashboard).toMatch(/never add one yourself/iu);
    expect(dashboard).toMatch(/skip a widget whose required parameter/u);
    expect(dashboard).toMatch(/When those methods are absent, skip it/u);
    expect(finish.indexOf("Add to your dashboard")).toBeLessThan(
      finish.indexOf("Delete the"),
    );
    expect(finish.indexOf("Offer a name")).toBeLessThan(
      finish.indexOf("Add to your dashboard"),
    );
    // The offers are not a tour: nothing before step 5 mentions the dashboard.
    expect(text.slice(0, text.indexOf("5. Finish."))).not.toMatch(
      /dashboard/iu,
    );
  });

  it("gives the money line only to a host that has setup.finish", () => {
    const text =
      platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
        ?.content ?? "";
    const finish = text.slice(text.indexOf("5. Finish."));
    const outside = text.slice(0, text.indexOf("5. Finish."));
    const bullets = finish
      .split(/\n {3}- /u)
      .map((bullet) => bullet.replace(/\s+/gu, " "));
    const money = bullets.filter((bullet) => bullet.includes("start Pro"));
    expect(money).toHaveLength(1);
    expect(money[0]).toMatch(/^When the `setup.finish` tool is available/u);
    expect(money[0]).toMatch(/call\s+`setup\.finish\(\)`\s+once/u);
    // Nothing before step 5, and no unconditional bullet in it, says Pro or wallet.
    expect(outside).not.toMatch(/start Pro|wallet|Pro\b/u);
    const absent = bullets.filter((bullet) =>
      bullet.startsWith("When the `setup.finish` tool is absent"),
    );
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatch(/stop\s+after\s+the\s+two-line\s+summary/u);
    expect(absent[0]).toMatch(/call\s+nothing/u);
    const unconditional = bullets.filter(
      (bullet) => !bullet.startsWith("When the `setup.finish` tool"),
    );
    for (const bullet of unconditional.slice(1))
      expect(bullet).not.toMatch(/Pro\b|wallet|setup\.finish/u);
  });
});
