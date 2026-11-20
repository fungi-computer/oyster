import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedTypeScriptCompiler } from "../../src/build/shared-workspace.js";

let snapshot: string;
beforeEach(async () => {
  snapshot = await mkdtemp(join(tmpdir(), "shared-workspace-"));
});
afterEach(async () => {
  await rm(snapshot, { recursive: true, force: true });
});

/** Link `app/node_modules/typescript` to `target`, as pnpm's install does. */
async function linkCompiler(app: string, target: string) {
  await mkdir(join(snapshot, app, "node_modules"), { recursive: true });
  await mkdir(target, { recursive: true });
  await symlink(target, join(snapshot, app, "node_modules/typescript"));
}

describe("sharedTypeScriptCompiler", () => {
  it("names the one compiler every App resolves in the snapshot", async () => {
    const compiler = join(snapshot, "node_modules/.pnpm/typescript@5.9.3");
    await linkCompiler("apps/one", compiler);
    await linkCompiler("apps/two", compiler);
    expect(sharedTypeScriptCompiler(snapshot, ["apps/one", "apps/two"])).toBe(
      compiler,
    );
  });

  it("fails closed when two Apps resolve different compilers", async () => {
    await linkCompiler(
      "apps/one",
      join(snapshot, "node_modules/.pnpm/typescript@5.9.3"),
    );
    await linkCompiler(
      "apps/two",
      join(snapshot, "node_modules/.pnpm/typescript@5.9.2"),
    );
    expect(() =>
      sharedTypeScriptCompiler(snapshot, ["apps/one", "apps/two"]),
    ).toThrow("every App to resolve the same TypeScript compiler");
  });

  it("fails closed when the compiler resolves outside the snapshot", async () => {
    const outside = await mkdtemp(join(tmpdir(), "shared-workspace-host-"));
    try {
      await linkCompiler("apps/one", outside);
      expect(() => sharedTypeScriptCompiler(snapshot, ["apps/one"])).toThrow(
        "every App to resolve the same TypeScript compiler",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails closed when an App has no installed compiler", async () => {
    await mkdir(join(snapshot, "apps/one"), { recursive: true });
    expect(() => sharedTypeScriptCompiler(snapshot, ["apps/one"])).toThrow();
  });
});
