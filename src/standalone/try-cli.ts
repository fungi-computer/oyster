// `oyster try`: one command from nothing to a running local Oyster with a
// Hello App. It scaffolds a small project (the standalone worker and wrangler
// config this package ships, plus a package.json), installs it with the
// caller's package manager, runs `wrangler dev` locally, installs the Hello
// App and opens the browser. Running it again in the same directory restarts
// the server without scaffolding again.
//
//   npx @fungi.computer/oyster try [directory] [--port 8787] [--no-open] [--verbose]
//
// Output goes through Lantern, the shared Fungi terminal kit: a wordmark, one
// spinner per real step, a success box and a next step for every failure. It
// is quiet by default; install and server output go to files under .oyster/
// and --verbose streams them instead. Piped output or CI gets plain lines.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { basename, delimiter, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Cli } from "@fungi.computer/lantern";
import * as z from "zod";
import { installHelloApp } from "./hello-app.js";
import { installLocalDesktop, isInstalled } from "./local-desktop.js";
import { startSignInLink, type SignInLink } from "./sign-in-link.js";

export const tryUsage =
  "Usage: oyster try [directory] [--port 8787] [--no-open] [--verbose] [--package <npm spec>]";

const tryHelp = `${tryUsage}

Creates ./my-oyster (or <directory>) with a local Oyster, installs it, starts it
on http://127.0.0.1:<port> and installs a Hello App from <directory>/hello-app,
a git repository you can edit. Commit an edit and run this again, from inside
that directory or by naming it, to restart and reinstall without scaffolding.
Press Ctrl-C to stop.

Options:
  --port <number>      port to listen on (default 8787)
  --no-open            do not open the browser
  --verbose            stream install and server output instead of saving it
                       under .oyster/
  --package <spec>     install Oyster from this npm spec instead of the version
                       that is running (a tarball path, for example)
  -h, --help           show this help
`;

// The local workspace builder (src/build/local-build.ts) refuses any other pnpm.
const localBuildPnpmVersion = "11.24.0";
const requiredNodeMajor = 24;
const ownerKeyFile = ".oyster-owner";
const logFile = join(".oyster", "wrangler.log");
const installLogFile = join(".oyster", "install.log");
const command = "npx @fungi.computer/oyster try";

/** A failure that knows the exact next step; the command shows both. */
class TryError extends Error {
  readonly title: string;
  readonly next: string;
  constructor(title: string, next: string) {
    super(`${title} ${next}`);
    this.name = "TryError";
    this.title = title;
    this.next = next;
  }
}

/**
 * Streaming logs and a redrawing spinner cannot share a terminal, so
 * --verbose prints plain lines instead of spinners.
 */
export function createTryCli(args: readonly string[]): Cli {
  return args.includes("--verbose")
    ? new Cli({ brand: "fungi", interactive: false })
    : new Cli({ brand: "fungi" });
}

/** The deepest Error in a `cause` chain, where the real failure lives. */
function innermostError(cause: unknown): Error {
  let current = cause instanceof Error ? cause : new Error(String(cause));
  for (let depth = 0; depth < 10; depth += 1) {
    if (!(current.cause instanceof Error)) break;
    current = current.cause;
  }
  return current;
}

const networkErrorCodes: ReadonlySet<unknown> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
]);

function isNetworkFailure(error: Error): boolean {
  return "code" in error && networkErrorCodes.has(error.code);
}

/** Show a failed `oyster try` as an error with its next step. */
export function reportTryFailure(cause: unknown, ui: Cli): void {
  if (cause instanceof TryError) ui.problem(cause.title, cause.next);
  else
    ui.problem(
      cause instanceof Error ? cause.message : String(cause),
      `Run \`${command} --help\` for the options, or add --verbose to see the full output.`,
    );
}

const ownManifestSchema = z.object({
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
});
type OwnManifest = z.infer<typeof ownManifestSchema>;

