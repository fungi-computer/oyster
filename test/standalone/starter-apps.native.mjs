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
// Fleet assertions also require approved capacity for the configured Computer
// plus A and B, authorized Workers AI credentials and distinct HTTPS ingress.
// None of those prerequisites is provisioned by this runner.
import process from "node:process";
import { waitForNativeRoot } from "../native-root-readiness.fixture.mjs";
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
import { join } from "node:path";

import { URL, URLPattern, fileURLToPath } from "node:url";
import * as z from "zod";
import { parse as parseJsonc } from "jsonc-parser";
import * as Schema from "effect/Schema";
import {
  MediaGeneration,
  mediaGenerationDescriptionSchema,
} from "@fungi.computer/agar/media-json";
import { computerPortsSchema } from "@fungi.computer/agar/computer";
import { previewOrigins } from "../../src/standalone/preview.ts";
import {
  computerProcessSchema,
  processListOutputSchema,
} from "@fungi.computer/computer-contract";
import {
  workbenchDirectorySchema,
  workbenchComputerDirectorySchema,
} from "@fungi.computer/nacre/workbench-directory";
import {
  installStandaloneAppSet,
  standaloneAppSet,
} from "@fungi.computer/oyster/standalone/app-set";
import { labComputer } from "./lab-computer.fixture.mjs";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";

