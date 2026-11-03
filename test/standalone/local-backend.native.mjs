// Native proof: a folder attached to a standalone Oyster's Computer as an
// execution backend, end to end through the production StandaloneRegistry,
// ComputerDO and owner MCP on workerd, the `fungi computer` owners (attach,
// run, detach) and the real computerd daemon on this machine.
//
//  1. Attach by the CLI owners with the owner key: the device key and the
//     absolute folder path stay in Local's credential file; the Oyster keeps
//     only the public key and two labels.
//  2. A folder file reaches the Computer; a Computer write reaches the folder;
//     a command routed to the machine runs there, in the folder.
//  3. Offline: an explicit backend fails (no silent fallback), the Computer's
//     own files keep working, and the Computer wins every path changed or
//     deleted on both sides when the machine reconnects. The daemon restarts
//     between connections, so deletions survive its restart.
//  4. Detach closes the live socket and the host rejects a signed redial.
//
// Run: node test/standalone/local-backend.native.mjs
import { nativeMcpConnector } from "../native-mcp-client.fixture.mjs";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { randomBytes } from "node:crypto";
import { createServer as createTlsServer } from "node:https";
import { createRequire } from "node:module";
import tls from "node:tls";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { ProtocolError } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  attachPrivateLocalComputer,
  detachPrivateLocalComputer,
  listPrivateLocalComputers,
  runPrivateLocalComputer,
} from "../../../../runtimes/local/dist/private-local-computer-attach.js";
import { saveOysterMcpKey } from "../../../../runtimes/local/dist/private-oyster-mcp-auth.js";
import { createPrivateCredentialStore } from "../../../../runtimes/local/dist/private-file-credential-store.js";
import {
  importSeamSigner,
  seamHeader,
  signSeamRequest,
  unsignedPayload,
} from "@fungi.computer/seam";

// Reuse the dev platform's maintained HTTP/WebSocket proxy.
const { createProxyMiddleware } = createRequire(
  new URL("../../../../tooling/celld-platform/package.json", import.meta.url),
)("http-proxy-middleware");

/* global fetch, AbortController */

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(join(root, ".botanical"), { recursive: true });
const work = await mkdtemp(join(root, ".botanical/local-backend-"));
const folder = await realpath(
  await mkdtemp(join(tmpdir(), "fungi-oyster-local-backend-")),
);
const credentialPath = join(work, "credentials.json");
const key = randomBytes(24).toString("hex");
const freePort = async () => {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(socket.address());
  await new Promise((resolve) => socket.close(resolve));
  return port;
};
// Registry tenant origins require HTTPS, and a machine's dial signature covers
// the exact public URL. A certificate-verifying edge supplies the authority
// the Worker and Local both see; Local trusts only this run's certificate.
const port = await freePort();
const edgePort = await freePort();
const origin = `https://127.0.0.1:${edgePort}`;
const endpoint = `${origin}/mcp`;
// The owner's own tools reach the Worker directly, so taking the machine's
// network away (the edge) never cuts the owner off.
const direct = `http://127.0.0.1:${port}`;
const keyPath = join(work, "edge-key.pem");
const certPath = join(work, "edge-cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ],
  { stdio: "ignore" },
);
tls.setDefaultCACertificates([
  ...tls.getCACertificates("default"),
  await readFile(certPath, "utf8"),
]);
const classes = [
  "OysterMcp",
  "OysterRegistry",
  "StandaloneInstance",
  "AgentDirectory",
  "StandaloneTenants",
  "OysterKeys",
  "ComputerDO",
];
const bindings = [
  "MCP",
  "REGISTRY",
  "INSTANCES",
  "AGENT_DIRECTORY",
  "TENANTS",
  "KEYS",
  "COMPUTER",
];
await writeFile(
  join(work, "wrangler.json"),
  JSON.stringify({
    name: "oyster-local-backend-proof",
    main: join(root, "test/standalone/mcp-fleet.native.fixture.ts"),
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      OYSTER_OWNER_KEY: key,
      OYSTER_ORIGIN: origin,
      OYSTER_COMPUTER_ID: "workspace",
    },
    worker_loaders: [{ binding: "LOADER" }],
    r2_buckets: [{ binding: "RELEASES", bucket_name: "local-backend-proof" }],
    durable_objects: {
      bindings: classes.map((class_name, index) => ({
        name: bindings[index],
        class_name,
      })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: classes }],
  }),
);

let output = "";
const child = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    join(work, "wrangler.json"),
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    join(work, "state"),
    "--local-upstream",
    `127.0.0.1:${edgePort}`,
    "--upstream-protocol",
    "https",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => child.once("exit", resolve));
const statuses = [];
let edge;
const edgeSockets = new Set();
let owner;
let running;

