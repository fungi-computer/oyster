import {
  access,
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createLocalDirectorySourceCapture,
  runGit,
} from "../src/build/local-build.js";

import { setTimeout as delay } from "node:timers/promises";
import * as Exit from "effect/Exit";

let scratch: string;
let previousTmpdir: string | undefined;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canonical-root-")));
  previousTmpdir = process.env.TMPDIR;
});
afterEach(async () => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  await rm(scratch, { recursive: true, force: true });
});

// macOS reaches its temp directory through a symlink (/var -> /private/var),
// while pnpm reports project paths as realpaths. The captured source root must
// already be canonical so both agree.
it("captures source under a canonical root when the temp directory is a symlink", async () => {
  const real = join(scratch, "real-tmp");
  await mkdir(real);
  const linked = join(scratch, "linked-tmp");
  await symlink(real, linked);
  const source = join(scratch, "app");
  await mkdir(source);
  await writeFile(join(source, "package.json"), "{}\n");
  process.env.TMPDIR = linked;

  const snapshot = await Effect.runPromise(
    Effect.scoped(
      Effect.map(
        createLocalDirectorySourceCapture(source).capture(),
        (captured) => captured.snapshotPath,
      ),
    ),
  );

  expect(snapshot.startsWith(`${linked}/`)).toBe(false);
  expect(snapshot.startsWith(`${real}/`)).toBe(true);
});

it("joins the owned Git process group before a cancelled call returns", async () => {
  const child = join(scratch, "owned-child.mjs");
  const entered = join(scratch, "entered");
  const finished = join(scratch, "finished");
  await writeFile(
    child,
    `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  setTimeout(() => { writeFileSync(${JSON.stringify(finished)}, "closed"); process.exit(0); }, 80);
});
writeFileSync(${JSON.stringify(entered)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const controller = new AbortController();
  const running = runGit(
    ["-c", `alias.owned=!node '${child}'`, "owned"],
    scratch,
    controller.signal,
    process.env,
  );
  const observed = running.catch((cause: unknown) => cause);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await access(entered).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(20);
    }
    const pid = Number(await readFile(entered, "utf8"));
    controller.abort();
    expect(await observed).toMatchObject({ name: "AbortError" });
    expect(await readFile(finished, "utf8")).toBe("closed");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await observed;
  }
});

it("removes only its acquired snapshot before source-capture interruption settles", async () => {
  const temporary = join(scratch, "temporary");
  const source = join(scratch, "source");
  await mkdir(temporary);
  await mkdir(source);
  await writeFile(join(source, "package.json"), "{}");
  await writeFile(join(temporary, "user-marker"), "keep");
  process.env.TMPDIR = temporary;
  const captured = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const running = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* createLocalDirectorySourceCapture(source).capture();
        captured.resolve(undefined);
        yield* Effect.never;
      }),
    ),
    { signal: controller.signal },
  );
  await captured.promise;
  expect(
    (await readdir(temporary)).some((name) =>
      name.startsWith("app-publisher-"),
    ),
  ).toBe(true);
  controller.abort();
  expect(Exit.isFailure(await running)).toBe(true);
  expect(await readdir(temporary)).toEqual(["user-marker"]);
});
