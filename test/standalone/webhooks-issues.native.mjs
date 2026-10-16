// Signed webhook deliveries and issues-as-files, against the real standalone
// Oyster Worker + real Bonsai release and a real local Git provider. Worker
// boot copied from seed-demo.browser.mjs (production release pack/install;
// no browser, no demo seeding).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout } from "node:timers";
import { log, error } from "node:console";
import process from "node:process";
import { parse } from "jsonc-parser";
import * as z from "zod";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { hookEvent } from "../../../../apps/bonsai/shared/hooks.ts";
import { readCopyRebuilding } from "@fungi.computer/agar/roles/files";
import {
  repoSummary,
  repoDetail,
  changeRecord,
  changeDetail,
  mergeResult,
  issueFiles,
} from "../../../../apps/bonsai/shared/contract.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/webhooks-issues-`);
const key = randomBytes(24).toString("hex");
const keyFile = `${work}/owner-key`;
await writeFile(keyFile, key, { mode: 0o600 });

async function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
execFileSync("pnpm", ["run", "build"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const bonsai = standaloneAppSet.find((app) => app.installationId === "bonsai");
assert.ok(bonsai);
const releaseDirectory = process.env.BONSAI_SEED_RELEASE ?? `${work}/release`;
if (process.env.BONSAI_SEED_RELEASE) {
  const release = JSON.parse(
    await readFile(`${releaseDirectory}/release.json`, "utf8"),
  );
  assert.equal(
    release.artifact.provenance.sourceRevision,
    `git:${revision}`,
    "Cached release must match committed source",
  );
} else {
  await packRelease({
    appId: bonsai.appId,
    sourceDirectory: repository,
    sourceRevision: `git:${revision}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: bonsai.recipe,
    outDirectory: releaseDirectory,
  });
}
const provider = await workflowGitProvider();
const config = parse(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/workflows-root.fixture.ts`;
// The tenancy registry's checkedOrigin (packages/tenancy/src/registry-record.ts)
// requires an https tenant origin; wrangler's local-upstream loops that host
// back to this same dev server. OYSTER_ORIGIN and GIT_ORIGIN go in as --var
// below (not config.vars), the positional script arg is passed too, and
// OYSTER_OWNER_KEY is a --var, all to match landed-push.native.mjs's boot
// exactly rather than approximate it. The test driver still talks to the
// real listening address (`origin` below), never to "oyster.test".
config.vars = {
  ...config.vars,
  OYSTER_HOME_INSTALLATION: "bonsai",
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));

// A local CA whose leaf certificate the real Worker (workerd, under wrangler
// dev) will trust for genuine outbound TLS, so the webhook subscription's
// required "https://" delivery leaves the process over real TLS rather than
// a stub. The receiver independently verifies each delivery's HMAC below.
const tls = `${work}/tls`;
await mkdir(tls, { recursive: true });
execFileSync("openssl", ["genrsa", "-out", `${tls}/ca.key`, "2048"], {
  stdio: "ignore",
});
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    `${tls}/ca.key`,
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=Webhook Proof CA",
    "-out",
    `${tls}/ca.crt`,
  ],
  { stdio: "ignore" },
);
execFileSync("openssl", ["genrsa", "-out", `${tls}/receiver.key`, "2048"], {
  stdio: "ignore",
});
execFileSync(
  "openssl",
  [
    "req",
    "-new",
    "-key",
    `${tls}/receiver.key`,
    "-subj",
    "/CN=127.0.0.1",
    "-out",
    `${tls}/receiver.csr`,
  ],
  { stdio: "ignore" },
);
await writeFile(`${tls}/ext.cnf`, "[SAN]\nsubjectAltName=IP:127.0.0.1\n");
execFileSync(
  "openssl",
  [
    "x509",
    "-req",
    "-in",
    `${tls}/receiver.csr`,
    "-CA",
    `${tls}/ca.crt`,
    "-CAkey",
    `${tls}/ca.key`,
    "-CAcreateserial",
    "-out",
    `${tls}/receiver.crt`,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    `${tls}/ext.cnf`,
    "-extensions",
    "SAN",
  ],
  { stdio: "ignore" },
);

const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/standalone/workflows-root.fixture.ts`,
    "--config",
    `${work}/wrangler.json`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--var",
    `OYSTER_OWNER_KEY:${key}`,
    "--local-upstream",
    "oyster.test",
    "--upstream-protocol",
    "https",
    "--var",
    "OYSTER_ORIGIN:https://oyster.test",
    "--var",
    `GIT_ORIGIN:${provider.origin}`,
  ],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_EXTRA_CA_CERTS: `${tls}/ca.crt` },
  },
);
let output = "";
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));

const until = async (read, accepts, label) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

async function call(method, input, schema, bearer = key) {
  const response = await globalThis.fetch(
    `${origin}/apps/bonsai/methods/${method}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, `${method}: ${text}`);
  return schema.parse(JSON.parse(text));
}

