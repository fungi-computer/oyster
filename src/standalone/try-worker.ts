// Private child of `oyster try`: credentials arrive over stdin, never argv.
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import * as z from "zod";

const inputSchema = z.strictObject({
  directory: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  key: z.string().min(1),
});

/** Wrangler owns the local Worker; the trial owns its credentials and lifetime. */
export function trialWorkerConfiguration(input: {
  directory: string;
  port: number;
  key: string;
}): Parameters<typeof unstable_startWorker>[0] {
  return {
    config: join(input.directory, "wrangler.jsonc"),
    sendMetrics: false,
    bindings: {
      OYSTER_OWNER_KEY: { type: "secret_text", value: input.key },
      OYSTER_ORIGIN: {
        type: "plain_text",
        value: `http://127.0.0.1:${String(input.port)}`,
      },
      OYSTER_COMPUTER_BACKEND: { type: "plain_text", value: "local" },
    },
    dev: {
      remote: false,
      server: { hostname: "127.0.0.1", port: input.port },
      inspector: false,
      enableContainers: false,
    },
  };
}

async function main() {
  const stopped = Promise.withResolvers<undefined>();
  const stop = () => {
    stopped.resolve(undefined);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 64 * 1024) throw new Error("Trial input too large");
    }
    const worker = await unstable_startWorker(
      trialWorkerConfiguration(inputSchema.parse(JSON.parse(text))),
    );
    try {
      await worker.ready;
      await stopped.promise;
    } finally {
      await worker.dispose();
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    // A provider or configuration error can contain credentials.
    process.stderr.write("[ERROR] The local Oyster worker could not start.\n");
    process.exitCode = cause instanceof z.ZodError ? 2 : 1;
  });
}