/** The injectable effects of `oyster try`; tests replace them. */
export type TryEffects = Readonly<{
  /** Install the scaffolded project's dependencies. */
  installDependencies: (
    directory: string,
    manager: Manager,
    verbose: boolean,
  ) => Promise<void>;
  /** Start Oyster and resolve once it answers; `stop` ends it. */
  startServer: (input: {
    directory: string;
    port: number;
    key: string;
    verbose: boolean;
  }) => Promise<{ stop: () => Promise<void>; exited: Promise<number | null> }>;
  /** Install the Hello App on the running Oyster. */
  installHello: (input: {
    directory: string;
    url: string;
    key: string;
  }) => Promise<number>;
  /** Build and install the Tourtois desktop unless it is already there. */
  installDesktop: (input: {
    directory: string;
    url: string;
    key: string;
  }) => Promise<void>;
  /** A one-time page that signs the owner in without the key in a URL. */
  signInLink: (input: {
    oysterUrl: string;
    key: string;
  }) => Promise<SignInLink>;
  /** Open the browser. */
  open: (url: string) => void;
  /** Resolve when the user asks to stop. */
  interrupted: () => Promise<void>;
  /** Check that the port is free. */
  portFree: (port: number) => Promise<boolean>;
}>;

export type Manager = "npm" | "pnpm";

/** pnpm when it ran this command (`pnpm dlx`), otherwise npm. */
export function detectManager(userAgent: string | undefined) {
  return userAgent?.startsWith("pnpm/") === true ? "pnpm" : "npm";
}

async function ownManifest(): Promise<OwnManifest> {
  return ownManifestSchema.parse(
    JSON.parse(
      await readFile(join(import.meta.dirname, "../../package.json"), "utf8"),
    ),
  );
}

function projectManifest(own: OwnManifest, spec: string | undefined): string {
  const dependencies = {
    "@fungi.computer/oyster": spec ?? own.version,
    "@fungi.computer/computer":
      own.dependencies["@fungi.computer/computer"] ?? "latest",
    react: "^19.2.0",
    "react-dom": "^19.2.0",
    // Building the desktop here needs this exact pnpm, whatever the caller uses.
    pnpm: localBuildPnpmVersion,
    wrangler: own.peerDependencies.wrangler ?? "^4.127.1",
  };
  return (
    JSON.stringify(
      {
        name: "my-oyster",
        private: true,
        type: "module",
        // npm 11.19 and newer skip dependency install scripts unless approved.
        allowScripts: {
          "@google/genai": false,
          "@mongodb-js/zstd": false,
          esbuild: true,
          exifreader: false,
          "node-liblzma": false,
          protobufjs: false,
          workerd: true,
        },
        scripts: { start: "npx @fungi.computer/oyster try" },
        dependencies,
      },
      null,
      2,
    ) + "\n"
  );
}

// pnpm 11 refuses dependency build scripts it was not told about.
const pnpmWorkspace = `allowBuilds:
  "@google/genai": false
  "@mongodb-js/zstd": false
  esbuild: true
  exifreader: false
  node-liblzma: false
  protobufjs: false
  workerd: true
`;

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function scaffold(
  directory: string,
  own: OwnManifest,
  spec: string | undefined,
  manager: Manager,
) {
  await mkdir(directory, { recursive: true });
  const examples = join(import.meta.dirname, "../../examples/standalone");
  for (const name of ["worker.ts", "wrangler.jsonc"])
    await copyFile(join(examples, name), join(directory, name));
  await writeFile(join(directory, "package.json"), projectManifest(own, spec));
  if (manager === "pnpm")
    await writeFile(join(directory, "pnpm-workspace.yaml"), pnpmWorkspace);
  await writeFile(
    join(directory, ".gitignore"),
    ".oyster/\n.wrangler/\nnode_modules/\n.oyster-owner\n",
  );
}

/** Write a child's output to a log file, and also to stderr when verbose. */
function captureOutput(
  child: ChildProcess,
  log: WriteStream,
  verbose: boolean,
) {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.pipe(log, { end: false });
    if (verbose) stream?.pipe(process.stderr, { end: false });
  }
}

