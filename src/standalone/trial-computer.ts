import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Option, Schema } from "effect";

const readRuntimeStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ kind: Schema.Literals(["online", "no_runtime"]) }),
  ),
);

class TrialComputerUnavailable extends Error {
  readonly code = "no_runtime";
  constructor() {
    super(
      "Install the Truffle local runtime and make fungi-local-computer available on PATH, then restart oyster try.",
    );
    this.name = "TrialComputerUnavailable";
  }
}

/** Local owns attachment and sandboxing; Oyster owns the CLI child's lifetime. */
export async function startTrialComputer(input: {
  directory: string;
  url: string;
  key: string;
  signal: AbortSignal;
}): Promise<{ stop(): Promise<void> }> {
  const folder = join(input.directory, "computer");
  await mkdir(folder, { recursive: true });
  input.signal.throwIfAborted();
  const child = spawn(
    process.env.FUNGI_LOCAL_COMPUTER ?? "fungi-local-computer",
    ["attach"],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const online = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<undefined>();
  const unavailable = () => {
    online.reject(new TrialComputerUnavailable());
  };
  child.once("error", unavailable);
  child.once("close", () => {
    unavailable();
    closed.resolve(undefined);
  });
  child.stdin.on("error", unavailable);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const status = readRuntimeStatus(line);
    if (Option.isSome(status) && status.value.kind === "online")
      online.resolve(undefined);
    else unavailable();
  });
  const abort = () => {
    child.kill("SIGTERM");
    online.reject(input.signal.reason);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  child.stdin.end(
    JSON.stringify({
      endpoint: new URL("/mcp", input.url).href,
      computer: "workspace",
      computerId: "workspace",
      folderPath: folder,
      credentialPath: join(input.directory, ".oyster", "computer.json"),
      ownerKey: input.key,
    }),
  );
  const timer = setTimeout(unavailable, 30_000);
  const stop = async () => {
    input.signal.removeEventListener("abort", abort);
    child.kill("SIGTERM");
    await closed.promise;
    lines.close();
  };
  try {
    await online.promise;
    input.signal.throwIfAborted();
    return { stop };
  } catch (cause) {
    await stop();
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
