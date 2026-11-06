import { helloAppScript } from "#hello-app-script";
import { describe, expect, it } from "vitest";
import {
  helloPage,
  prepareHelloSource,
} from "../../src/standalone/hello-app.js";

import { execFileSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("starter Hello App", () => {
  it("loads a script that connects the page to Oyster", () => {
    // Oyster's CSP allows only same-origin scripts; the page never announces
    // itself otherwise and its window reports "didn't respond in time".
    expect(helloPage).toContain('<script type="module" src="./main.js">');
    // One self-contained module: bare imports cannot resolve in the frame.
    expect(helloAppScript).not.toMatch(/^import[ {*"']/m);
    expect(helloAppScript.length).toBeGreaterThan(0);
  });
});

it("resumes an unborn Hello repository without overwriting edits, then preserves HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hello-resume-"));
  const source = join(directory, "hello-app");
  try {
    await mkdir(join(source, "bundle"), { recursive: true });
    execFileSync("git", ["init", "-q", source]);
    await writeFile(join(source, "bundle/index.html"), "my edited Hello");
    const commit = await prepareHelloSource(
      directory,
      new AbortController().signal,
    );
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await readFile(join(source, "bundle/index.html"), "utf8")).toBe(
      "my edited Hello",
    );
    await writeFile(join(source, "bundle/index.html"), "uncommitted edit");
    expect(
      await prepareHelloSource(directory, new AbortController().signal),
    ).toBe(commit);
    expect(await readFile(join(source, "bundle/index.html"), "utf8")).toBe(
      "uncommitted edit",
    );
    expect(await readdir(directory)).toEqual(["hello-app"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not publish source for an already cancelled request or adopt unrelated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hello-cancel-"));
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareHelloSource(directory, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(directory)).toEqual([]);
    await mkdir(join(directory, "hello-app"));
    await writeFile(join(directory, "hello-app/notes"), "mine");
    await expect(
      prepareHelloSource(directory, new AbortController().signal),
    ).rejects.toThrow("already contains files");
    expect(await readdir(join(directory, "hello-app"))).toEqual(["notes"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("awaits cancellation of an actual first-commit hook and resumes without changing user edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hello-first-commit-"));
  const source = join(directory, "hello-app");
  const entered = join(directory, "hook-entered");
  const hook = join(source, ".git/hooks/pre-commit");
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    await mkdir(join(source, "bundle"), { recursive: true });
    execFileSync("git", ["init", "-q", source]);
    await writeFile(join(source, "bundle/index.html"), "my edited Hello");
    const program = join(directory, "commit-hook.mjs");
    await writeFile(
      program,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(entered)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      hook,
      `#!/bin/sh\nexec "${process.execPath}" "${program}"\n`,
      { mode: 0o700 },
    );
    running = prepareHelloSource(directory, controller.signal).catch(
      (cause: unknown) => cause,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await access(entered).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pid = Number(await readFile(entered, "utf8"));
    controller.abort();
    expect(await running).toMatchObject({ name: "AbortError" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readFile(join(source, "bundle/index.html"), "utf8")).toBe(
      "my edited Hello",
    );
    await expect(access(join(source, ".git/index.lock"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await rm(hook);
    expect(
      await prepareHelloSource(directory, new AbortController().signal),
    ).toMatch(/^[0-9a-f]{40}$/u);
    expect(await readFile(join(source, "bundle/index.html"), "utf8")).toBe(
      "my edited Hello",
    );
  } finally {
    controller.abort();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
});