async function runInstall(
  directory: string,
  manager: Manager,
  verbose: boolean,
): Promise<void> {
  await mkdir(join(directory, ".oyster"), { recursive: true });
  const log = createWriteStream(join(directory, installLogFile));
  try {
    await new Promise<void>((done, fail) => {
      const child = spawn(manager, ["install"], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      captureOutput(child, log, verbose);
      child.on("error", (cause) => {
        fail(new Error(`Could not run ${manager} install: ${cause.message}`));
      });
      child.on("close", (code) => {
        if (code === 0) done();
        else
          fail(new Error(`${manager} install failed (exit ${String(code)}).`));
      });
    });
  } finally {
    log.end();
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => {
      done(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        done(true);
      });
    });
  });
}

async function waitUntilReady(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const answered = await fetch(`${url}/login`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (answered) return true;
    await new Promise((wake) => setTimeout(wake, 500));
  }
  return false;
}

async function tail(path: string) {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().split("\n").slice(-15).join("\n");
  } catch {
    return "(no log was written)";
  }
}

function startWrangler(input: {
  directory: string;
  port: number;
  key: string;
  verbose: boolean;
}) {
  return (async () => {
    const wrangler = join(
      input.directory,
      "node_modules",
      "wrangler",
      "bin",
      "wrangler.js",
    );
    if (!(await exists(wrangler)))
      throw new TryError(
        `wrangler is not installed in ${input.directory}.`,
        `Run \`npm install\` there, then run \`${command}\` again.`,
      );
    await mkdir(join(input.directory, ".oyster"), { recursive: true });
    const log = join(input.directory, logFile);
    const logStream = createWriteStream(log);
    const url = `http://127.0.0.1:${String(input.port)}`;
    const child = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--enable-containers=false",
        "--ip",
        "127.0.0.1",
        "--port",
        String(input.port),
        "--local-upstream",
        "oyster.test",
        "--upstream-protocol",
        "https",
        "--var",
        `OYSTER_OWNER_KEY:${input.key}`,
        "--var",
        "OYSTER_ORIGIN:https://oyster.test",
      ],
      {
        cwd: input.directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    captureOutput(child, logStream, input.verbose);
    const exited = new Promise<number | null>((done) => {
      child.on("close", (code) => {
        logStream.end();
        done(code);
      });
    });
    const stop = async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      const forced = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10_000);
      await exited;
      clearTimeout(forced);
    };
    if (!(await waitUntilReady(url, child, 120_000))) {
      await stop();
      throw new TryError(
        "Oyster did not start.",
        `Read ${log}, or run \`${command} --verbose\` to watch it start. The last lines:\n${await tail(log)}`,
      );
    }
    return { stop, exited };
  })();
}

