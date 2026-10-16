// Standalone Oyster's Computer egress, end to end on a real on-box VM: the
// production root (wrangler dev, landed-push-root.fixture.ts) with real
// Bonsai installed, a real lab vmd Computer, and a guest `git` reaching
// https://oyster.test over the vmd's HTTPS interception -> ComputerDO ->
// OysterComputerEgress -> this Worker's own default export. Hosts outside
// its lanes (origin Git, public package downloads, a live build job's
// internal hosts) must be refused by the same gateway.
//
// Requires OYSTER_PROOF_ENV_FILE (mode 0600) naming an already-running lab
// vmd and the worker slot port it calls back to, as shed-terminal-proof.mjs
// and storyboard.native.mjs do. Claim that slot first.
import process from "node:process";
import { log, error } from "node:console";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import * as z from "zod";
import { parse as parseJsonc } from "jsonc-parser";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { backendMediaType } from "@fungi.computer/puffball/backend";
import { sha256 } from "@fungi.computer/oyster/host";
import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { appBackend } from "../../../../apps/bonsai/backend/methods.ts";
import packageMetadata from "../../../../apps/bonsai/package.json" with { type: "json" };
import { workflowGitProvider } from "./workflow-git.fixture.mjs";

const fixturePath = process.env.OYSTER_PROOF_ENV_FILE;
assert.ok(fixturePath, "OYSTER_PROOF_ENV_FILE must name the lab VM fixture");
assert.equal((await stat(fixturePath)).mode & 0o777, 0o600);
const fixture = z
  .object({
    COMPUTER_PROOF_PORT: z.coerce.number().int().min(1).max(65535),
    COMPUTER_VM_ORIGIN: z.url(),
    COMPUTER_VM_DEFAULT_HOST: z.string().min(1),
    COMPUTER_VM_HOSTS: z.string().min(1),
    COMPUTER_VM_SIGNING_KEY: z.string().min(1),
  })
  .parse(parseEnv(await readFile(fixturePath, "utf8")));
const { COMPUTER_PROOF_PORT: port, ...computerVars } = fixture;
// The lab vmd calls back to exactly this slot; a holder must fail loudly.
await new Promise((resolve, reject) => {
  const socket = createServer()
    .once("error", (cause) =>
      reject(new Error(`Worker slot ${String(port)} is taken`, { cause })),
    )
    .listen(port, "127.0.0.1", () => socket.close(resolve));
});

