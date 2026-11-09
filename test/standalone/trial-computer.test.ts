import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startTrialComputer } from "../../src/standalone/trial-computer.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(source?: string) {
  const scratch = resolve(".botanical");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "trial-cli-"));
  directories.push(directory);
  const binary = join(directory, "runtime.mjs");
  if (source !== undefined)
    await writeFile(binary, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  vi.stubEnv("FUNGI_LOCAL_COMPUTER", binary);
  return {
    directory,
    url: "https://oyster.test",
    key: "test-owner-key",
    signal: new AbortController().signal,
  };
}

it("returns typed no_runtime when the published CLI is missing", async () => {
  const input = await fixture();
  await expect(startTrialComputer(input)).rejects.toMatchObject({
    code: "no_runtime",
  });
});

it("passes credentials only over stdin and waits for runtime cleanup", async () => {
  const input = await fixture(`
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
if (process.argv.length !== 3 || process.argv[2] !== 'attach') process.exit(2);
if (config.ownerKey !== 'test-owner-key' || config.computerId !== 'workspace') process.exit(3);
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => { writeFileSync(config.folderPath + '/stopped', 'yes'); clearInterval(timer); });
process.stdout.write('{"kind":"online"}\\n');
`);
  const runtime = await startTrialComputer(input);
  await runtime.stop();
  expect(
    await readFile(join(input.directory, "computer/stopped"), "utf8"),
  ).toBe("yes");
});

it("rejects a runtime that exits before attachment becomes ready", async () => {
  const input = await fixture("process.exit(1);");
  await expect(startTrialComputer(input)).rejects.toMatchObject({
    code: "no_runtime",
  });
});

it("rejects a runtime refusal without exposing its diagnostic output", async () => {
  const input = await fixture(
    `process.stderr.write('test-owner-key'); process.stdout.write('{"kind":"no_runtime"}\\n');`,
  );
  await expect(startTrialComputer(input)).rejects.toThrow(
    /The Truffle local runtime could not start/,
  );
});

it("does not start an attachment after cancellation", async () => {
  const input = await fixture();
  await expect(
    startTrialComputer({ ...input, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("stops a child when attachment is cancelled before readiness", async () => {
  const input = await fixture("setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const starting = startTrialComputer({ ...input, signal: controller.signal });
  const refusal = expect(starting).rejects.toMatchObject({
    name: "AbortError",
  });
  const timer = setTimeout(() => {
    controller.abort();
  }, 50);
  try {
    await refusal;
  } finally {
    clearTimeout(timer);
  }
});

it("refuses malformed runtime status instead of reporting readiness", async () => {
  const input = await fixture("process.stdout.write('not-json\\n');");
  await expect(startTrialComputer(input)).rejects.toMatchObject({
    code: "no_runtime",
  });
});

it("starts the runtime installed in the trial project without a global command", async () => {
  const input = await fixture();
  vi.stubEnv("FUNGI_LOCAL_COMPUTER", undefined);
  const binaries = join(input.directory, "node_modules", ".bin");
  await mkdir(binaries, { recursive: true });
  await writeFile(
    join(binaries, "fungi-local-computer"),
    `#!/usr/bin/env node
for await (const chunk of process.stdin) void chunk;
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => clearInterval(timer));
process.stdout.write('{"kind":"online"}\\n');
`,
    { mode: 0o700 },
  );
  const runtime = await startTrialComputer(input);
  await runtime.stop();
});