async function until(label, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ownerFetch = (path, init = {}) =>
  fetch(`${direct}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });

/** One owner MCP execute call; the returned value is the code's JSON result. */
async function execute(code) {
  const result = await owner.execute(code);
  assert.notEqual(result.isError, true, result.text);
  return JSON.parse(
    z.object({ text: z.string() }).parse(result.content[0]).text,
  );
}

function start() {
  const controller = new AbortController();
  const done = runPrivateLocalComputer(endpoint, "Folder", {
    credentialPath,
    signal: controller.signal,
    onStatus: (status) => statuses.push(status.kind),
  });
  return { controller, done };
}

try {
  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${port}`,
    on: {
      // Dropping the network must also end the tunnel to the Worker.
      proxyReqWs: (forwarded) => {
        forwarded.once("upgrade", (_response, upstream) => {
          edgeSockets.add(upstream);
          upstream.once("close", () => edgeSockets.delete(upstream));
        });
      },
    },
  });
  const tlsOptions = {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  };
  /** Take the machine's network away (false) or give it back (true). */
  const listen = async (up) => {
    if (up) {
      edge = createTlsServer(tlsOptions, proxy);
      edge.on("upgrade", proxy.upgrade);
      // Upgraded WebSockets leave the HTTP server's own connection tracking.
      edge.on("connection", (connection) => {
        edgeSockets.add(connection);
        connection.once("close", () => edgeSockets.delete(connection));
      });
      await new Promise((resolve, reject) => {
        edge.once("error", reject);
        edge.listen(edgePort, "127.0.0.1", resolve);
      });
      return;
    }
    const closed = new Promise((resolve) => edge.close(resolve));
    for (const connection of edgeSockets) connection.destroy();
    await closed;
    edge = undefined;
  };
  await listen(true);
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${direct}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (child.exitCode !== null || attempt >= 240)
      throw new Error(
        `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
      );
    await delay(250);
  }

  // The owner creates and selects the Computer through the ordinary controls.
  const created = await ownerFetch("/api/computers", {
    method: "POST",
    body: JSON.stringify({ name: "Folder", requestId: "folder-proof" }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { computerId } = z
    .object({ computerId: z.string() })
    .parse(await created.json());
  const selected = await ownerFetch("/api/computers/selected", {
    method: "PUT",
    body: JSON.stringify({ computerId }),
  });
  assert.equal(selected.status, 200, await selected.clone().text());
  owner = await nativeMcpConnector({
    origin: direct,
    name: "Oyster local backend",
  })(key);
  const backends = async () =>
    (
      await execute(
        `return await env.computers.backends({computerId:${JSON.stringify(computerId)}})`,
      )
    ).backends;
  const bash = (command, backend) =>
    owner.execute(
      `return await env.computers.workspace.exec(${JSON.stringify({
        command,
        cwd: "/workspace",
        timeoutMs: 60_000,
        backend,
      })})`,
    );
  /** An explicitly named backend that is not available fails the call. */
  const refusedExec = async (command, backend) => {
    const seen = output.split("ComputerBackendUnavailableError").length;
    await assert.rejects(bash(command, backend), /MCP tool call failed/u);
    await until(
      "the Computer to name the unavailable backend",
      () => output.split("ComputerBackendUnavailableError").length > seen,
    );
  };
  const readComputer = async (path) => {
    let result;
    try {
      result = await owner.execute(
        `return await env.computers.workspace.read(${JSON.stringify({ path })})`,
      );
    } catch (error) {
      // A path the Computer does not hold fails the tool call; anything else is real.
      if (error instanceof ProtocolError) return undefined;
      throw error;
    }
    if (result.isError === true) return undefined;
    const parsed = JSON.parse(
      z.object({ text: z.string() }).parse(result.content[0]).text,
    );
    return z.object({ content: z.string() }).safeParse(parsed).data?.content;
  };
  const writeComputer = (path, content) =>
    execute(
      `return await env.computers.workspace.write(${JSON.stringify({ path, content })})`,
    );
  const removeComputer = (path) =>
    execute(
      `return await env.computers.workspace.exec(${JSON.stringify({
        command: `rm -f ${path}`,
        cwd: "/workspace",
        timeoutMs: 60_000,
      })})`,
    );
  const inFolder = async (name) =>
    stat(join(folder, name)).then(
      () => true,
      () => false,
    );
  const folderText = (name) => readFile(join(folder, name), "utf8");

  // 1. Attach with the saved owner key; only the public half leaves.
  await writeFile(join(folder, "hello.txt"), "from the folder v1\n");
  await saveOysterMcpKey(new URL(endpoint), Readable.from([Buffer.from(key)]), {
    credentialPath,
  });
  const attached = await attachPrivateLocalComputer(
    endpoint,
    { computer: "Folder", folderPath: folder, hostLabel: "proof-laptop" },
    { credentialPath },
  );
  assert.equal(attached.kind, "attached", JSON.stringify(attached));
  assert.equal(attached.computerId, computerId);
  assert.equal(attached.rootPath, folder);
  const { backendId } = attached;
  assert.match(backendId, /^local-[a-z2-7]{16}$/);
  assert.deepEqual(
    await attachPrivateLocalComputer(
      endpoint,
      { computer: "Folder", folderPath: folder },
      { credentialPath },
    ),
    attached,
    "re-running attach returns the same attachment",
  );
  assert.deepEqual(await listPrivateLocalComputers({ credentialPath }), [
    {
      teamId: null,
      origin,
      computerId,
      computerName: "Folder",
      rootPath: folder,
      backendId,
    },
  ]);
  const record = (
    await createPrivateCredentialStore(credentialPath).readLocalBackends(origin)
  )[0];
  assert.ok(record, "Local keeps the attachment record");
  const attachedView = (await backends()).find(({ id }) => id === backendId);
  assert.deepEqual(attachedView, {
    id: backendId,
    kind: "local",
    status: "offline",
    queuePosition: null,
    hostId: null,
    hostLabel: "proof-laptop",
    folderLabel: record.folderLabel,
    detachable: true,
  });

  running = start();
  await until(
    "the machine to come online",
    async () =>
      (await backends()).find(({ id }) => id === backendId)?.status ===
      "online",
  );

  // 2. Two directions, and a command that runs here, in the folder.
  assert.equal(
    await until("hello.txt in the Computer", () =>
      readComputer("/workspace/hello.txt"),
    ),
    "from the folder v1\n",
  );
  const ran = JSON.parse(
    z
      .object({ text: z.string() })
      .parse(
        (
          await bash(
            "printf 'by the agent\\n' > agent.txt; hostname; pwd",
            backendId,
          )
        ).content[0],
      ).text,
  );
  assert.equal(ran.status, "succeeded", JSON.stringify(ran));
  const [ranOn, ranIn] = ran.output.stdout.trim().split("\n");
  assert.equal(ranOn, hostname(), "the command ran on this machine");
  assert.equal(ranIn, folder, "the command ran in the attached folder");
  assert.equal(await folderText("agent.txt"), "by the agent\n");
  assert.equal(await readComputer("/workspace/agent.txt"), "by the agent\n");
  await writeComputer("/workspace/from-computer.txt", "written in SQLite\n");
  await writeFile(join(folder, "hello.txt"), "from the folder v2\n");
  const synced = await bash("cat from-computer.txt", backendId);
  assert.match(synced.text, /written in SQLite/u);
  assert.equal(await folderText("from-computer.txt"), "written in SQLite\n");
  assert.equal(
    await readComputer("/workspace/hello.txt"),
    "from the folder v2\n",
  );

  // 3. The network drops (the daemon and Local keep running). Files both
  // sides hold before the machine goes away.
  const syncBoth = async (names) => {
    for (const name of names)
      await writeComputer(`/workspace/${name}`, "base\n");
    assert.match((await bash("true", backendId)).text, /succeeded/u);
    for (const name of names) assert.equal(await folderText(name), "base\n");
  };
  await syncBoth(["conflict.txt", "doomed.txt", "both-deleted.txt"]);
  await listen(false);
  await until(
    "the machine to go offline",
    async () =>
      (await backends()).find(({ id }) => id === backendId)?.status ===
      "offline",
  );
  await refusedExec("touch ran-offline.txt", backendId);
  assert.equal(
    await inFolder("ran-offline.txt"),
    false,
    "an explicit offline backend fails without falling back",
  );
  await writeComputer("/workspace/while-offline.txt", "while away\n");
  assert.equal(
    await readComputer("/workspace/while-offline.txt"),
    "while away\n",
    "the Computer's own files keep working",
  );
  await writeFile(join(folder, "hello.txt"), "from the folder v3\n");
  await writeComputer("/workspace/conflict.txt", "computer\n");
  await writeFile(join(folder, "conflict.txt"), "folder\n");
  await removeComputer("/workspace/doomed.txt");
  await writeFile(join(folder, "doomed.txt"), "folder edit\n");
  await removeComputer("/workspace/both-deleted.txt");
  await rm(join(folder, "both-deleted.txt"));
  // Let the daemon's shim fold the folder edits into its store first.
  await delay(1_000);
  await listen(true);
  assert.equal(
    await until("while-offline.txt in the folder", async () =>
      (await inFolder("while-offline.txt"))
        ? await folderText("while-offline.txt")
        : false,
    ),
    "while away\n",
  );
  assert.equal(
    await until("hello v3 in the Computer", async () => {
      const content = await readComputer("/workspace/hello.txt");
      return content === "from the folder v3\n" && content;
    }),
    "from the folder v3\n",
  );
  assert.equal(
    await until("conflict.txt to take the Computer's version", async () =>
      (await folderText("conflict.txt")) === "computer\n" ? "ok" : false,
    ),
    "ok",
  );
  assert.equal(await readComputer("/workspace/conflict.txt"), "computer\n");
  await until(
    "doomed.txt to leave the folder",
    async () => !(await inFolder("doomed.txt")),
  );
  assert.equal(await readComputer("/workspace/doomed.txt"), undefined);
  assert.equal(await inFolder("both-deleted.txt"), false);
  assert.equal(await readComputer("/workspace/both-deleted.txt"), undefined);

  // Apart again, and the daemon restarts: its fresh store starts from the
  // folder alone, yet the Computer's deletions and edits still win.
  await syncBoth(["restart-doomed.txt", "restart-conflict.txt"]);
  running.controller.abort();
  assert.equal(await running.done, "stopped");
  await until(
    "the machine to go offline",
    async () =>
      (await backends()).find(({ id }) => id === backendId)?.status ===
      "offline",
  );
  await removeComputer("/workspace/restart-doomed.txt");
  await writeComputer("/workspace/restart-conflict.txt", "computer\n");
  await writeFile(join(folder, "restart-conflict.txt"), "folder\n");
  await writeFile(join(folder, "local-new.txt"), "made while apart\n");
  running = start();
  await until(
    "restart-doomed.txt to leave the folder",
    async () => !(await inFolder("restart-doomed.txt")),
  );
  assert.equal(await readComputer("/workspace/restart-doomed.txt"), undefined);
  assert.equal(
    await until(
      "restart-conflict.txt to take the Computer's version",
      async () =>
        (await folderText("restart-conflict.txt")) === "computer\n"
          ? "ok"
          : false,
    ),
    "ok",
  );
  assert.equal(
    await readComputer("/workspace/restart-conflict.txt"),
    "computer\n",
  );
  assert.equal(
    await until("local-new.txt in the Computer", () =>
      readComputer("/workspace/local-new.txt"),
    ),
    "made while apart\n",
  );

  // The host never holds the device's private key, nor does it list the
  // folder's absolute path. (A command's own output, like pwd, is the
  // Computer's data and may name it.)
  assert.equal(JSON.stringify(await backends()).includes(folder), false);
  const needles = [Buffer.from(record.privateKey)];
  const scan = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else {
        const bytes = await readFile(path);
        for (const needle of needles)
          assert.equal(
            bytes.includes(needle),
            false,
            `${path} must not hold the device's private key`,
          );
      }
    }
  };
  await scan(join(work, "state"));

  // 4. Detach through the CLI owner: Local stops, the socket closes, and the
  // host rejects the device's signed redial.
  const signer = await importSeamSigner(
    `${backendId.slice("local-".length)}:${record.privateKey}`,
  );
  const dial = new URL(
    `/api/computers/${encodeURIComponent(computerId)}/backends/${backendId}/connect`,
    origin,
  );
  const signedDial = async () =>
    fetch(dial, {
      headers: {
        [seamHeader]: await signSeamRequest(
          signer,
          `fungi-local-backend:${computerId}:${backendId}`,
          "GET",
          dial.href,
          unsignedPayload,
        ),
      },
    });
  assert.equal(
    (await signedDial()).status,
    426,
    "while attached, a signed plain request is told to upgrade",
  );
  const detached = await detachPrivateLocalComputer(endpoint, "Folder", {
    credentialPath,
  });
  assert.deepEqual(detached, { kind: "detached" });
  assert.equal(await running.done, "detached");
  assert.deepEqual(await listPrivateLocalComputers({ credentialPath }), []);
  assert.equal(
    (await backends()).some(({ id }) => id === backendId),
    false,
  );
  assert.equal(
    (await signedDial()).status,
    404,
    "a detached device's signed redial is rejected",
  );
  await refusedExec("true", backendId);
  assert.deepEqual(
    await detachPrivateLocalComputer(endpoint, "Folder", { credentialPath }),
    { kind: "not-attached" },
  );
  console.log(
    JSON.stringify({
      proof: "oyster-local-backend",
      verdict: "pass",
      statuses: [...new Set(statuses)],
    }),
  );
} catch (error) {
  // Let the Worker's own log lines for the failing request reach the buffer.
  await delay(1_000);
  console.error(output.replaceAll(key, "[redacted]"));
  throw error;
} finally {
  running?.controller.abort();
  await running?.done;
  await owner?.close();
  child.kill("SIGTERM");
  await stopped;
  for (const connection of edgeSockets) connection.destroy();
  edge?.close();
  await rm(work, { recursive: true, force: true });
  await rm(folder, { recursive: true, force: true });
}