function openBrowser(url: string) {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

function untilInterrupted(): Promise<void> {
  return new Promise((done) => {
    const once = () => {
      process.off("SIGINT", once);
      process.off("SIGTERM", once);
      done();
    };
    process.on("SIGINT", once);
    process.on("SIGTERM", once);
  });
}

const realEffects: TryEffects = {
  installDependencies: runInstall,
  startServer: startWrangler,
  installHello: installHelloApp,
  installDesktop: async ({ directory, ...input }) => {
    process.env.PATH = `${join(directory, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;
    if (!(await isInstalled({ ...input, installationId: "tourtois" })))
      await installLocalDesktop(input);
  },
  signInLink: startSignInLink,
  open: openBrowser,
  interrupted: untilInterrupted,
  portFree,
};

export async function tryOyster(
  args: readonly string[],
  effects: TryEffects = realEffects,
  ui: Cli = createTryCli(args),
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      "no-open": { type: "boolean" },
      verbose: { type: "boolean" },
      package: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const verbose = values.verbose === true;
  if (values.help === true) {
    process.stdout.write(tryHelp);
    return;
  }
  if (positionals.length > 1) throw new Error(tryUsage);
  ui.welcome("Oyster: your own Apps, running on this machine");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < requiredNodeMajor)
    throw new TryError(
      `Oyster needs Node ${String(requiredNodeMajor)} or newer; this is Node ${process.versions.node}.`,
      `Install a current Node from https://nodejs.org, then run \`${command}\` again.`,
    );
  if (!gitAvailable())
    throw new TryError(
      "Oyster builds the Hello App from a git commit, so it needs Git.",
      `Install Git from https://git-scm.com, then run \`${command}\` again.`,
    );
  const port = Number(values.port ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new TryError(
      "--port must be a number from 1 to 65535.",
      `For example: \`${command} --port 8788\`.`,
    );
  const directory = resolve(
    positionals[0] ??
      ((await exists(join(process.cwd(), ownerKeyFile))) ? "." : "my-oyster"),
  );
  const keyPath = join(directory, ownerKeyFile);
  const fresh = !(await exists(keyPath));
  if (fresh) {
    const occupied = (await exists(directory))
      ? (await readdir(directory)).length > 0
      : false;
    if (occupied)
      throw new TryError(
        `${directory} already has files and is not an Oyster made by \`oyster try\`.`,
        `Choose a new directory: \`${command} <directory>\`.`,
      );
  }
  if (!(await effects.portFree(port)))
    throw new TryError(
      `Port ${String(port)} on 127.0.0.1 is already in use.`,
      `Stop whatever is using it, or choose another port: \`${command} --port ${String(port + 1)}\`.`,
    );
  let key: string;
  if (fresh) {
    const manager = detectManager(process.env.npm_config_user_agent);
    const own = await ownManifest();
    await ui.task(`Creating ${basename(directory)}`, () =>
      scaffold(directory, own, values.package, manager),
    );
    await ui
      .task(`Installing dependencies with ${manager} (a minute or two)`, () =>
        effects.installDependencies(directory, manager, verbose),
      )
      .catch((cause: unknown) => {
        throw new TryError(
          cause instanceof Error ? cause.message : String(cause),
          `Read ${join(directory, installLogFile)} (or add --verbose), delete ${directory}, and run \`${command}\` again.`,
        );
      });
    key = Array.from(randomBytes(24), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await writeFile(keyPath, key + "\n", { mode: 0o600 });
  } else {
    key = (await readFile(keyPath, "utf8")).trim();
    ui.info(`Restarting the Oyster in ${directory}`);
  }
  const url = `http://127.0.0.1:${String(port)}`;
  const server = await ui.task("Starting Oyster", () =>
    effects.startServer({ directory, port, key, verbose }),
  );
  let closeLink: () => void = () => undefined;
  try {
    await ui.task("Installing the Hello App", () =>
      effects.installHello({ directory, url, key }),
    );
    await ui
      .task(
        fresh
          ? "Building Tourtois (about 2 min the first time)"
          : "Checking Tourtois",
        () => effects.installDesktop({ directory, url, key }),
      )
      .catch((cause: unknown) => {
        ui.warn(
          `Tourtois, the desktop, could not be built (${innermostError(cause).message}). Continuing with the Hello App.`,
          isNetworkFailure(innermostError(cause))
            ? `Connect to the internet and run \`${command}\` again from ${directory} to try the desktop again.`
            : `Run \`${command} --verbose\` from ${directory} and report this.`,
        );
      });
    const link = await ui.task("Opening your desktop", async () => {
      const made = await effects.signInLink({ oysterUrl: url, key });
      closeLink = made.close;
      if (values["no-open"] !== true && process.stdout.isTTY)
        effects.open(made.url);
      return made;
    });
    ui.note("Oyster is running", [
      `Open (works once):  ${link.url}`,
      `Oyster:             ${url}`,
      `Owner key saved in: ${keyPath}`,
      `Hello App source:   ${join(directory, "hello-app")}`,
      `Sign in later by pasting that key at ${url}/login.`,
      "Press Ctrl-C to stop.",
    ]);
    const outcome = await Promise.race([
      effects.interrupted().then(() => "interrupted" as const),
      server.exited.then(() => "exited" as const),
    ]);
    if (outcome === "exited")
      throw new TryError(
        "Oyster stopped unexpectedly.",
        `Read ${join(directory, logFile)}, then run \`${command}\` again.`,
      );
  } finally {
    closeLink();
    ui.step("Stopping Oyster");
    await server.stop();
  }
  ui.outro("Stopped. Run the same command again to start it again.");
}

/** Whether `git` is available; Hello App packing reads its commit. */
function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}
