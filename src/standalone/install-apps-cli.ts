#!/usr/bin/env node
// `oyster install-apps`: seed, build on the Oyster's own Computer, and install
// the starter Apps (Tourtois, Bonsai, Shed, Inkcap, Trellis, Prints and
// Grove). Each App comes from its own public repository by default, or from a
// Botanical checkout with `--from <directory>`.
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
  defaultStarterBuildConcurrency,
  installStandaloneAppSet,
  type InstalledStarterApp,
  type StarterAppSource,
} from "./app-set.js";

/** The starter Apps' public source repositories. */
const defaultRepositories = "https://github.com/fungi-computer";

const usage =
  "Usage: oyster install-apps [--repositories <base URL>] [--ref <ref>] [--from <checkout>] [--concurrency 1-3] [--timings <file>]";

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
    },
    strict: true,
  });
  const url = process.env.OYSTER_URL;
  const key = process.env.OYSTER_OWNER_KEY;
  if (!url || !key) throw new Error("Set OYSTER_URL and OYSTER_OWNER_KEY");
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
if (command !== "install-apps") {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else
  await installApps(rest).catch((cause: unknown) => {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = 1;
  });
