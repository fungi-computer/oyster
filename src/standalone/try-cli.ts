// `oyster try`: one command from nothing to a running local Oyster with a
// Hello App. It scaffolds a small project (the standalone worker and wrangler
// config this package ships, plus a package.json), installs it with the
// caller's package manager, starts Wrangler’s local runtime, installs the Hello
// App and opens the browser. Running it again in the same directory restarts
// the server after refreshing the generated project files and dependencies.
//
//   npx @fungi.computer/oyster try [directory] [--port 8787] [--no-open] [--verbose]
//
// Output goes through Lantern, the shared Fungi terminal kit: a wordmark, one
// progress log per real step, a success box and a next step for every failure. It
// is quiet by default; install and server output go to files under .oyster/
// and --verbose streams them instead. Piped output or CI gets plain lines.
import { spawn, type ChildProcess } from "node:child_process";
import { startTrialComputer } from "./trial-computer.js";
import {
  createTrialOwner,
  prepareTrialPrivateState,
  prepareTrialSecretFile,
} from "./try-custody.js";
import { randomBytes } from "node:crypto";
import { encode as encodeBase64Url } from "effect/encoding/Base64Url";
import { addAbortListener } from "node:events";
import { finished } from "node:stream/promises";
import { runGit } from "../build/local-build.js";
import {
  CleanupError,
  stopProcessGroup,
  awaitCleanup,
} from "../build/process-group.js";
import { InstallationObservationError } from "../installation-client.js";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  readdir,
  rm,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { createCredentialSealer } from "@fungi.computer/veil/credential-store";