const expectedStarterIds = [
  "tourtois",
  "bonsai",
  "shed",
  "inkcap",
  "trellis",
  "prints",
  "grove",
];
assert.deepEqual(
  standaloneAppSet.map((app) => app.installationId),
  expectedStarterIds,
);

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const bonsai = fileURLToPath(new URL("../../", import.meta.url));
const origins = previewOrigins({
  OYSTER_ORIGIN: process.env.OYSTER_ORIGIN,
  OYSTER_PREVIEW_ORIGIN: process.env.OYSTER_PREVIEW_ORIGIN,
});
assert.ok(
  origins,
  "Supply distinct authorized HTTPS OYSTER_ORIGIN/OYSTER_PREVIEW_ORIGIN ingress to this disposable Worker",
);
const { port, vars: computerVars } = await labComputer();
const provider = await workflowGitProvider();
await mkdir(`${bonsai}.botanical`, { recursive: true });
const work = await mkdtemp(`${bonsai}.botanical/starter-apps-native-`);
const config = parseJsonc(
  await readFile(`${bonsai}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${bonsai}test/standalone/landed-push-root.fixture.ts`;
// Wrangler's ordinary remote Workers AI binding, never a test provider. Running
// this expanded qualification requires separate provider/capacity authorization.
config.ai = { binding: "AI", remote: true };
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
// Both externally owned HTTPS ingresses must preserve their Host and reach this
// TLS listener. The vmd slot owner must prepare its callback for this listener;
// this runner neither provisions ingress nor reconfigures/restarts vmd.
const url = origins.owner;
const vars = {
  ...computerVars,
  OYSTER_OWNER_KEY: key,
  OYSTER_ORIGIN: origins.owner,
  OYSTER_PREVIEW_ORIGIN: origins.preview,
  GIT_ORIGIN: provider.origin,
};
const redact = (text) =>
  Object.values(vars).reduce(
    (message, value) => message.replaceAll(value, "[REDACTED]"),
    String(text),
  );
let output = "";
function startWorker() {
  const child = spawn(
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
      "--local-protocol",
      "https",
      ...Object.entries(vars).flatMap(([name, value]) => [
        "--var",
        `${name}:${value}`,
      ]),
    ],
    { cwd: bonsai, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return {
    child,
    stopped: new Promise((resolve) => child.once("exit", resolve)),
  };
}
let { child: worker, stopped } = startWorker();
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

const rootReadiness = {
  milliseconds: 90_000,
  interval: 200,
  label: "Standalone Oyster did not start",
};
try {
  await waitForNativeRoot(worker, url, rootReadiness);
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
      expectedStarterIds,
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

  // These are the production HTTP owners over the claimed real vmd, not a
  // substituted Computer. Destination metadata is checked separately from the
  // real provider output and replay assertions below.
  const request = (path, init = {}) =>
    globalThis.fetch(new URL(path, url), {
      ...init,
      headers: { ...auth, ...init.headers },
    });
  const json = async (path, init) => {
    const response = await request(path, init);
    assert.equal(
      response.status,
      200,
      `${path}: ${await response.clone().text()}`,
    );
    return response.json();
  };
  const post = (body) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const directory = async () =>
    workbenchDirectorySchema.parse(await json("/api/workbench/directory"));
  const configured = (await directory()).computer;
  assert.ok(configured, "The configured build Computer is offered");
  const choiceSchema = workbenchComputerDirectorySchema.shape.computers.element;
  const created = [];
  for (const name of ["Fleet A", "Fleet B"]) {
    const input = { name, requestId: `starter-apps-${name}` };
    const computer = choiceSchema.parse(
      await json("/api/computers", post(input)),
    );
    const replay = choiceSchema.parse(
      await json("/api/computers", post(input)),
    );
    assert.deepEqual(
      replay,
      computer,
      "Create replay retains the same identity",
    );
    created.push(computer);
  }
  const [a, b] = created;
  assert.ok(a && b);
  assert.notEqual(a.computerId, b.computerId);
  assert.notEqual(a.computerId, configured.computerId);
  assert.notEqual(b.computerId, configured.computerId);
  for (const [path, expected] of [
    ["/api/computers", created],
    ["/api/workbench/computers", [configured, ...created]],
  ]) {
    const rows = [];
    let offset = 0;
    while (true) {
      const page = workbenchComputerDirectorySchema.parse(
        await json(`${path}?limit=1&offset=${String(offset)}`),
      );
      rows.push(...page.computers);
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset, "Inventory cursor must advance");
      offset = page.nextOffset;
    }
    assert.deepEqual(
      rows.map((row) => row.computerId).sort(),
      expected.map((row) => row.computerId).sort(),
      "Pagination includes every Computer, with no duplicate create receipt",
    );
  }
  const select = async (computerId) => {
    await json("/api/computers/selected", {
      ...post({ computerId }),
      method: "PUT",
    });
    assert.equal((await directory()).computer?.computerId, computerId);
  };
  const capability = (computerId, path, init = {}) => {
    const target = new URL(path, url);
    target.searchParams.set("computerId", computerId);
    return request(target, {
      ...init,
      headers: { "X-Oyster-Installation": "shed", ...init.headers },
    });
  };
  const filePath = "/fleet-isolation.txt";
  const file = `/files/content?path=${encodeURIComponent(filePath)}`;
  for (const computer of [configured, a, b]) {
    if (computer !== configured) {
      for (let replay = 0; replay < 2; replay++) {
        const started = await json(
          `/api/computers/${encodeURIComponent(computer.computerId)}/start`,
          { method: "POST" },
        );
        assert.equal(started.state, "running");
      }
    }
    // This explicit window request must not change the durable default.
    const written = await capability(computer.computerId, file, {
      method: "PUT",
      body: computer.computerId,
    });
    assert.equal(written.status, 204, await written.text());
  }
  assert.equal(
    (await directory()).computer?.computerId,
    configured.computerId,
    "Explicit file windows must not change the durable default",
  );
  const processes = [];
  const scenarioFailures = [];
  const runFleetScenario = async () => {
    for (const computer of [a, b]) {
      await select(computer.computerId);
      const server = [
        'let requests = 0; require("node:http").createServer((request,response) => {',
        'response.setHeader("Content-Type", "text/plain");',
        'response.setHeader("Set-Cookie", "fleet_canary=yes; Path=/");',
        "response.end(JSON.stringify({",
        `computerId: ${JSON.stringify(computer.computerId)},`,
        "headers: request.headers, url: request.url, requests: ++requests",
        '})); }).listen(3000, "0.0.0.0")',
      ].join(" ");
      const command = `node -e ${JSON.stringify(server)}`;
      const input = post({ command, port: 3000, requestId: "fleet-process" });
      const started = await capability(
        computer.computerId,
        "/computer/processes/start",
        input,
      );
      assert.equal(started.status, 200, await started.clone().text());
      const process = computerProcessSchema.parse(await started.json());
      processes.push({
        computerId: computer.computerId,
        id: process.id,
      });
      assert.equal(process.state, "running");
      assert.equal(process.command, command);
      const replay = await capability(
        computer.computerId,
        "/computer/processes/start",
        input,
      );
      assert.equal(replay.status, 200, await replay.clone().text());
      assert.equal(
        computerProcessSchema.parse(await replay.json()).id,
        process.id,
      );
    }
    // B is the default now. Retained explicit A/default handles still read
    // their own bytes and process inventories, never B's mutable default.
    for (const computer of [configured, a, b]) {
      const read = await capability(computer.computerId, file);
      assert.equal(read.status, 200);
      assert.equal(await read.text(), computer.computerId);
      const media = await request(
        `/media/describe?computerId=${encodeURIComponent(computer.computerId)}`,
        { headers: { "X-Oyster-Installation": "prints" } },
      );
      assert.equal(media.status, 200, await media.clone().text());
      assert.equal(
        Schema.decodeUnknownSync(mediaGenerationDescriptionSchema)(
          await media.json(),
        ).computerId,
        computer.computerId,
        "Explicit A/default Media requests cannot follow B's durable selection",
      );
      const listed = await capability(
        computer.computerId,
        "/computer/processes",
      );
      assert.equal(listed.status, 200);
      const inventory = processListOutputSchema.parse(await listed.json());
      for (const process of processes)
        assert.equal(
          inventory.processes.some((row) => row.id === process.id),
          computer.computerId === process.computerId,
          "A process identity cannot appear on another Computer",
        );
    }
    // Use Agar's actual handle: it owns canonical request IDs, Pending polling
    // and restoration. No generated bytes or provider responses are supplied by
    // this runner. Failure to reach the real provider is a failed qualification.
    const mediaFor = (computerId) =>
      new MediaGeneration(async (method, input, options) => {
        const init = {
          headers: { "X-Oyster-Installation": "prints" },
          signal: options?.signal,
        };
        if (input !== undefined) {
          init.method = "POST";
          init.headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(input);
        }
        const response = await request(
          `/media/${method}?computerId=${encodeURIComponent(computerId)}`,
          init,
        );
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      }, computerId);
    const mediaFile = "/files/content?path=%2Ffleet-output.png";
    const saved = [];
    for (const computer of [a, b]) {
      const handle = mediaFor(computer.computerId);
      const description = await handle.describe();
      assert.equal(description.canGenerate, true);
      const model = description.models.find(
        (model) => model.kind === "image" && model.tier === "draft",
      );
      assert.ok(model, "The real host must offer a draft image model");
      const attempt = await handle.createAttempt();
      const reference = await attempt.reference();
      const input = {
        destination: { path: "/fleet-output.png" },
        settings: {
          model: model.id,
          prompt: "A botanical mushroom illustration",
          width: model.input.defaultWidth,
          height: model.input.defaultHeight,
        },
      };
      const outcome = await attempt.generate(input);
      assert.equal(outcome.kind, "succeeded", JSON.stringify(outcome));
      assert.equal(outcome.result.destination.computerId, computer.computerId);
      assert.equal(outcome.result.destination.path, input.destination.path);
      const read = await capability(computer.computerId, mediaFile);
      assert.equal(read.status, 200);
      const bytes = new Uint8Array(await read.arrayBuffer());
      assert.equal(bytes.byteLength, outcome.result.bytes);
      assert.ok(bytes.byteLength > 0);
      saved.push({ computerId: computer.computerId, reference, input, bytes });
      // Before B generates, the same destination must still be absent on B.
      if (computer === a)
        assert.equal((await capability(b.computerId, mediaFile)).status, 404);
      assert.equal(
        (await capability(configured.computerId, mediaFile)).status,
        404,
      );
    }
    // B's write must not replace A's real generated bytes at the same path.
    for (const output of saved) {
      const read = await capability(output.computerId, mediaFile);
      assert.equal(read.status, 200);
      assert.deepEqual(new Uint8Array(await read.arrayBuffer()), output.bytes);
    }
    assert.throws(
      () => mediaFor(b.computerId).restoreAttempt(saved[0].reference),
      { code: "IDENTITY" },
    );
    const tickets = [];
    for (const computer of [a, b]) {
      const exposed = await capability(
        computer.computerId,
        "/computer/ports/expose",
        post({ port: 3000 }),
      );
      assert.equal(exposed.status, 200, await exposed.text());
      const listed = await capability(computer.computerId, "/computer/ports");
      assert.equal(listed.status, 200, await listed.clone().text());
      const ports = Schema.decodeUnknownSync(computerPortsSchema)(
        await listed.json(),
      );
      const port = ports.ports.find((port) => port.port === 3000);
      assert.ok(port);
      assert.equal(port.openMode, "external-only");
      assert.equal(new URL(port.previewUrl).origin, origins.preview);
      tickets.push({ computerId: computer.computerId, url: port.previewUrl });
    }
    const previewEcho = z.object({
      computerId: z.string(),
      headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      url: z.string(),
      requests: z.number().int().positive(),
    });
    const lastPreviewRequests = new Map();
    const readTickets = async () => {
      for (const ticket of tickets) {
        const response = await globalThis.fetch(ticket.url, {
          redirect: "error",
          headers: {
            Authorization: `Bearer ${key}`,
            Cookie: `oyster_session=${key}`,
            "Proxy-Authorization": `Bearer ${key}`,
          },
        });
        assert.equal(response.status, 200);
        const echo = previewEcho.parse(await response.json());
        assert.equal(echo.computerId, ticket.computerId);
        assert.equal(echo.headers.authorization, undefined);
        assert.equal(echo.headers.cookie, undefined);
        assert.equal(echo.headers["proxy-authorization"], undefined);
        assert.equal(echo.url, "/");
        assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
        assert.equal(response.headers.get("Set-Cookie"), null);
        const previous = lastPreviewRequests.get(ticket.computerId);
        if (previous !== undefined)
          assert.equal(
            echo.requests,
            previous + 1,
            "Refused tickets must not forward",
          );
        lastPreviewRequests.set(ticket.computerId, echo.requests);
      }
    };
    // These are A/B tickets issued while B is selected. Consume before and
    // after a real Worker restart over the same durable state, not a new ID.
    await readTickets();
    const mismatched = new URL(tickets[0].url);
    const target = new URLPattern({
      pathname: "/preview/:computerId/:port/:signature/*",
    }).exec(mismatched);
    assert.ok(target);
    mismatched.pathname = `/preview/${encodeURIComponent(b.computerId)}/${target.pathname.groups.port}/${target.pathname.groups.signature}/`;
    const refusedTicket = await globalThis.fetch(mismatched, {
      redirect: "error",
    });
    assert.equal(refusedTicket.status, 403);
    worker.kill("SIGTERM");
    await stopped;
    ({ child: worker, stopped } = startWorker());
    await waitForNativeRoot(worker, url, rootReadiness);
    assert.equal((await directory()).computer?.computerId, b.computerId);
    for (const computer of [a, b]) {
      assert.equal(
        choiceSchema.parse(
          await json(
            `/api/computers/${encodeURIComponent(computer.computerId)}`,
          ),
        ).computerId,
        computer.computerId,
        "Inventory identities survive the Worker restart",
      );
    }
    await readTickets();
    for (const output of saved) {
      const restored = await mediaFor(output.computerId).restoreAttempt(
        output.reference,
      );
      const replay = await restored.generate(output.input);
      assert.equal(replay.kind, "succeeded", JSON.stringify(replay));
      assert.equal(replay.result.destination.computerId, output.computerId);
      const read = await capability(output.computerId, mediaFile);
      assert.equal(read.status, 200);
      assert.deepEqual(new Uint8Array(await read.arrayBuffer()), output.bytes);
    }
    const foreign = "foreign-computer";
    const refused = await request("/api/computers/selected", {
      ...post({ computerId: foreign }),
      method: "PUT",
    });
    assert.equal(refused.status, 404);
    // Workspace admission hides unknown or foreign Computers before dispatch.
    assert.equal(
      (await capability(foreign, file, { method: "PUT", body: "foreign" }))
        .status,
      404,
    );
    assert.equal(
      (
        await request(`/media/describe?computerId=${foreign}`, {
          headers: { "X-Oyster-Installation": "prints" },
        })
      ).status,
      404,
    );
    assert.equal((await directory()).computer?.computerId, b.computerId);
    for (const computer of [configured, a, b]) {
      const read = await capability(computer.computerId, file);
      assert.equal(read.status, 200);
      assert.equal(await read.text(), computer.computerId);
    }
  };
  const [scenario] = await Promise.allSettled([runFleetScenario()]);
  if (scenario.status === "rejected") scenarioFailures.push(scenario.reason);
  // Only process identities created by this proof, through their owning
  // Computer route. No host PID or unrelated lab process is touched.
  const cleanup = await Promise.allSettled(
    processes.map(async (process) => {
      const killed = await capability(
        process.computerId,
        "/computer/processes/kill",
        post({ id: process.id }),
      );
      assert.equal(killed.status, 200, await killed.text());
    }),
  );
  const failures = cleanup
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  scenarioFailures.push(...failures);
  if (scenarioFailures.length > 0)
    throw new AggregateError(
      scenarioFailures,
      "Fleet scenario or cleanup failed",
    );

  // A later commit of the same sources: a disposable local clone with one
  // empty commit, so every template's distribution (which records its
  // upstream revision) has a different tree.
  const later = await mkdtemp(join(work, "later-"));
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
    assert.equal(
      (await directory()).computer?.computerId,
      b.computerId,
      "Rebuilding the App set must not rewrite the selected Computer",
    );
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