const appDeclaration = buildAppDeclaration(
  appBackend,
  packageMetadata.fungi.app,
);
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/computer-egress-native-`);
const config = parseJsonc(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/landed-push-root.fixture.ts`;
config.vars = {
  ...config.vars,
  WORKFLOW_CODE_LOCAL_DEV: process.env.CELLD_PLATFORM_CELLD ? "false" : "true",
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const provider = await workflowGitProvider();
const origin = `http://127.0.0.1:${String(port)}`;
const tenantHost = "oyster.test";
const auth = { Authorization: `Bearer ${key}` };
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
const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/standalone/landed-push-root.fixture.ts`,
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
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
// Redacted worker log, kept after the run for diagnosis.
const workerLog = `${root}.botanical/computer-egress-native.log`;
await writeFile(workerLog, "");
const capture = (chunk) => {
  output += chunk;
  void appendFile(workerLog, redact(chunk));
};
worker.stdout.on("data", capture);
worker.stderr.on("data", capture);
const stopped = new Promise((resolve) => worker.once("exit", resolve));

async function call(installation, method, input) {
  const response = await globalThis.fetch(
    `${origin}/apps/${installation}/methods/${method}`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, `${installation}.${method}: ${text}`);
  return JSON.parse(text);
}
async function persist(value) {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  const response = await globalThis.fetch(
    `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
    {
      method: "PUT",
      headers: auth,
      body: bytes,
      signal: globalThis.AbortSignal.timeout(120_000),
    },
  );
  assert.equal(response.status, 204, await response.text());
  return { artifactRef, digest, byteLength: bytes.length, version: digest };
}
async function installBonsai() {
  const bundled = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../../../apps/bonsai/backend/index.ts", import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
    target: "es2022",
  });
  const backend = {
    ...(await persist({
      runtime: { kind: "durable-facet", stateSchema: 1 },
      compatibilityDate: "2026-09-04",
      exportName: "BonsaiApp",
      code: bundled.outputFiles[0].text,
    })),
    mediaType: backendMediaType,
  };
  log("step: backend persisted");
  const artifact = await persist(createAppBuild(null, backend, appDeclaration));
  log("step: build persisted; installing");
  const response = await globalThis.fetch(`${origin}/api/installations`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      installationId: "bonsai",
      release: {
        appId: "app_bonsai",
        releaseId: "rel_bonsai",
        artifact: {
          artifactRef: artifact.artifactRef,
          artifactDigest: artifact.digest,
          provenance: {
            sourceRevision: `git:${"a".repeat(40)}`,
            sourceTreeDigest: artifact.digest,
            buildRecipeDigest: artifact.digest,
          },
        },
      },
    }),
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  assert.equal(response.status, 201, await response.text());
}
// Always async: the in-process Git provider answers on this event loop.
async function hostGit(...args) {
  const child = spawn("git", args, {
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(status, 0, redact(stderr));
  return stdout.trim();
}

const timings = {};
try {
  const deadline = Date.now() + 90_000;
  while (
    !(await globalThis
      .fetch(`${origin}/login`, {
        signal: globalThis.AbortSignal.timeout(2_000),
      })
      .then(
        (response) => response.ok,
        () => false,
      ))
  ) {
    assert.equal(worker.exitCode, null, "Standalone Oyster exited");
    assert.ok(Date.now() < deadline, "Standalone Oyster did not start");
    await delay(200);
  }
  log("step: Oyster ready; installing Bonsai");
  await installBonsai();
  log("step: Bonsai installed; creating pond");
  await call("bonsai", "repos.create", { name: "pond" });
  // One commit from the host, through the same door, so ls-remote has a ref.
  await mkdir(`${work}/checkout`);
  await hostGit("-C", "checkout", "init", "-q", "-b", "main");
  await writeFile(`${work}/checkout/hello.txt`, "hello\n");
  await hostGit("-C", "checkout", "add", "hello.txt");
  await hostGit(
    "-C",
    "checkout",
    "-c",
    "user.name=Owner",
    "-c",
    "user.email=owner@test.invalid",
    "commit",
    "-qm",
    "Start pond",
  );
  await hostGit(
    "-C",
    "checkout",
    "-c",
    `http.extraHeader=Authorization: Bearer ${key}`,
    "push",
    "-q",
    `${origin}/git/bonsai/pond.git`,
    "main",
  );
  const head = await hostGit("-C", "checkout", "rev-parse", "HEAD");
  log("step: pond seeded from the host; connecting MCP");

  // The owner reaches the Computer over MCP, as an Agent client does.
  const client = new Client(
    { name: "Oyster Computer egress proof", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler("elicitation/create", () => ({
    action: "accept",
    content: { approve: true },
  }));
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: { headers: auth },
    },
  );
  await client.connect(transport);
  const execute = async (code) => {
    const result = await client.callTool(
      { name: "execute", arguments: { code } },
      { timeout: 240_000 },
    );
    const text = redact(JSON.stringify(result.content));
    assert.notEqual(result.isError, true, text);
    return text;
  };
  // `exec` may be answered by the Worker shell; a process always runs on
  // the hosted backend, here the lab VM, so the guest's own network is used.
  let runs = 0;
  const guest = async (command) => {
    const started = Date.now();
    runs += 1;
    const out = `/workspace/egress-proof-${String(runs)}.txt`;
    log(`step: guest process ${redact(command)}`);
    const startedText = await execute(
      `return await env.computers.workspace.start_process(${JSON.stringify({
        command: `{ ${command}; } > ${out} 2>&1; echo "exit=$?" >> ${out}`,
        cwd: "/workspace",
      })})`,
    );
    const id = /\\"id\\":\\"([^\\"]+)/u.exec(startedText)?.[1];
    assert.ok(id, `No process id: ${startedText}`);
    for (;;) {
      assert.ok(Date.now() - started < 180_000, "Guest process did not exit");
      const listed = await execute(
        "return await env.computers.workspace.list_processes({})",
      );
      if (
        listed.includes(id) &&
        !new RegExp(`${id}[^}]*running`, "u").test(listed)
      )
        break;
      await delay(1_000);
    }
    for (;;) {
      assert.ok(Date.now() - started < 180_000, "Guest output never synced");
      const read = await execute(
        `return (await env.computers.workspace.read(${JSON.stringify({ path: out })})).content`,
      );
      // The tool result is JSON text; decode it back to the file's lines.
      const text = z
        .array(z.object({ text: z.string() }))
        .parse(JSON.parse(read))
        .map((part) => JSON.parse(part.text))
        .join("");
      if (/exit=\d/u.test(text)) return { text, ms: Date.now() - started };
      await delay(1_000);
    }
  };
  try {
    const remote = `https://${tenantHost}/git/bonsai/pond.git`;
    const listed = await guest(
      `git -c "http.extraHeader=Authorization: Bearer ${key}" ls-remote ${remote}`,
    );
    timings.lsRemote = listed.ms;
    assert.match(listed.text, new RegExp(`${head}\\s+refs/heads/main`, "u"));
    assert.match(listed.text, /exit=0/u);
    log(`PASS guest git ls-remote ${remote} -> ${head} (${listed.ms}ms)`);

    // No credential: the egress adds none, so the door challenges.
    const anonymous = await guest(`git ls-remote ${remote}`);
    assert.doesNotMatch(anonymous.text, /exit=0/u);
    assert.doesNotMatch(anonymous.text, new RegExp(head, "u"));
    log("PASS guest git without a credential is challenged by Oyster's door");

    for (const outside of [
      "https://example.com/",
      "https://github.com/git/git.git/info/refs?service=git-upload-pack",
      `https://${tenantHost}/api/installations`,
    ]) {
      const refused = await guest(
        `curl -sS -o /dev/null -w "status=%{http_code}" ${JSON.stringify(outside)}`,
      );
      assert.match(refused.text, /status=403/u, `${outside}: ${refused.text}`);
      log(`PASS guest ${outside} refused by the egress gateway (403)`);
    }
  } finally {
    await transport.terminateSession();
    await client.close();
  }
  assert.match(
    output,
    /"event":"computer\.egress".*"lane":"origin-git"/u,
    "The gateway recorded the admitted Oyster Git lane",
  );
  log(`PASS computer egress native proof ${JSON.stringify(timings)}`);
} catch (cause) {
  error(redact(output));
  throw cause;
} finally {
  worker.kill("SIGTERM");
  await stopped;
  await provider.close();
  await rm(work, { recursive: true, force: true });
}