import { basename, dirname, delimiter, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { Cli } from "@fungi.computer/lantern";
import * as z from "zod";
import { installHelloApp } from "./hello-app.js";
import {
  desktopApp,
  installLocalStarter,
  localDesktopState,
  localStarterInstalled,
  type DesktopReadiness,
  localModelSetup,
} from "./local-desktop.js";
import {
  standaloneAppSet,
  trialStarterOrder,
  type StarterApp,
} from "./app-set.js";
import { startSignInLink, type SignInLink } from "./sign-in-link.js";
import {
  reportTrialStarters,
  takeTrialRetries,
} from "./trial-starters-client.js";
import type { InstallingApp } from "@fungi.computer/nacre/workbench-directory";
import { setTimeout as sleep } from "node:timers/promises";

export const tryUsage =
  "Usage: oyster try [directory] [--port 8787] [--no-open] [--verbose] [--package <npm spec>]";

const tryHelp = `${tryUsage}

Creates ./my-oyster (or <directory>) with a local Oyster, installs it, starts it
on http://127.0.0.1:<port> and installs a Hello App from <directory>/hello-app,
a git repository you can edit. Commit an edit and run this again, from inside
that directory or by naming it, to restart with the current Oyster. Generated
configuration is refreshed; your app source and owner key are kept.
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
const trialWorkerFile =
  "node_modules/@fungi.computer/oyster/dist/standalone/try-worker.js";
const logFile = join(".oyster", "wrangler.log");
const installLogFile = join(".oyster", "install.log");
const command = "npx @fungi.computer/oyster try";
/** Where a stranger learns to add a model key. */
const modelKeyGuideUrl = "https://docs.fungi.computer/models/your-own-key/";

const pendingInstall = join(".oyster", "install.pending");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const retryCommand = (directory: string, port: number) =>
  `${command} ${quote(directory)} --port ${String(port)}`;

/** Lantern owns rendering; Oyster owns the measured phase and its lifetime. */
async function timedTask<T>(
  ui: Cli,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
  try {
    return await ui.task(label, async (update) => {
      const timer = setInterval(() => {
        update(`${label} · ${elapsed()} elapsed`);
      }, 5000);
      try {
        const result = await work();
        update(`${label} · done in ${elapsed()}`);
        return result;
      } finally {
        clearInterval(timer);
      }
    });
  } catch (cause) {
    ui.step(
      `${label} · ${cause instanceof Error && cause.name === "AbortError" ? "stopped" : "failed"} after ${elapsed()}`,
    );
    throw cause;
  }
}

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

/** A desktop-only failure still permits sign-in for recovery. */
class DesktopSetupError extends Error {
  constructor(cause: unknown) {
    super("Tourtois preparation failed.", { cause });
  }
}

/**
 * Streaming logs and interactive progress cannot share a terminal, so
 * --verbose prints plain lines.
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
    // An aggregate has multiple causes; its summary preserves both failures.
    if (current instanceof AggregateError || !(current.cause instanceof Error))
      break;
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

function isNetworkFailure(error: Error): error is Error & { code: string } {
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
  startComputer: typeof startTrialComputer;
  /** Install the scaffolded project's dependencies. */
  installDependencies: (
    directory: string,
    manager: Manager,
    verbose: boolean,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Start Oyster and resolve once it answers; `stop` ends it. */
  startServer: (input: {
    directory: string;
    port: number;
    key: string;
    signal: AbortSignal;
    verbose: boolean;
  }) => Promise<{ stop: () => Promise<void>; exited: Promise<number | null> }>;
  /** Install the Hello App on the running Oyster. */
  installHello: (input: {
    directory: string;
    url: string;
    key: string;
    signal: AbortSignal;
  }) => Promise<number>;
  /** Prepare Tourtois without changing an existing installation or its approval. */
  installDesktop: (input: {
    directory: string;
    url: string;
    key: string;
    signal: AbortSignal;
  }) => Promise<DesktopReadiness>;
  /** Build and install one more starter App; resolves once it is installed. */
  installStarter: (
    app: StarterApp,
    input: {
      url: string;
      key: string;
      signal: AbortSignal;
    },
  ) => Promise<"installed" | "already-installed">;
  /** Tell the Oyster which starter Apps are not ready yet. */
  reportStarters: (
    input: { url: string; key: string; signal: AbortSignal },
    installing: readonly InstallingApp[],
  ) => Promise<void>;
  /** The Apps the desktop asked to retry; each ask is handed out once. */
  takeRetries: (input: {
    url: string;
    key: string;
    signal: AbortSignal;
  }) => Promise<readonly string[]>;
  /** Whether a model is connected, so the start message can say what to do. */
  modelSetup: (input: {
    url: string;
    key: string;
    signal: AbortSignal;
  }) => Promise<"ready" | "missing" | "unknown">;
  /** A one-time page that signs the owner in without the key in a URL. */
  signInLink: (input: {
    oysterUrl: string;
    key: string;
    signal: AbortSignal;
  }) => Promise<SignInLink>;
  /** Open the browser. */
  open: (url: string, failed: () => void) => void;
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
    "@fungi.computer/truffle": "latest",
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

/** Refresh only try-owned configuration; app sources and owner custody stay put. */
async function refreshProject(
  directory: string,
  own: OwnManifest,
  spec: string | undefined,
  manager: Manager,
  signal: AbortSignal,
): Promise<void> {
  const examples = join(import.meta.dirname, "../../examples/standalone");
  const files = new Map<string, string>([
    ["worker.ts", await readFile(join(examples, "worker.ts"), "utf8")],
    [
      "wrangler.jsonc",
      await readFile(join(examples, "wrangler.jsonc"), "utf8"),
    ],
    ["package.json", projectManifest(own, spec)],
  ]);
  if (manager === "pnpm") files.set("pnpm-workspace.yaml", pnpmWorkspace);
  for (const [name, content] of files) {
    signal.throwIfAborted();
    const path = join(directory, name);
    if ((await exists(path)) && (await readFile(path, "utf8")) === content)
      continue;
    // Mark before the first change, so an interrupted refresh/install is retried.
    await mkdir(join(directory, ".oyster"), { recursive: true });
    await writeFile(
      join(directory, pendingInstall),
      "Dependencies have not finished installing.\n",
    );
    await writeFile(path, content);
  }
}

async function scaffold(
  directory: string,
  own: OwnManifest,
  spec: string | undefined,
  manager: Manager,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  await mkdir(dirname(directory), { recursive: true });
  const stage = await mkdtemp(join(dirname(directory), ".oyster-try-"));
  try {
    await refreshProject(stage, own, spec, manager, signal);
    await writeFile(join(stage, ".gitignore"), "node_modules/\n");
    const key = Array.from(randomBytes(24), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await createTrialOwner(stage, key);
    await prepareTrialPrivateState(stage);
    signal.throwIfAborted();
    await rename(stage, directory);
    return key;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(
      (cause: unknown) => {
        throw new CleanupError("Project staging cleanup failed", { cause });
      },
    );
  }
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

/**
 * Wrangler keeps running after a failed build, so a startup that will never
 * answer is only visible in its output. Resolves with its first error line.
 */
class StartupFailure {
  constructor(readonly line: string) {}
}

function firstWranglerError(child: ChildProcess): Promise<string> {
  return new Promise<string>((found) => {
    let seen = "";
    for (const stream of [child.stdout, child.stderr])
      stream?.setEncoding("utf8").on("data", (chunk: string) => {
        seen = (seen + chunk).slice(-4096);
        const line = stripVTControlCharacters(seen)
          .split("\n")
          .find((candidate) => candidate.includes("[ERROR]"));
        if (line !== undefined)
          found(line.slice(line.indexOf("[ERROR]") + "[ERROR]".length).trim());
      });
  });
}

const npmFailureSchema = z.object({ error: z.object({ code: z.string() }) });

function npmFailureCode(output: string): string | undefined {
  try {
    const parsed = npmFailureSchema.safeParse(JSON.parse(output));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    // Lifecycle scripts can mix text into npm's JSON. The complete log remains
    // available; unstructured output must retain the ordinary install failure.
    return undefined;
  }
}

export async function installTryDependencies(
  directory: string,
  manager: Manager,
  verbose: boolean,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await mkdir(join(directory, ".oyster"), { recursive: true });
  signal.throwIfAborted();
  const log = createWriteStream(join(directory, installLogFile));
  const logClosed = Promise.allSettled([finished(log)]);
  let child: ChildProcess | undefined;
  let listener: ReturnType<typeof addAbortListener> | undefined;
  let stopping: Promise<PromiseSettledResult<void>[]> | undefined;
  const beginStop = () =>
    (stopping ??= Promise.allSettled([
      child === undefined ? Promise.resolve() : stopProcessGroup(child),
    ]));
  const stop = () => awaitCleanup(beginStop());
  try {
    child = spawn(
      manager,
      // Refresh tag dependencies such as Truffle too: install alone can retain
      // their old locked version even after Oyster itself is upgraded.
      manager === "npm"
        ? ["update", "--no-save", "--json"]
        : ["update", "--no-save"],
      {
        cwd: directory,
        detached: process.platform !== "win32",
        signal,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    captureOutput(child, log, verbose);
    // npm owns the diagnostic format. Bound this extra copy; the file receives
    // all output even when lifecycle scripts exceed the diagnostic budget.
    let diagnostic = "";
    let diagnosticBytes = 0;
    if (manager === "npm") {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        diagnosticBytes += new TextEncoder().encode(chunk).byteLength;
        diagnostic = diagnosticBytes <= 64 * 1024 ? diagnostic + chunk : "";
      });
    }
    const closed = new Promise<void>((done, fail) => {
      let failure: Error | undefined;
      child?.once("error", (cause) => {
        failure = cause;
      });
      child?.once("close", (code) => {
        if (failure !== undefined) fail(failure);
        else if (code === 0) done();
        else {
          const errorCode = npmFailureCode(diagnostic);
          fail(
            Object.assign(
              new Error(
                `${manager} update failed (${errorCode === undefined ? "" : `${errorCode}; `}exit ${String(code)}).`,
              ),
              { code: errorCode },
            ),
          );
        }
      });
    });
    listener = addAbortListener(signal, () => {
      void beginStop();
    });
    try {
      await closed;
    } finally {
      await stop();
    }
    signal.throwIfAborted();
  } finally {
    listener?.[Symbol.dispose]();
    log.end();
    await awaitCleanup(logClosed);
  }
}

const retryPollMs = 3_000;
const originFile = join(".oyster", "origin");

/**
 * Local data belongs to the origin it was seeded for. A project made for
 * another origin (an older `try` used https://oyster.test; another --port is
 * another origin) cannot be served, so its trial data is reset. The owner key,
 * Hello source and Git history are not data of the Oyster. Returns the origin
 * the data was reset from, or null.
 */
async function reconcileOrigin(
  directory: string,
  origin: string,
): Promise<string | null> {
  const marker = join(directory, originFile);
  const saved = (await exists(marker))
    ? (await readFile(marker, "utf8")).trim()
    : "https://oyster.test";
  const state = join(directory, ".wrangler", "state");
  const reset = saved !== origin && (await exists(state));
  if (reset) await rm(state, { recursive: true, force: true });
  await mkdir(join(directory, ".oyster"), { recursive: true });
  await writeFile(marker, `${origin}\n`);
  return reset ? saved : null;
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
  signal: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  while (Date.now() < deadline && !signal.aborted) {
    if (stopped()) return "exited";
    const answered = await fetch(`${url}/login`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (stopped()) return "exited";
    if (answered) return "ready";
    await new Promise((wake) => setTimeout(wake, 500));
  }
  return signal.aborted ? "exited" : "timeout";
}

/** Provision the trial's separate encryption key through Wrangler's native secrets. */
export async function prepareTryModelKeyCustody(
  directory: string,
): Promise<void> {
  try {
    await prepareTrialPrivateState(directory);
    const native = await import("wrangler");
    const resolveKey = () => {
      const config = native.unstable_readConfig({
        config: join(directory, "wrangler.jsonc"),
      });
      const binding = native.unstable_getVarsForDev(
        config.userConfigPath,
        undefined,
        config.vars,
        undefined,
        true,
        config.secrets,
      ).OYSTER_CREDENTIAL_KEY;
      if (binding === undefined) return undefined;
      if (binding.type !== "secret_text" && binding.type !== "plain_text")
        throw new Error("Invalid credential-key binding");
      return binding.value;
    };
    const validate = async (key: string) => {
      await createCredentialSealer(
        { activeKeyId: "instance", keys: { instance: key } },
        "fungi.oyster.credentials.v1",
      ).seal([], "Oyster credential custody check");
    };
    const existing = resolveKey();
    if (existing !== undefined) {
      await validate(existing);
      return;
    }
    const key = encodeBase64Url(randomBytes(32));
    const path = await prepareTrialSecretFile(
      directory,
      (await exists(join(directory, ".dev.vars"))) ? ".dev.vars" : ".env.local",
    );
    await appendFile(path, `\nOYSTER_CREDENTIAL_KEY=${key}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    const provisioned = resolveKey();
    if (provisioned !== key) throw new Error("Credential key was not loaded");
    await validate(provisioned);
  } catch {
    throw new TryError(
      "This Oyster could not prepare private model-key storage.",
      "Check the local secret files and Wrangler environment settings, then restart the Oyster. Existing keys were not replaced.",
    );
  }
}

