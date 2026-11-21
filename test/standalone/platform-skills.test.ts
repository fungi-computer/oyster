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

  it("ships setup-fungi: at most 3 cards, propose then act, then hand off once", () => {
    const setup = platformSkillFiles.find(
      ({ path }) => path === "setup-fungi/SKILL.md",
    );
    const raw = setup?.content ?? "";
    const text = raw.replace(/\s+/gu, " ");
    expect(parseSkill(raw, "setup-fungi").metadata.name).toBe("setup-fungi");
    expect(text).toContain("at most 3 cards");
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
    // The Agent may already have been renamed: the first option names its own name.
    expect(offer).toContain("Keep <your name>");
    expect(offer).not.toContain("Keep Shiitake");
    expect(offer).toContain("two names you suggest");
    expect(offer).toContain("free text");
    expect(offer).toContain("await env.self.rename({name})");
    expect(offer).toMatch(/only when they pick a new name/iu);
    // Levi: an option that lets them type their own answer is fine.
    expect(offer).not.toMatch(/add no option that only means/u);
    // Called directly: a forage lookup of a hidden tool reads as "absent".
    expect(offer).toMatch(/do not look it up first/u);
    expect(offer).toMatch(/If `env.self` is missing or the call is refused/u);
    // Once, and before the hand-off.
    expect(finish.split("Offer a name")).toHaveLength(2);
    expect(finish.indexOf("Offer a name")).toBeLessThan(
      finish.indexOf("call `setup.finish()`"),
    );
  });

  it("makes the two offers a required checklist the Agent may not end its turn before", () => {
    const text = (
      platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
        ?.content ?? ""
    ).replace(/\s+/gu, " ");
    const finish = text.slice(text.indexOf("5. Finish."));
    expect(finish).toMatch(
      /^5\. Finish\. Do every item below, in order\. Do not end your turn before the name offer and the dashboard offer have each been asked, failed, or skipped/u,
    );
    // A blocked setup step does not cancel the offers; an answered card is final.
    expect(finish).toMatch(/Even if part of setup is blocked/u);
    expect(finish).toMatch(/do not ask it again in text/u);
    expect(finish).toContain("Offer a name, once (required)");
    // The name card is answered before anything else: never the non-blocking
    // `continue` mode, which let an Agent carry on to the dashboard unanswered.
    expect(finish).toMatch(
      /Wait for their pick: call `question.ask` without `mode`, never `mode: "continue"`/u,
    );
    expect(finish).toMatch(/make no dashboard call until they have picked/u);
    // A new name is applied straight away, before any other call.
    expect(finish).toMatch(
      /the moment they pick a new name, your very next call is `await env\.self\.rename\(\{name\}\)`/u,
    );
    // A repeat of step 5 (after a failure, say) never asks or renames twice.
    expect(finish).toMatch(
      /at most once in the whole conversation, even if you run step 5 again/u,
    );
    expect(text).toMatch(
      /never ask it again, not even after an empty or interrupted turn/u,
    );
    // Decisions are cards, a name is never settled silently, and several files are one approval.
    expect(text).toMatch(
      /Every decision is a `question\.ask` card, including "Do it\?"\. Never end a turn asking the person to reply with options in text/u,
    );
    expect(text).toMatch(
      /Never settle it yourself by saying you keep your name/u,
    );
    expect(text).toMatch(/several in one `files\.patch` of Add File blocks/u);
    // A non-retryable failure is tried once more at most, differently; files never go through heredocs.
    expect(text).toMatch(
      /says it is not retryable, such as a generation, try at most once more with clearly different input/u,
    );
    expect(text).toMatch(/never shell heredocs inside `execute`/u);
    // Home's AGENTS.md is listed before it is read, so a fresh Computer shows no red error.
    expect(text).toMatch(
      /First list your Computer's top folder, never read `AGENTS\.md` blind/u,
    );
    // A failed build never ends setup, and `unknown` is not yet a failure.
    expect(text).toMatch(/never ends setup: say what failed in one line/u);
    expect(text).toMatch(/`unknown` means it may still be running/u);
    // The Keep option names the Agent's real name from its instructions.
    expect(text).toMatch(
      /where your name is the one in your instructions \("Your name is …"\), copied verbatim and never guessed/u,
    );
    // A Prints setup points at the methods and does not send the Agent hunting.
    expect(text).toMatch(/`PRINTS\.setFavorite`.*`PRINTS\.listFavorites`/u);
    expect(text).toMatch(
      /no method lets you choose it, so do not search for one/u,
    );
    expect(finish).toContain('Offer "Add to your dashboard" (required)');
  });

  it("offers dashboard widgets only for what was set up, places one through the approval card, and never the hidden Apps", () => {
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
    expect(dashboard).toContain("await env.TOURTOIS.widgets.available({})");
    expect(dashboard).toContain("await env.TOURTOIS.layout.get({})");
    expect(dashboard).toContain("await env.TOURTOIS.layout.place({ ... })");
    expect(dashboard).toMatch(/basedOn/u);
    // The Hub's approval card is the person's choice: no `question.ask` card.
    expect(dashboard).toMatch(/Do not use `question.ask` here/u);
    expect(dashboard).not.toMatch(/plus "Not now"/u);
    expect(dashboard).toMatch(/at most 2 matching widgets/u);
    expect(dashboard).toMatch(/one plain line first/u);
    expect(dashboard).toContain(
      "I'm adding Inbox to your dashboard; approve the card if you want it.",
    );
    expect(dashboard).toMatch(/The approval card is their choice/u);
    expect(dashboard).toMatch(
      /Denied or expired means move on: do not retry or ask again/u,
    );
    expect(dashboard).toMatch(/never place one without that approval/iu);
    expect(dashboard).toMatch(/Skip a widget only when a required parameter/u);
    // Every required parameter is passed, so the person never approves a doomed call.
    expect(dashboard).toMatch(
      /pass every key the widget lists as required in `params`, for example `params: \{ computer: <id> \}`/u,
    );
    expect(dashboard).toMatch(/Never call `layout\.place` without them/u);
    // No clear match is never a reason to skip: the most generally useful one is offered.
    expect(dashboard).toMatch(
      /If no widget clearly matches what you did, offer the most generally useful one: Inbox first, then Recent Files/u,
    );
    expect(dashboard).toMatch(
      /Skip the offer only when `widgets.available` returns nothing but the launcher/u,
    );
    expect(dashboard).not.toMatch(/If none match, skip the offer/u);
    // A Computer parameter is filled in, not a reason to skip, when the choice is clear.
    expect(dashboard).toMatch(
      /parameter is a Computer and the Team has exactly one, use the id/u,
    );
    expect(dashboard).toMatch(
      /Skip a widget whose required Computer you cannot fill because the Team has none, or more than one/u,
    );
    expect(dashboard).toMatch(/the id from your\s+instructions/u);
    expect(dashboard).toMatch(/If `env.TOURTOIS` is missing or a call fails/u);
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

  it("makes the name offer a card, never text, and never asks yes or no before placing a widget", () => {
    const text = (
      platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
        ?.content ?? ""
    ).replace(/\s+/gu, " ");
    expect(text).toMatch(
      /Ask the name only as a `question\.ask` card, never in plain text/u,
    );
    expect(text).toMatch(
      /Never say there is no dashboard offer before you have called `await env\.TOURTOIS\.widgets\.available\(\{\}\)`/u,
    );
    expect(text).toMatch(
      /Never ask a yes or no question before `layout\.place`: if a widget needs something the person must do first, say so in one line and skip that widget/u,
    );
  });

  it("counts cards, never asks the person's own name, and allows a type-it option", () => {
    const text = (
      platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
        ?.content ?? ""
    ).replace(/\s+/gu, " ");
    expect(text).toMatch(
      /Ask at most 3 cards in total, counting the "Do it\?" plan and the name offer/u,
    );
    expect(text).toMatch(/Do not ask for the person's own name/u);
    expect(text).not.toMatch(/never add an option that only means/u);
    expect(text).not.toMatch(/count against the 3 questions/u);
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
