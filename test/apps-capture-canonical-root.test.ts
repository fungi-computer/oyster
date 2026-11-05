import {
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
import { createLocalDirectorySourceCapture } from "../src/build/local-build.js";

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
