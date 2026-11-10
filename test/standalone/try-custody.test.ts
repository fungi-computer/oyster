import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  symlink,
  lstat,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTrialOwner,
  prepareTrialPrivateState,
  prepareTrialSecretFile,
} from "../../src/standalone/try-custody.js";

let fixture: string;
let directory: string;
let home: string;
beforeEach(async () => {
  const scratch = fileURLToPath(new URL("../../.botanical/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  fixture = await mkdtemp(join(scratch, "custody-test-"));
  home = join(fixture, "home");
  directory = join(fixture, "trial");
  await mkdir(directory);
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixture, { recursive: true, force: true });
});

it("keeps fresh owner bytes and native state inside the shared Fungi sandbox mask", async () => {
  await createTrialOwner(directory, "synthetic-owner");
  await prepareTrialPrivateState(directory);
  const secret = await prepareTrialSecretFile(directory, ".env.local");
  await writeFile(secret, "synthetic-model-key");
  for (const name of [".oyster-owner", ".oyster", ".wrangler", ".env.local"]) {
    expect((await lstat(join(directory, name))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(directory, name))).toContain(
      join(home, ".config/fungi/oyster-trials/"),
    );
  }
  await expect(lstat(join(directory, ".dev.vars"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await readFile(secret, "utf8")) === "synthetic-model-key").toBe(true);
});

it("preserves an existing trial's key, native env and state across relocation and a directory move", async () => {
  await writeFile(join(directory, ".oyster-owner"), "synthetic-owner");
  await writeFile(
    join(directory, ".dev.vars"),
    "OTHER_SECRET=synthetic-value\n",
  );
  await mkdir(join(directory, ".wrangler"));
  await writeFile(join(directory, ".wrangler/state"), "retained-state");
  await prepareTrialPrivateState(directory);
  const owner = await realpath(join(directory, ".oyster-owner"));
  const moved = join(fixture, "moved-trial");
  await rename(directory, moved);
  directory = moved;
  await prepareTrialPrivateState(directory);
  expect(await realpath(join(directory, ".oyster-owner"))).toBe(owner);
  expect(
    (await readFile(join(directory, ".oyster-owner"), "utf8")) ===
      "synthetic-owner",
  ).toBe(true);
  expect(
    (await readFile(join(directory, ".dev.vars"), "utf8")) ===
      "OTHER_SECRET=synthetic-value\n",
  ).toBe(true);
  expect(await readFile(join(directory, ".wrangler/state"), "utf8")).toBe(
    "retained-state",
  );
});

it("refuses conflicting private state without replacing either copy", async () => {
  await createTrialOwner(directory, "synthetic-owner");
  const store = dirname(await realpath(join(directory, ".oyster-owner")));
  await mkdir(join(store, ".oyster"));
  await mkdir(join(directory, ".oyster"));
  await writeFile(join(store, ".oyster/retained"), "private");
  await writeFile(join(directory, ".oyster/retained"), "project");
  await expect(prepareTrialPrivateState(directory)).rejects.toThrow(
    "conflicts",
  );
  expect(await readFile(join(store, ".oyster/retained"), "utf8")).toBe(
    "private",
  );
  expect(await readFile(join(directory, ".oyster/retained"), "utf8")).toBe(
    "project",
  );
});

it("refuses an external secret symlink without moving its target", async () => {
  await createTrialOwner(directory, "synthetic-owner");
  const external = join(fixture, "external");
  await writeFile(external, "synthetic-external");
  await symlink(external, join(directory, ".dev.vars"));
  await expect(prepareTrialPrivateState(directory)).rejects.toThrow();
  expect((await readFile(external, "utf8")) === "synthetic-external").toBe(
    true,
  );
});