function gitEnvironment(bearer) {
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete environment.GIT_AUTHOR_DATE;
  delete environment.GIT_COMMITTER_DATE;
  delete environment.GIT_TRACE;
  delete environment.GIT_TRACE_CURL;
  delete environment.GIT_CURL_VERBOSE;
  delete environment.GIT_TRACE_PACKET;
  delete environment.GIT_TRACE_REDACT;
  if (bearer) {
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "http.extraHeader";
    environment.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${bearer}`;
  }
  return environment;
}

// Local-only git (init, add, commit, checkout, rev-parse) never touches the
// network, so it stays synchronous.
function git(directory, args, bearer) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: gitEnvironment(bearer),
  }).trim();
}

// `git push` talks over smart HTTP to our own real wrangler-dev Worker, which
// in turn talks to workflowGitProvider()'s real local git server IN THIS SAME
// Node process. A synchronous execFileSync here blocks the event loop that
// provider needs to answer, deadlocking both sides (as landed-push.native.mjs
// avoids with its own async `push`). So every push runs async, via spawn.
async function gitPush(directory, remote, branch, bearer) {
  const child = spawn("git", ["push", "-q", remote, branch], {
    cwd: directory,
    env: gitEnvironment(bearer),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    text += chunk;
  });
  const status = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(
    status,
    0,
    bearer ? text.split(bearer).join("[redacted]") : text,
  );
}

const gitUrl = (name) => `${origin}/git/bonsai/${encodeURIComponent(name)}.git`;

// A receiver as its own OS process, so the heavy sequence of blocking git and
// openssl calls below can never stall the TLS handshake Oyster's delivery
// makes to it. It verifies the Standard Webhooks `webhook-signature` header
// itself, with Web Crypto (`v1,<base64 HMAC>` of "id.timestamp.body", keyed
// by the subscription's `whsec_`-encoded secret; packages/oyster/src/git.ts),
// independent of any product signing helper. One plain-HTTP control port lets
// this test configure the secret and read back what arrived; the TLS port is
// the only thing Oyster's delivery ever talks to.
const receiverScript = `
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
let secret = null;
const received = [];
async function verifyDelivery(id, timestamp, rawBody, header) {
  if (secret === null) return false;
  const match = /^v1,([A-Za-z0-9+/=]+)$/u.exec(header ?? "");
  if (!match) return false;
  const keyBytes = secret.startsWith("whsec_")
    ? Uint8Array.from(Buffer.from(secret.slice(6), "base64"))
    : new TextEncoder().encode(secret);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = Uint8Array.from(Buffer.from(match[1], "base64"));
  const message = new TextEncoder().encode(\`\${id}.\${timestamp}.\${rawBody}\`);
  return globalThis.crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    signatureBytes,
    message,
  );
}
const httpsServer = createHttpsServer(
  {
    key: readFileSync(process.env.RECEIVER_TLS_KEY),
    cert: readFileSync(process.env.RECEIVER_TLS_CERT),
  },
  (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const id = request.headers["webhook-id"] ?? "";
      const timestamp = request.headers["webhook-timestamp"] ?? "";
      const signature = request.headers["webhook-signature"] ?? null;
      verifyDelivery(id, timestamp, rawBody, signature).then((verified) => {
        let event = null;
        try {
          event = JSON.parse(rawBody);
        } catch {
          event = null;
        }
        received.push({ id, verified, event });
      });
      response.writeHead(204);
      response.end();
    });
  },
);
const httpServer = createHttpServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (request.method === "POST" && request.url === "/configure") {
      secret = JSON.parse(body).secret;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/received") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(received));
      return;
    }
    response.writeHead(404);
    response.end();
  });
});
httpsServer.listen(0, "127.0.0.1", () => {
  httpServer.listen(0, "127.0.0.1", () => {
    process.stdout.write(
      \`READY \${JSON.stringify({
        httpsPort: httpsServer.address().port,
        httpPort: httpServer.address().port,
      })}\\n\`,
    );
  });
});
`;
await writeFile(`${work}/receiver.mjs`, receiverScript);

const subscriptionCreated = z.object({
  subscription: z.object({ id: z.string() }),
  secret: z.string().min(1),
});
const deliveryList = z.array(
  z.object({
    id: z.string(),
    subscription: z.string(),
    type: z.string(),
    state: z.enum(["pending", "delivered", "failed"]),
    attempts: z.number(),
    lastStatus: z.number().nullable(),
    updatedAt: z.number(),
  }),
);
const keyResponse = z.object({
  key: z.object({ name: z.string() }),
  plaintext: z.string().min(1),
});

// changes.merge may answer `{kind:"merging"}` and settle in the background
// (apps/bonsai/backend/methods.ts:519 -> merge.ts:178). Never resubmit the
// merge: just read the pinned Change, bounded, until it reaches a terminal
// state for the exact head we proposed. "closed" and a head that moved off
// the one we proposed are terminal failures, not pending states to keep
// polling through.
const changeObservation = z.union([changeDetail, readCopyRebuilding]);
async function waitForMergeOutcome(number, head) {
  const observed = await until(
    () => call("changes.get", { repo: "koi-pond", number }, changeObservation),
    (detail) =>
      "change" in detail &&
      (detail.change.state === "merged" ||
        detail.change.state === "closed" ||
        detail.change.head !== head ||
        detail.change.conflict?.head === head ||
        detail.change.mergeFailure !== undefined),
    `Change #${number} to settle after its merge call`,
  );
  assert.ok("change" in observed, "Change copy never left rebuilding");
  const row = observed.change;
  assert.equal(
    row.mergeFailure,
    undefined,
    `Change #${number} merge failed: ${row.mergeFailure}`,
  );
  assert.notEqual(
    row.state,
    "closed",
    `Change #${number} closed before its proposed head ${head} could settle`,
  );
  assert.equal(
    row.head,
    head,
    row.state === "merged"
      ? `Change #${number} merged a different head than the one proposed`
      : `Change #${number} moved to a new head before ${head} could settle`,
  );
  return row.state === "merged"
    ? { kind: "merged", mergedCommit: row.mergedCommit }
    : { kind: "conflict", paths: row.conflict?.paths ?? [] };
}

function issueTicket({ id, title, blockedBy = [] }) {
  return `---
id: ${id}
title: ${JSON.stringify(title)}
type: task
status: ready-for-agent
priority: p1
created: 2026-10-14
assignee: null
areas: [testing]
blocked_by: [${blockedBy.join(", ")}]
---

# ${title}

## Outcome

The observable result.

## Context

The governing Wiki record.

## Acceptance criteria

- [ ] The result is observable.

## Verification

- [ ] Run the focused check.
`;
}

async function runProof() {
  let receiver;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      ready = await globalThis
        .fetch(`${origin}/login`, {
          signal: globalThis.AbortSignal.timeout(1_000),
        })
        .then(
          (response) => response.ok,
          () => false,
        );
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "Local Oyster did not start");
    const installed = await installRelease({
      directory: releaseDirectory,
      url: origin,
      key,
      installationId: "bonsai",
    });
    assert.equal(installed.status, 201, "Local Bonsai installation failed");

    // The receiver, as its own process (see receiverScript above), so wrangler
    // dev's real TLS delivery is never stalled by this script's own blocking
    // git/openssl calls.
    receiver = spawn(process.execPath, [`${work}/receiver.mjs`], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RECEIVER_TLS_KEY: `${tls}/receiver.key`,
        RECEIVER_TLS_CERT: `${tls}/receiver.crt`,
      },
    });
    let receiverOutput = "";
    receiver.stdout.on("data", (chunk) => {
      receiverOutput += chunk;
    });
    receiver.stderr.on("data", (chunk) => {
      receiverOutput += chunk;
    });
    const receiverReady = await new Promise((resolve, reject) => {
      const check = () => {
        const match = /READY (\{.*\})/u.exec(receiverOutput);
        if (match) resolve(JSON.parse(match[1]));
      };
      receiver.stdout.on("data", check);
      receiver.once("exit", (code) =>
        reject(new Error(`Receiver exited early (${code}): ${receiverOutput}`)),
      );
      check();
      setTimeout(
        () =>
          reject(new Error(`Receiver did not report ready: ${receiverOutput}`)),
        10_000,
      );
    });
    const receiverUrl = `https://127.0.0.1:${receiverReady.httpsPort}/webhook`;
    const controlOrigin = `http://127.0.0.1:${receiverReady.httpPort}`;

    const subscribeResponse = await globalThis.fetch(`${origin}/api/webhooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        installationId: "bonsai",
        url: receiverUrl,
        types: [],
      }),
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    const subscribeText = await subscribeResponse.text();
    assert.equal(subscribeResponse.status, 201, subscribeText);
    const subscribed = subscriptionCreated.parse(JSON.parse(subscribeText));
    const subscriptionId = subscribed.subscription.id;
    const configured = await globalThis.fetch(`${controlOrigin}/configure`, {
      method: "POST",
      body: JSON.stringify({ secret: subscribed.secret }),
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    assert.equal(configured.status, 204);

    // A canonical repository with a real base push: git.push.
    await call(
      "repos.create",
      { name: "koi-pond", description: "Webhook and issues proof pond" },
      repoSummary,
    );
    const base = `${work}/base`;
    await mkdir(`${base}/src`, { recursive: true });
    await writeFile(
      `${base}/src/pond.ts`,
      'export const pondColor = "#0b3d4f";\n',
    );
    await writeFile(`${base}/README.md`, "# Koi pond\n");
    git(base, ["init", "-q", "-b", "main"]);
    git(base, ["add", "."]);
    git(base, [
      "-c",
      "user.name=owner",
      "-c",
      "user.email=owner@bonsai.local",
      "commit",
      "-qm",
      "Start the koi pond canvas game",
    ]);
    await gitPush(base, gitUrl("koi-pond"), "main", key);

    // Issues as files: 01 and 03 (blocked_by 01), pushed straight to main.
    await mkdir(`${base}/issues/webhook-proof`, { recursive: true });
    await writeFile(
      `${base}/issues/webhook-proof/01-first-ticket.md`,
      issueTicket({
        id: "webhook-proof-01",
        title: "First ticket, the blocker",
      }),
    );
    await writeFile(
      `${base}/issues/webhook-proof/03-second-ticket.md`,
      issueTicket({
        id: "webhook-proof-03",
        title: "Second ticket, blocked on the first",
        blockedBy: ["webhook-proof-01"],
      }),
    );
    git(base, ["add", "issues"]);
    git(base, [
      "-c",
      "user.name=owner",
      "-c",
      "user.email=owner@bonsai.local",
      "commit",
      "-qm",
      "Track the webhook proof issues",
    ]);
    await gitPush(base, gitUrl("koi-pond"), "main", key);
    const baseHead = git(base, ["rev-parse", "HEAD"]);

    await until(
      () => call("repos.get", { repo: "koi-pond" }, repoDetail),
      (value) =>
        value.refs.some(
          (ref) => ref.name === "refs/heads/main" && ref.hash === baseHead,
        ),
      "base and issues push to land on main",
    );

    // An agent key forks the repository: git.fork.
    const created = keyResponse.parse(
      await (
        await globalThis.fetch(`${origin}/api/keys`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "morel",
            grants: [{ capability: "apps.use", targets: { kind: "all" } }],
          }),
          signal: globalThis.AbortSignal.timeout(30_000),
        })
      ).json(),
    );
    const morelKey = created.plaintext;
    await call("repos.fork", { repo: "koi-pond" }, repoSummary, morelKey);

    // A topic branch the owner merges cleanly: change.merged.
    git(base, ["checkout", "-q", "-b", "topic"]);
    await writeFile(
      `${base}/src/pond.ts`,
      'export const pondColor = "#164e63";\n',
    );
    git(base, ["add", "src/pond.ts"]);
    git(base, [
      "-c",
      "user.name=owner",
      "-c",
      "user.email=owner@bonsai.local",
      "commit",
      "-qm",
      "Brighten the pond for the topic branch",
    ]);
    await gitPush(base, gitUrl("koi-pond"), "topic", key);
    const topicHead = git(base, ["rev-parse", "HEAD"]);
    const topicChange = await call(
      "changes.open",
      { repo: "koi-pond", sourceRef: "topic", title: "Brighten the pond" },
      changeRecord,
    );
    const topicMerge = await call(
      "changes.merge",
      { repo: "koi-pond", number: topicChange.number, head: topicHead },
      mergeResult,
    );
    assert.ok(
      ["merging", "merged", "conflict"].includes(topicMerge.kind),
      `Unexpected immediate merge answer: ${topicMerge.kind}`,
    );
    const topicOutcome = await waitForMergeOutcome(
      topicChange.number,
      topicHead,
    );
    assert.equal(topicOutcome.kind, "merged", "Owner self-merge must succeed");

    // A rival branch off the same pre-topic base, touching the same line:
    // change.conflicted.
    git(base, ["checkout", "-q", baseHead]);
    git(base, ["checkout", "-q", "-b", "rival"]);
    await writeFile(
      `${base}/src/pond.ts`,
      'export const pondColor = "#272640";\n',
    );
    git(base, ["add", "src/pond.ts"]);
    git(base, [
      "-c",
      "user.name=owner",
      "-c",
      "user.email=owner@bonsai.local",
      "commit",
      "-qm",
      "Try a twilight pond on the rival branch",
    ]);
    await gitPush(base, gitUrl("koi-pond"), "rival", key);
    const rivalHead = git(base, ["rev-parse", "HEAD"]);
    const rivalChange = await call(
      "changes.open",
      { repo: "koi-pond", sourceRef: "rival", title: "Twilight pond" },
      changeRecord,
    );
    const rivalMerge = await call(
      "changes.merge",
      { repo: "koi-pond", number: rivalChange.number, head: rivalHead },
      mergeResult,
    );
    assert.ok(
      ["merging", "merged", "conflict"].includes(rivalMerge.kind),
      `Unexpected immediate merge answer: ${rivalMerge.kind}`,
    );
    const rivalOutcome = await waitForMergeOutcome(
      rivalChange.number,
      rivalHead,
    );
    assert.equal(
      rivalOutcome.kind,
      "conflict",
      "Rival must conflict with the already-merged topic branch",
    );
    assert.deepEqual(rivalOutcome.paths, ["src/pond.ts"]);

    // The receiver really got each event type, each HMAC-verified.
    const requiredTypes = [
      "git.push",
      "git.fork",
      "change.merged",
      "change.conflicted",
    ];
    const readReceived = async () => {
      const response = await globalThis.fetch(`${controlOrigin}/received`, {
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const received = await until(
      readReceived,
      (deliveries) =>
        requiredTypes.every((type) =>
          deliveries.some(
            (delivery) => delivery.event?.type === type && delivery.verified,
          ),
        ),
      "every required webhook type to arrive and verify",
    );
    for (const type of requiredTypes) {
      const delivery = received.find((item) => item.event?.type === type);
      assert.ok(delivery, `No delivery of type ${type}`);
      assert.equal(delivery.verified, true, `${type} did not verify its HMAC`);
      const decoded = hookEvent.parse(delivery.event);
      assert.equal(decoded.data.spec, "bonsai.event/v1");
    }

    // /deliveries lists them, as the owner.
    const deliveries = await until(
      async () =>
        deliveryList.parse(
          await (
            await globalThis.fetch(
              `${origin}/api/webhooks/${subscriptionId}/deliveries`,
              {
                headers: { Authorization: `Bearer ${key}` },
                signal: globalThis.AbortSignal.timeout(30_000),
              },
            )
          ).json(),
        ),
      (list) =>
        requiredTypes.every((type) =>
          list.some(
            (delivery) =>
              delivery.type === type && delivery.state === "delivered",
          ),
        ),
      "/deliveries to show every required type delivered",
    );
    for (const type of requiredTypes)
      assert.ok(
        deliveries.some(
          (delivery) =>
            delivery.type === type && delivery.state === "delivered",
        ),
        `/deliveries must list a delivered ${type}`,
      );

    // issues.read returns both files, 01 before 03.
    const files = await call(
      "issues.read",
      { repo: "koi-pond", ref: "main" },
      issueFiles,
    );
    const paths = Object.keys(files.files);
    assert.deepEqual(
      paths,
      ["webhook-proof/01-first-ticket.md", "webhook-proof/03-second-ticket.md"],
      "issues.read must return 01 before 03",
    );
    assert.ok(
      files.files["webhook-proof/01-first-ticket.md"].includes(
        "id: webhook-proof-01",
      ),
    );
    assert.ok(
      files.files["webhook-proof/03-second-ticket.md"].includes(
        "blocked_by: [webhook-proof-01]",
      ),
    );

    log(
      "PASS webhooks and issues: subscribed, git.push/git.fork/change.merged/change.conflicted each HMAC-verified by the receiver with Web Crypto, /deliveries lists them, issues.read returns 01 before 03.",
    );
    return { ok: true };
  } catch (cause) {
    await writeFile(
      `${work}/worker.log`,
      output.split(key).join("[redacted]"),
      { mode: 0o600 },
    );
    error(
      `Webhooks/issues proof failed: ${cause instanceof Error ? cause.message.split(key).join("[redacted]") : "unknown failure"}. Receipt: ${work}`,
    );
    return { ok: false };
  } finally {
    receiver?.kill("SIGTERM");
    worker.kill("SIGTERM");
    await stopped;
    await provider.close();
  }
}
const result = await runProof();
if (!result.ok) process.exitCode = 1;