function startWrangler(input: {
  directory: string;
  port: number;
  key: string;
  verbose: boolean;
  signal: AbortSignal;
}) {
  return (async () => {
    input.signal.throwIfAborted();
    const workerHost = join(input.directory, trialWorkerFile);
    if (!(await exists(workerHost)))
      throw new TryError(
        `The local Oyster worker is not installed in ${input.directory}.`,
        `Run \`npm install\` there, then run \`${retryCommand(input.directory, input.port)}\` again.`,
      );
    await prepareTryModelKeyCustody(input.directory);
    await mkdir(join(input.directory, ".oyster"), { recursive: true });
    const log = join(input.directory, logFile);
    input.signal.throwIfAborted();
    const logStream = createWriteStream(log);
    const logClosed = Promise.allSettled([finished(logStream)]);
    const url = `http://127.0.0.1:${String(input.port)}`;
    const child = spawn(process.execPath, [workerHost], {
      cwd: input.directory,
      detached: process.platform !== "win32",
      signal: input.signal,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    captureOutput(child, logStream, input.verbose);
    const startupError = firstWranglerError(child);
    const lifetime = new AbortController();
    const spawnError = new Promise<"spawn-error">((done) => {
      const failed = () => {
        done("spawn-error");
        lifetime.abort();
      };
      child.once("error", failed);
      child.stdin.once("error", failed);
    });
    child.stdin.end(
      JSON.stringify({
        directory: input.directory,
        port: input.port,
        key: input.key,
      }),
    );
    const exited = new Promise<number | null>((done) => {
      child.on("close", (code) => {
        lifetime.abort();
        done(code);
      });
    });
    let stopping: Promise<PromiseSettledResult<void>[]> | undefined;
    const beginStop = () =>
      (stopping ??= Promise.allSettled([
        (async () => {
          try {
            await stopProcessGroup(child);
            await exited;
          } finally {
            abortListener[Symbol.dispose]();
            logStream.end();
            await awaitCleanup(logClosed);
          }
        })(),
      ]));
    const stop = () => awaitCleanup(beginStop());
    const abortListener = addAbortListener(input.signal, () => {
      void beginStop();
    });
    try {
      const readiness = await Promise.race([
        startupError.then((line) => new StartupFailure(line)),
        waitUntilReady(
          url,
          child,
          120_000,
          AbortSignal.any([lifetime.signal, input.signal]),
        ),
        spawnError,
      ]);
      input.signal.throwIfAborted();
      if (readiness !== "ready") {
        const diagnostic =
          readiness instanceof StartupFailure
            ? `Oyster could not start: ${readiness.line}`
            : readiness === "spawn-error"
              ? "Oyster could not launch its server process."
              : readiness === "exited"
                ? `Oyster stopped before readiness (${child.signalCode === null ? `exit ${String(child.exitCode)}` : `signal ${child.signalCode}`}).`
                : "Oyster did not answer within 120 seconds.";
        throw new TryError(diagnostic, `Read ${log} for the server output.`);
      }
      return { stop, exited };
    } catch (cause) {
      try {
        await stop();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          `${innermostError(cause).message} Cleanup also failed: ${innermostError(cleanup).message}`,
          { cause: cleanup },
        );
      }
      throw cause;
    }
  })();
}

function openBrowser(url: string, failed: () => void): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  let reported = false;
  const reportFailure = () => {
    if (reported) return;
    reported = true;
    failed();
  };
  child.once("error", reportFailure);
  child.once("close", (code) => {
    if (code !== 0) reportFailure();
  });
  child.unref();
}

