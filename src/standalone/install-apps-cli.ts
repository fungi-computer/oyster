#!/usr/bin/env node
// `oyster install-apps`: seed, build on the Oyster's own Computer, and install
// the seven starter Apps (Tourtois, Bonsai, Shed, Inkcap, Trellis, Prints,
// and Grove). Each comes from its own public repository by default,
// or from a Botanical checkout with `--from <directory>`.
//
//   OYSTER_URL=https://… OYSTER_OWNER_KEY=… oyster install-apps
//     [--repositories <base URL>] [--ref <branch or tag>]
//     [--from <checkout directory>] [--concurrency 1-3] [--timings <file>]
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  installReleaseCommand,
  installReleaseUsage,
} from "../install-release-cli.js";
import {
  defaultStarterBuildConcurrency,
  installStandaloneAppSet,
  type InstalledStarterApp,
  type StarterAppSource,
} from "./app-set.js";

/** The starter Apps' public source repositories. */
const defaultRepositories = "https://github.com/fungi-computer";

const usage =
  "Usage: oyster install-apps [--repositories <base URL>] [--ref <ref>] [--from <checkout>] [--concurrency 1-3] [--timings <file>]";

const urlSource =
  "OYSTER_URL is the address of your deployed Oyster Worker, such as https://oyster.<your-subdomain>.workers.dev (http://127.0.0.1:8787 for a local one). You set it when you deploy.";
const keySource =
  "OYSTER_OWNER_KEY is the owner key you chose for that Oyster: export OYSTER_OWNER_KEY=$(openssl rand -hex 24), then store it with `wrangler secret put OYSTER_OWNER_KEY`.";

const helpText = `${usage}

Builds the seven starter Apps on your Oyster's own Computer and installs them.
Starter builds need a deployed Oyster host; this command does not create one.
Deploy first (see the Oyster README), then set:

  ${urlSource}
  ${keySource}

Options:
  --repositories <base URL>  fetch each App from <base URL> instead of the public repositories
  --ref <ref>                branch or tag to build (default main)
  --from <checkout>          install from a Botanical checkout directory
  --concurrency 1-3          Apps to build at once
  --timings <file>           write the build timings as JSON
  -h, --help                 show this help
`;

function missingVariableMessage(
  url: string | undefined,
  key: string | undefined,
): string {
  const lines = [];
  if (!url) lines.push(`OYSTER_URL is not set. ${urlSource}`);
  if (!key) lines.push(`OYSTER_OWNER_KEY is not set. ${keySource}`);
  lines.push("Run oyster install-apps --help for details.");
  return lines.join("\n");
}

function seconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function timingTable(results: readonly InstalledStarterApp[]) {
  const rows = results.map(({ installationId, timings }) => [
    installationId,
    seconds(timings.fetch),
    seconds(timings.publish),
    seconds(timings.queue),
    seconds(timings.build),
    timings.computer === null ? "-" : seconds(timings.computer.clone),
    timings.computer === null ? "-" : seconds(timings.computer.install),
    timings.computer === null ? "-" : seconds(timings.computer.build),
    timings.computer === null ? "-" : seconds(timings.computer.upload),
    seconds(timings.install),
  ]);
  const header = [
    "App",
    "fetch",
    "seed",
    "queue",
    "build",
    "clone",
    "deps",
    "compile",
    "upload",
    "install",
  ];
  return [header, ...rows].map((row) => row.join("\t")).join("\n");
}

async function installApps(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      repositories: { type: "string" },
      ref: { type: "string" },
      from: { type: "string" },
      concurrency: { type: "string" },
      timings: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(helpText);
    return;
  }
  const url = process.env.OYSTER_URL;
  const key = process.env.OYSTER_OWNER_KEY;
  if (!url || !key) throw new Error(missingVariableMessage(url, key));
  if (values.from !== undefined && values.repositories !== undefined)
    throw new Error("Choose either --from or --repositories");
  const concurrency =
    values.concurrency === undefined
      ? defaultStarterBuildConcurrency
      : Number(values.concurrency);
  const scratch = await mkdtemp(join(tmpdir(), "oyster-install-apps-"));
  try {
    let source: StarterAppSource;
    if (values.from === undefined)
      source = {
        kind: "repositories",
        base: (values.repositories ?? defaultRepositories).replace(/\/+$/u, ""),
        ref: values.ref ?? "main",
        scratch,
      };
    else {
      const directory = resolve(values.from);
      const revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      source = { kind: "checkout", directory, revision: `git:${revision}` };
    }
    const started = performance.now();
    const results = await installStandaloneAppSet({
      source,
      url,
      key,
      concurrency,
      report: (message) => {
        process.stdout.write(`${message}\n`);
      },
    });
    const elapsed = performance.now() - started;
    process.stdout.write(`\n${timingTable(results)}\n`);
    process.stdout.write(
      `\nInstalled ${String(results.length)} Apps in ${seconds(elapsed)}. Open ${url}/ to use Tourtois and the installed Apps.\n`,
    );
    if (values.timings !== undefined)
      await writeFile(
        values.timings,
        JSON.stringify(
          {
            concurrency,
            elapsedMs: elapsed,
            apps: results.map(({ installationId, jobId, timings }) => ({
              installationId,
              jobId,
              timings,
            })),
          },
          null,
          2,
        ) + "\n",
      );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "--help" || command === "-h") {
  process.stdout.write(usage + "\n" + installReleaseUsage + "\n");
} else if (command !== "install-apps" && command !== "install") {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else
  await (
    command === "install" ? installReleaseCommand(rest) : installApps(rest)
  ).catch((cause: unknown) => {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = 1;
  });
