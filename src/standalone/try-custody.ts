import { constants, lstatSync } from "node:fs";
import {
  appendFile,
  readFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

const ownerFile = ".oyster-owner";
const privateBase = () => join(homedir(), ".config", "fungi", "oyster-trials");

async function newStore() {
  const base = privateBase();
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, "trial-"));
}

/** Atomically replace a regular project file with its protected-store link. */
async function linkFile(source: string, destination: string) {
  const stage = await mkdtemp(join(dirname(source), ".oyster-link-"));
  const temporary = join(stage, "link");
  try {
    await symlink(destination, temporary, "file");
    await rename(temporary, source);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Fresh owner bytes never enter the project or its staging directory. */
export async function createTrialOwner(
  directory: string,
  key: string,
): Promise<void> {
  const store = await newStore();
  try {
    const target = join(store, ownerFile);
    await writeFile(target, key + "\n", { mode: 0o600, flag: "wx" });
    await symlink(target, join(directory, ownerFile), "file");
  } catch (cause) {
    await rm(store, { recursive: true, force: true });
    throw cause;
  }
}

async function ownerStore(directory: string): Promise<string> {
  const source = join(directory, ownerFile);
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) {
    const target = await realpath(source);
    const base = await realpath(privateBase());
    if (!target.startsWith(base + sep))
      throw new Error("Trial owner key is outside private Fungi storage");
    return dirname(target);
  }
  if (!entry.isFile()) throw new Error("Trial owner key must be a file");
  const store = await newStore();
  const target = join(store, ownerFile);
  // Copy before the atomic link replacement: interruption leaves the original
  // owner key intact, including when the project and HOME use different disks.
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  await linkFile(source, target);
  return store;
}

async function protect(
  directory: string,
  store: string,
  name: string,
  kind: "file" | "directory",
) {
  const source = join(directory, name);
  const destination = join(store, name);
  const entry = lstatSync(source, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) {
    if ((await realpath(source)) !== (await realpath(destination)))
      throw new Error("Trial private path points outside its store");
    return;
  }
  if (entry !== undefined) {
    if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined)
      throw new Error("Trial private storage conflicts with a project path");
    if (kind === "file") {
      if (!entry.isFile()) throw new Error("Trial secret must be a file");
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      await linkFile(source, destination);
      return;
    }
    if (!entry.isDirectory())
      throw new Error("Trial state must be a directory");
    try {
      await rename(source, destination);
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "EXDEV"
      )
        throw cause;
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await rm(source, { recursive: true });
    }
  } else if (kind === "directory") {
    await mkdir(destination, { recursive: true, mode: 0o700 });
  } else if (lstatSync(destination, { throwIfNoEntry: false }) === undefined) {
    await writeFile(destination, "", { mode: 0o600, flag: "wx" });
  }
  await symlink(destination, source, kind === "directory" ? "dir" : "file");
}

/** Native Wrangler filenames remain links into Fungi's existing sandbox mask. */
export async function prepareTrialPrivateState(
  directory: string,
): Promise<void> {
  const store = await ownerStore(directory);
  const ignored =
    "\n# Local Oyster secrets\n/.oyster\n/.wrangler\n/.oyster-owner\n/.dev.vars\n/.env\n/.env.local\n";
  const ignorePath = join(directory, ".gitignore");
  const before =
    lstatSync(ignorePath, { throwIfNoEntry: false }) === undefined
      ? ""
      : await readFile(ignorePath, "utf8");
  if (!before.includes(ignored)) await appendFile(ignorePath, ignored);
  for (const name of [".oyster", ".wrangler"])
    await protect(directory, store, name, "directory");
  for (const name of [".dev.vars", ".env", ".env.local"])
    if (
      lstatSync(join(directory, name), { throwIfNoEntry: false }) !== undefined
    )
      await protect(directory, store, name, "file");
}

/** Create a native secret file only when selected, preserving dotenv precedence. */
export async function prepareTrialSecretFile(
  directory: string,
  name: ".dev.vars" | ".env.local",
): Promise<string> {
  await protect(directory, await ownerStore(directory), name, "file");
  return join(directory, name);
}