function isTryCancellation(cause: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (cause === signal.reason ||
      (cause instanceof Error && cause.name === "AbortError") ||
      cause instanceof InstallationObservationError)
  );
}

const realEffects: TryEffects = {
  installDependencies: installTryDependencies,
  startServer: startWrangler,
  installHello: installHelloApp,
  installDesktop: async ({ directory, ...input }) => {
    process.env.PATH = `${join(directory, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;
    const saved = await localDesktopState(input);
    if (saved !== "missing") return saved;
    await installLocalStarter(desktopApp, input);
    const installed = await localDesktopState(input);
    return installed === "missing" ? "unavailable" : installed;
  },
  installStarter: async (app, input) => {
    if (
      await localStarterInstalled({
        ...input,
        installationId: app.installationId,
      })
    )
      return "already-installed";
    await installLocalStarter(app, input);
    return "installed";
  },
  reportStarters: (input, installing) =>
    reportTrialStarters({ ...input, installing }),
  takeRetries: takeTrialRetries,
  modelSetup: localModelSetup,
  startComputer: startTrialComputer,
  signInLink: startSignInLink,
  open: openBrowser,
  portFree,
};

export async function tryOyster(
  args: readonly string[],
  effects: TryEffects = realEffects,
  ui: Cli = createTryCli(args),
  callerSignal?: AbortSignal,
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
  const port = Number(values.port ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new TryError(
      "--port must be a number from 1 to 65535.",
      `For example: \`${command} --port 8788\`.`,
    );
  let directory = resolve(positionals[0] ?? "my-oyster");
  const retryAtPort = (chosenPort: number) =>
    retryCommand(directory, chosenPort) +
    (values["no-open"] === true ? " --no-open" : "") +
    (verbose ? " --verbose" : "") +
    (values.package === undefined ? "" : ` --package ${quote(values.package)}`);
  let retry = retryAtPort(port);
  const retryWithLogs = () => retry + (verbose ? "" : " --verbose");
  const cancellation = new AbortController();
  const signal =
    callerSignal === undefined
      ? cancellation.signal
      : AbortSignal.any([cancellation.signal, callerSignal]);
  const interrupt = () => {
    cancellation.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let acquiredServer:
    Awaited<ReturnType<TryEffects["startServer"]>> | undefined;
  let closeComputer: (() => Promise<void>) | undefined;
  let computerReady = false;
  let closeLink: (() => Promise<void>) | undefined;
  try {
    if (
      positionals[0] === undefined &&
      (await exists(join(process.cwd(), ownerKeyFile)))
    ) {
      directory = process.cwd();
      retry = retryAtPort(port);
    }
    signal.throwIfAborted();
    const major = Number(process.versions.node.split(".")[0]);
    if (major < requiredNodeMajor)
      throw new TryError(
        `Oyster needs Node ${String(requiredNodeMajor)} or newer; this is Node ${process.versions.node}.`,
        `Install a current Node from https://nodejs.org, then run \`${retry}\` again.`,
      );
    if (!(await gitAvailable(signal)))
      throw new TryError(
        "Oyster builds the Hello App from a git commit, so it needs Git.",
        `Install Git from https://git-scm.com, then run \`${retry}\` again.`,
      );
    const task = <T>(label: string, work: () => Promise<T>) =>
      timedTask(ui, label, async () => {
        signal.throwIfAborted();
        const result = await work();
        signal.throwIfAborted();
        return result;
      });
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
    const available = await effects.portFree(port);
    signal.throwIfAborted();
    if (!available)
      throw new TryError(
        `Port ${String(port)} on 127.0.0.1 is already in use.`,
        `Leave that listener running. Choose another port: \`${retryAtPort(port === 65535 ? 8787 : port + 1)}\`.`,
      );
    let key: string;
    if (fresh) {
      const manager = detectManager(process.env.npm_config_user_agent);
      const own = await ownManifest();
      key = await task(`Creating ${basename(directory)}`, () =>
        scaffold(directory, own, values.package, manager, signal),
      );
    } else {
      await prepareTrialPrivateState(directory);
      key = (await readFile(keyPath, "utf8")).trim();
      ui.info(`Restarting the Oyster in ${directory}`);
      const manager = (await exists(join(directory, "pnpm-workspace.yaml")))
        ? "pnpm"
        : "npm";
      await task("Refreshing Oyster project", async () =>
        refreshProject(
          directory,
          await ownManifest(),
          values.package,
          manager,
          signal,
        ),
      );
    }
    if (
      fresh ||
      (await exists(join(directory, pendingInstall))) ||
      !(await exists(join(directory, trialWorkerFile)))
    ) {
      const manager = (await exists(join(directory, "pnpm-workspace.yaml")))
        ? "pnpm"
        : "npm";
      await mkdir(join(directory, ".oyster"), { recursive: true });
      await writeFile(
        join(directory, pendingInstall),
        "Dependencies have not finished installing.\n",
      );
      await task(`Installing dependencies with ${manager}`, () =>
        effects.installDependencies(directory, manager, verbose, signal),
      ).catch((cause: unknown) => {
        if (isTryCancellation(cause, signal)) throw cause;
        const failure = innermostError(cause);
        if (isNetworkFailure(failure))
          throw new TryError(
            `${manager} could not reach its package registry (${failure.code}).`,
            `Keep this project. Check your connection and ${manager} registry/proxy settings; details are in ${join(directory, installLogFile)}. Then run \`${retry}\`. Dependencies will be retried; your key and files stay in place.`,
          );
        if ("code" in failure && failure.code === "ERESOLVE")
          throw new TryError(
            `${manager} could not resolve this project's dependencies (ERESOLVE).`,
            `Keep this project. Check registry access and the dependency versions reported in ${join(directory, installLogFile)}, then run \`${retry}\`. Dependencies will be retried; your key and files stay in place.`,
          );
        throw new TryError(
          failure.message,
          `Keep this project. Read ${join(directory, installLogFile)}, fix the reported cause, then run \`${retry}\`. Dependencies will be retried; your key and files stay in place.`,
        );
      });
      await rm(join(directory, pendingInstall));
    }
    const url = `http://127.0.0.1:${String(port)}`;
    const resetFrom = await reconcileOrigin(directory, url);
    if (resetFrom !== null)
      ui.info(
        `This project's local data was made for ${resetFrom}, so it was reset for ${url}. Your owner key and Hello source are unchanged; the Apps reinstall below.`,
      );
    const server = await task("Starting Oyster", () =>
      (async () => {
        const resource = await effects.startServer({
          directory,
          port,
          key,
          verbose,
          signal,
        });
        acquiredServer = resource;
        return resource;
      })(),
    ).catch((cause: unknown) => {
      if (isTryCancellation(cause, signal)) throw cause;
      throw new TryError(
        cause instanceof TryError ? cause.title : innermostError(cause).message,
        `Read ${join(directory, logFile)}, then run \`${retryWithLogs()}\`.`,
      );
    });
    let serverExited = false;
    const watchedExit = server.exited.then((code) => {
      serverExited = true;
      return code;
    });
    const assertRunning = () => {
      signal.throwIfAborted();
      if (serverExited)
        throw new TryError(
          "Oyster stopped unexpectedly during setup.",
          `Read ${join(directory, logFile)}, then run \`${retryWithLogs()}\`.`,
        );
    };
    const setupTask = <T>(label: string, work: () => Promise<T>) => {
      assertRunning();
      return task(label, async () => {
        const result = await work();
        assertRunning();
        return result;
      });
    };
    await setupTask("Starting the local Computer", async () => {
      try {
        const computer = await effects.startComputer({
          directory,
          url,
          key,
          signal,
        });
        closeComputer = () => computer.stop();
        computerReady = true;
      } catch (cause) {
        if (signal.aborted) throw cause;
        ui.warn(
          `The Computer runtime is unavailable (${innermostError(cause).message}).`,
          "Files remain available. Fix the runtime and restart oyster try to run commands.",
        );
      }
    });
    const desktop = await setupTask(
      fresh
        ? "Installing Hello and building Tourtois"
        : "Installing Hello and checking Tourtois",
      async () => {
        // The Apps have separate sources and installation identities. One
        // progress display owns both; their cleanup must settle before the
        // server can stop or sign-in can be offered.
        const preparation = new AbortController();
        const input = {
          directory,
          url,
          key,
          signal: AbortSignal.any([signal, preparation.signal]),
        };
        void watchedExit.then(() => {
          preparation.abort();
        });
        const hello = async () => {
          try {
            input.signal.throwIfAborted();
            const status = await effects.installHello(input);
            if (status < 200 || status >= 300)
              throw new Error(
                `Hello App installation returned HTTP ${String(status)}.`,
              );
          } catch (cause) {
            preparation.abort();
            if (signal.aborted || cause instanceof CleanupError) throw cause;
            assertRunning();
            throw new TryError(
              innermostError(cause).message,
              `Keep your Hello source. Run \`${retryWithLogs()}\` and report the install error if it repeats.`,
            );
          }
        };
        const tourtois = async () => {
          try {
            input.signal.throwIfAborted();
            return await effects.installDesktop(input);
          } catch (cause) {
            if (cause instanceof CleanupError) preparation.abort();
            throw cause;
          }
        };
        const [helloResult, desktopResult] = await Promise.allSettled([
          hello(),
          tourtois(),
        ]);
        // Cleanup failure must not be hidden by its sibling's cancellation.
        for (const result of [helloResult, desktopResult])
          if (
            result.status === "rejected" &&
            result.reason instanceof CleanupError
          )
            throw result.reason;
        for (const result of [helloResult, desktopResult])
          if (
            signal.aborted &&
            result.status === "rejected" &&
            result.reason instanceof InstallationObservationError
          )
            throw result.reason;
        signal.throwIfAborted();
        if (helloResult.status === "rejected") throw helloResult.reason;
        if (desktopResult.status === "rejected")
          throw new DesktopSetupError(desktopResult.reason);
        return desktopResult.value;
      },
    ).catch((cause: unknown) => {
      if (signal.aborted || cause instanceof CleanupError) throw cause;
      assertRunning();
      if (!(cause instanceof DesktopSetupError)) throw cause;
      ui.warn(
        `Tourtois, the desktop, could not be built (${innermostError(cause).message}). Oyster is available for recovery; the desktop is not ready.`,
        isNetworkFailure(innermostError(cause))
          ? `Check your connection, stop this trial with Ctrl-C, then run \`${retry}\` to retry the desktop.`
          : `Stop this trial with Ctrl-C, then run \`${retryWithLogs()}\` and report the desktop build error.`,
      );
      return "failed" as const;
    });
    const desktopReady = desktop === "ready";
    const accessUrl = new URL("/api/installations/tourtois/grants", url).href;
    if (desktop !== "ready" && desktop !== "failed")
      ui.warn(
        desktop === "approval-required"
          ? "Tourtois needs Shell approval."
          : desktop === "disabled"
            ? "Tourtois is disabled."
            : desktop === "deleted"
              ? "Tourtois was removed."
              : "Tourtois is unavailable; its shell entry did not become ready.",
        desktop === "deleted"
          ? `Sign in at ${url}/login, then open your Hello App at ${url}/apps/hello/. The desktop was not reinstalled.`
          : `Sign in, then review App access at ${accessUrl}. Your saved installation and approvals were not changed.`,
      );
    const link = await setupTask(
      desktopReady ? "Preparing desktop sign-in" : "Preparing recovery sign-in",
      async () => {
        const made = await effects.signInLink({ oysterUrl: url, key, signal });
        closeLink = made.close;
        signal.throwIfAborted();
        if (values["no-open"] !== true && process.stdout.isTTY)
          effects.open(made.url, () => {
            if (signal.aborted) return;
            ui.warn(
              "The browser did not open.",
              "Use the sign-in link printed here to open Oyster.",
            );
          });
        return made;
      },
    ).catch((cause: unknown) => {
      if (signal.aborted || cause instanceof CleanupError) throw cause;
      assertRunning();
      throw new TryError(
        innermostError(cause).message,
        `Sign-in could not be prepared. Run \`${retryWithLogs()}\` again; your saved project is unchanged.`,
      );
    });
    assertRunning();
    ui.note(
      desktopReady ? "Oyster is running" : "Oyster needs desktop repair",
      [
        `Open (works once):  ${link.url}`,
        `Oyster:             ${url}`,
        `Owner key saved in: ${keyPath}`,
        `Hello App source:   ${join(directory, "hello-app")}`,
        `Sign in later by pasting that key at ${url}/login.`,
        "Press Ctrl-C to stop.",
      ],
    );
    // Agents answer with a model; say up front, once, what to do when none is.
    if ((await effects.modelSetup({ url, key, signal })) === "missing")
      ui.warn(
        "No model is connected yet, so Agents can't answer.",
        `Open Oyster, choose Keys, then Model keys, and add a key. Guide: ${modelKeyGuideUrl}`,
      );
    // The rest of the starter Apps build here, one at a time, while the desktop
    // is already usable. Each reports one line; a failure never stops the rest.
    const starters = trialStarterOrder.map((id) => {
      const app = standaloneAppSet.find((item) => item.installationId === id);
      if (app === undefined) throw new Error(`${id} is not a starter App`);
      return app;
    });
    const trialAbort = new AbortController();
    const trialSignal = AbortSignal.any([signal, trialAbort.signal]);
    void watchedExit.then(() => {
      trialAbort.abort();
    });
    const stopped = () => trialSignal.aborted;
    // What the desktop shows for each starter App that is not ready yet.
    const pending = new Map<string, InstallingApp>();
    const trial = { url, key, signal: trialSignal };
    const publish = () =>
      effects
        .reportStarters(trial, [...pending.values()])
        .then(undefined, (cause: unknown) => {
          if (!stopped())
            ui.warn(
              `The desktop could not be told which Apps are installing (${innermostError(cause).message}).`,
              "Installs continue; the desktop will not show their progress.",
            );
        });
    const failureReason = (cause: unknown) => {
      const failure = innermostError(cause);
      return {
        code: isNetworkFailure(failure)
          ? ("network" as const)
          : ("build_failed" as const),
        message: failure.message.slice(0, 200) || "The build failed.",
      };
    };
    const installOne = async (app: StarterApp) => {
      const name = app.installationId;
      pending.set(name, {
        installationId: name,
        displayName: app.displayName,
        state: "installing",
      });
      await publish();
      const settled = await effects.installStarter(app, trial).then(
        (result) => ({ kind: "done" as const, result }),
        (cause: unknown) => ({ kind: "failed" as const, cause }),
      );
      if (stopped()) return;
      if (settled.kind === "failed") {
        pending.set(name, {
          installationId: name,
          displayName: app.displayName,
          state: "failed",
          reason: failureReason(settled.cause),
        });
        ui.warn(
          `${name} couldn't be installed: ${innermostError(settled.cause).message}`,
          `Retry it from the desktop, or run \`${retry}\` again.`,
        );
      } else if (app.trial === "needs-runtime" && !computerReady) {
        pending.set(name, {
          installationId: name,
          displayName: app.displayName,
          state: "needs-runtime",
        });
        ui.info(`${name} installed: needs a Computer runtime (see ${name})`);
      } else {
        pending.delete(name);
        ui.info(
          settled.result === "already-installed"
            ? `${name} already installed`
            : `${name} ready`,
        );
      }
      await publish();
    };
    const background = desktopReady
      ? (async () => {
          ui.info(
            `Getting ${String(starters.length)} more Apps ready in the background.`,
          );
          // Every starter shows as getting ready from the start, so the
          // launcher does not grow tile by tile.
          for (const app of starters)
            pending.set(app.installationId, {
              installationId: app.installationId,
              displayName: app.displayName,
              state: "installing",
            });
          await publish();
          for (const app of starters) {
            if (stopped()) return;
            await installOne(app);
          }
          // Then answer the desktop's retry asks until the trial stops.
          while (!stopped()) {
            const waited = await sleep(retryPollMs, undefined, {
              signal: trialSignal,
            }).then(
              () => true,
              () => false,
            );
            if (!waited) return;
            const asked = await effects.takeRetries(trial).then(
              (ids) => ids,
              (): readonly string[] => [],
            );
            for (const id of asked) {
              const app = starters.find((item) => item.installationId === id);
              if (app !== undefined && !stopped()) await installOne(app);
            }
          }
        })()
      : Promise.resolve();
    let stopListener: ReturnType<typeof addAbortListener> | undefined;
    try {
      const requested = new Promise<void>((done) => {
        stopListener = addAbortListener(signal, () => {
          done();
        });
      });
      const outcome = await Promise.race([
        requested.then(() => "interrupted" as const),
        watchedExit.then(() => "exited" as const),
      ]);
      if (outcome === "exited")
        throw new TryError(
          "Oyster stopped unexpectedly.",
          `Read ${join(directory, logFile)}, then run \`${retry}\` again.`,
        );
    } finally {
      stopListener?.[Symbol.dispose]();
      trialAbort.abort();
      await background;
    }
  } catch (cause) {
    if (!isTryCancellation(cause, signal)) throw cause;
    if (cause instanceof InstallationObservationError) ui.info(cause.message);
  } finally {
    try {
      const cleanup = async () => {
        const computerStopped = await Promise.allSettled([
          Promise.resolve().then(() => closeComputer?.()),
        ]);
        const outcomes = [
          ...computerStopped,
          ...(await Promise.allSettled([
            Promise.resolve().then(() => closeLink?.()),
            Promise.resolve().then(() => acquiredServer?.stop()),
          ])),
        ];
        if (outcomes.some((result) => result.status === "rejected"))
          throw new TryError(
            "Oyster cleanup did not complete.",
            `Check ${join(directory, logFile)} and the local listener before running \`${retry}\` again.`,
          );
      };
      if (acquiredServer !== undefined || closeLink !== undefined)
        await timedTask(ui, "Stopping Oyster", cleanup);
      else await cleanup();
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
  ui.outro(`Stopped. Restart with \`${retry}\`.`);
}

/** Whether `git` is available; Hello App packing reads its commit. */
async function gitAvailable(signal: AbortSignal): Promise<boolean> {
  try {
    await runGit(["--version"], process.cwd(), signal, process.env);
    return true;
  } catch (cause) {
    if (cause instanceof CleanupError) throw cause;
    signal.throwIfAborted();
    return false;
  }
}
