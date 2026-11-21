import { Script } from "node:vm";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Knapsack, type FilesPort } from "@fungi.computer/knapsack";
import { describe, expect, it } from "vitest";
import { platformSkillFiles } from "../../src/platform-skills.generated.js";
import { run6Developer } from "./setup-run6.fixture.js";

const setup =
  platformSkillFiles.find(({ path }) => path === "setup-fungi/SKILL.md")
    ?.content ?? "";
const text = setup.replace(/\s+/gu, " ");

describe("run 6 developer file-writing guidance", () => {
  it("uses the advertised direct patch tool instead of the nonexistent write method", () => {
    expect(text).toContain("direct `apply_patch` tool");
    expect(text.indexOf("direct `apply_patch` tool")).toBeLessThan(
      text.indexOf("- Instructions."),
    );
    expect(text).not.toContain("`files.write`");
    expect(text).toContain("An absent `AGENTS.md` is not read");
    expect(text).not.toContain(
      "your Computer is still finishing its first start",
    );
  });

  it("passes the run 6 template literal as patch data without compiling it as execute source", async () => {
    expect(
      () => new Script(`(async () => {\n${run6Developer.brokenExecute}\n})`),
    ).toThrow(SyntaxError);
    expect(run6Developer.listing.results.map(({ path }) => path)).not.toContain(
      "/workspace/AGENTS.md",
    );
    const received: string[] = [];
    const unused = (): never => {
      throw new Error("Unexpected Files operation");
    };
    const port: FilesPort = {
      read: unused,
      list: unused,
      glob: unused,
      grep: unused,
      replace: unused,
      patch: (input) => {
        received.push(input.patch);
        return Promise.resolve({
          status: "completed",
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        });
      },
    };
    const { tools } = Knapsack.files({ port });
    expect(tools.map(({ descriptor }) => descriptor.name)).not.toContain(
      "write",
    );
    const patch = tools.find(
      ({ descriptor }) => descriptor.name === "apply_patch",
    );
    if (patch === undefined) throw new Error("Native patch tool missing");
    const prepared = await Effect.runPromise(
      patch.prepare({
        type: "toolCall",
        id: "run6-native-patch",
        name: "apply_patch",
        arguments: { patch: run6Developer.patch },
      }),
    );
    const events: unknown = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    expect(events).toMatchObject([
      { type: "result", result: { isError: false } },
    ]);
    expect(received).toEqual([run6Developer.patch]);
  });

  it("keeps file writing on apply_patch, even after a failed patch, and never on a shell", () => {
    expect(text).toContain(
      "Files are only ever written with `apply_patch`: never `cat >`, `printf >`, `tee`, `echo >` or a heredoc",
    );
    expect(text).toContain(
      "If `apply_patch` fails, read its error, fix the patch",
    );
    expect(text).toContain("end with `*** End Patch` on its own last line");
  });

  it("tells the Agent to describe only operations it found, so no guessed path errors before the first card", () => {
    expect(text).toContain(
      "describe only operation paths that `forage.search` or `forage.list` returned",
    );
    expect(text.indexOf("describe only operation paths")).toBeLessThan(
      text.indexOf("First list Home's working folder"),
    );
  });
});
