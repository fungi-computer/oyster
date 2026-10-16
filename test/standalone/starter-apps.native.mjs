// The seven starter Apps install on a fresh Oyster from their published
// editable sources, each built on the Oyster's own Computer: no App is
// compiled here and no installed App is needed to build. Then a second
// distribution of the same Apps (a later commit) fast-forwards each template,
// builds again and replaces each installation with its new Release.
//
// The Oyster is the production root over the native Git provider
// (landed-push-root.fixture.ts), started fresh on the claimed lab slot, as the
// app-build native proof runs it. Requires OYSTER_PROOF_ENV_FILE (mode 0600)
// naming an already-running lab vmd and that slot; claim the slot first.
import process from "node:process";
import assert from "node:assert/strict";
import { log } from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import * as z from "zod";
import { parse as parseJsonc } from "jsonc-parser";
import {
  installStandaloneAppSet,
  standaloneAppSet,
} from "@fungi.computer/oyster/standalone/app-set";
import { labComputer } from "./lab-computer.fixture.mjs";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const bonsai = fileURLToPath(new URL("../../", import.meta.url));
const { port, vars: computerVars } = await labComputer();
const provider = await workflowGitProvider();
await mkdir(`${bonsai}.botanical`, { recursive: true });
const work = await mkdtemp(`${bonsai}.botanical/starter-apps-native-`);
const config = parseJsonc(
  await readFile(`${bonsai}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${bonsai}test/standalone/landed-push-root.fixture.ts`;
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const url = `http://127.0.0.1:${String(port)}`;
const tenantHost = "oyster.test";
const vars = {
  ...computerVars,
  OYSTER_OWNER_KEY: key,
  OYSTER_ORIGIN: `https://${tenantHost}`,
  GIT_ORIGIN: provider.origin,
};
const redact = (text) =>
  Object.values(vars).reduce(
    (message, value) => message.replaceAll(value, "[REDACTED]"),
    String(text),
  );
let output = "";
const worker = spawn(
  `${bonsai}node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    `${work}/wrangler.json`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--local-upstream",
    tenantHost,
    "--upstream-protocol",
    "https",
    ...Object.entries(vars).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]),
  ],
  { cwd: bonsai, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));
const auth = { Authorization: `Bearer ${key}` };
const installations = async () =>
  z
    .array(
      z.looseObject({
        installationId: z.string(),
        status: z.string(),
        release: z.looseObject({
          releaseId: z.string(),
          artifact: z.looseObject({
            provenance: z.looseObject({ sourceRevision: z.string() }),
          }),
        }),
      }),
    )
    .parse(
      await (
        await globalThis.fetch(new URL("/api/installations", url), {
          headers: auth,
        })
      ).json(),
    );

try {
  const deadline = Date.now() + 90_000;
  while (
    !(await globalThis.fetch(`${url}/login`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    assert.equal(worker.exitCode, null, "Standalone Oyster exited");
    assert.ok(Date.now() < deadline, "Standalone Oyster did not start");
    await delay(200);
  }
  assert.deepEqual(await installations(), [], "The Oyster must be fresh");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();

  /** Install the whole set from one commit of one repository and check it. */
  async function installFrom(directory, commit, expected) {
    const started = Date.now();
    const results = await installStandaloneAppSet({
      source: { kind: "checkout", directory, revision: `git:${commit}` },
      url,
      key,
      report: log,
    });
    log(
      `step: ${expected.installed} all seven in ${String(Date.now() - started)}ms`,
    );
    assert.deepEqual(
      results.map((result) => result.installationId),
      standaloneAppSet.map((app) => app.installationId),
    );
    assert.equal(results[0]?.installationId, "tourtois");
    const current = await installations();
    for (const result of results) {
      // The distribution names the deploy commit; the Release names its seed.
      assert.equal(result.sourceRevision, `git:${commit}`);
      assert.equal(result.published, "recorded");
      assert.equal(result.installed, expected.installed);
      const installed = current.find(
        (installation) => installation.installationId === result.installationId,
      );
      assert.ok(installed, `${result.installationId} is installed`);
      assert.equal(installed.status, "enabled");
      assert.equal(
        installed.release.artifact.provenance.sourceRevision,
        result.seedRevision,
      );
    }
    return results;
  }

  const first = await installFrom(repository, head, { installed: "installed" });

  // A later commit of the same sources: a disposable local clone with one
  // empty commit, so every template's distribution (which records its
  // upstream revision) has a different tree.
  const later = await mkdtemp(join(tmpdir(), "starter-apps-later-"));
  try {
    execFileSync("git", ["clone", "-q", "--shared", repository, later]);
    execFileSync("git", [
      "-C",
      later,
      "-c",
      "user.name=Starter proof",
      "-c",
      "user.email=starter@test.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Later distribution",
    ]);
    const next = execFileSync("git", ["-C", later, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const second = await installFrom(later, next, { installed: "replaced" });
    for (const [index, result] of second.entries())
      assert.notEqual(result.seedRevision, first[index]?.seedRevision);
  } finally {
    await rm(later, { recursive: true, force: true });
  }

  // Nothing was packed on this machine.
  await assert.rejects(access(join(bonsai, ".botanical/app-set")));
  log("PASS starter Apps build on the Computer and install from their sources");
} catch (cause) {
  await writeFile(`${work}/worker.log`, redact(output));
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
}
