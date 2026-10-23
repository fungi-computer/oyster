import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { extname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { build as viteBuild } from "vite";
import { reportBootPage } from "../dist/boot-capability.js";
import { serveBootCapability } from "../dist/boot-capability-route.js";
import { browserRunSessions } from "../dist/browser/index.js";
import { checkBootPage } from "../dist/browser/boot.js";

/**
 * The host UI boot check end to end in actual Chromium: reportBootPage
 * issues a capability, checkBootPage drives a real browser over CDP to the
 * pinned /_boot/ page served by Oyster's capability route, the candidate's
 * verified bytes stream from the bucket, and the lease is revoked. The
 * provider is a local Chromium behind Browser Run's session API shape.
 */

const scratch = await mkdtemp(join(tmpdir(), "oyster-boot-page-"));
const keyPath = join(scratch, "key.pem");
const certificatePath = join(scratch, "certificate.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
  ],
  { stdio: "ignore" },
);
const credentials = {
  key: await readFile(keyPath),
  cert: await readFile(certificatePath),
};
const processes = new Set();
after(async () => {
  for (const child of processes) child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
});

const identity = {
  appId: "app_boot_page",
  releaseId: "rel_bootpage01",
  surfaceId: "host-boot",
};

/** A local Chromium per session, behind Browser Run's devtools REST shape. */
function localSessions() {
  const sessions = new Map();
  let next = 0;
  const fetch = async (url, init = {}) => {
    const parts = new globalThis.URL(url).pathname.split("/");
    const method = init.method ?? "GET";
    if (method === "POST" && parts.at(-1) === "browser") {
      next += 1;
      const id = `local-${String(next)}`;
      // A fresh profile per session: a reused one holds a stale devtools port.
      const profile = await mkdtemp(join(scratch, "profile-"));
      const child = spawn(
        chromium.executablePath(),
        [
          "--headless=new",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "--ignore-certificate-errors",
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      processes.add(child);
      const exited = once(child, "exit").then(() => processes.delete(child));
      // Chromium writes its devtools port and browser path once listening.
      const portFile = join(profile, "DevToolsActivePort");
      let active = "";
      for (
        let attempt = 0;
        attempt < 400 && !/^\d+\n\/devtools\//u.test(active);
        attempt += 1
      ) {
        if (existsSync(portFile)) active = await readFile(portFile, "utf8");
        await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      }
      assert.match(active, /^\d+\n\/devtools\//u, "no devtools port");
      const [port, path] = active.trim().split("\n");
      sessions.set(id, {
        child,
        exited,
        ended: false,
        ws: `ws://127.0.0.1:${port}${path}`,
      });
      return globalThis.Response.json({ sessionId: id });
    }
    const id = decodeURIComponent(parts.at(-1) ?? "");
    const session = sessions.get(id);
    if (session === undefined)
      return new globalThis.Response(null, { status: 404 });
    if (method === "DELETE") {
      session.child.kill("SIGTERM");
      await session.exited;
      session.ended = true;
      return globalThis.Response.json({ status: "closed" });
    }
    return globalThis.Response.json(
      session.ended
        ? { sessionId: id, endTime: Date.now() }
        : { sessionId: id },
    );
  };
  const connect = async (url) => {
    const id = decodeURIComponent(
      new globalThis.URL(url).pathname.split("/").at(-1) ?? "",
    );
    const session = sessions.get(id);
    assert.ok(session);
    const socket = new globalThis.WebSocket(session.ws);
    await once(socket, "open");
    return socket;
  };
  return {
    sessions: browserRunSessions({
      accountId: "local",
      apiToken: "local",
      fetch,
      connect,
    }),
    live: () => [...sessions.values()].filter((session) => !session.ended),
  };
}

/** Oyster's capability route on a local https origin over an in-memory bucket. */
async function startRoute(assets) {
  const leases = new Map();
  const revoked = [];
  const capabilities = {
    issue: async ({ lease, tokenDigest }) => {
      leases.set(tokenDigest, lease);
    },
    resolve: async (digest) => leases.get(digest) ?? null,
    revoke: async (id) => {
      revoked.push(id);
      for (const [digest, lease] of leases)
        if (lease.id === id) leases.delete(digest);
    },
  };
  const find = (reference) =>
    assets.find((candidate) => candidate.artifactRef === reference);
  const bucket = {
    head: async (reference) => {
      const asset = find(reference);
      return asset === undefined
        ? null
        : { size: asset.storedBytes.byteLength };
    },
    get: async (reference) => {
      const asset = find(reference);
      if (asset === undefined || asset.missing === true) return null;
      return {
        size: asset.storedBytes.byteLength,
        body: new globalThis.Blob([asset.storedBytes]).stream(),
      };
    },
  };
  const requests = [];
  const server = createServer(credentials, async (incoming, outgoing) => {
    requests.push({ url: incoming.url, headers: incoming.headers });
    const origin = `https://127.0.0.1:${String(server.address().port)}`;
    const response = await serveBootCapability(
      new globalThis.Request(origin + incoming.url, {
        method: incoming.method,
        headers: incoming.headers,
      }),
      { configuredOrigin: origin, bucket, capabilities },
    );
    if (response === null) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      outgoing.end();
      return;
    }
    // A failed verification ends the response without its EOF.
    Readable.fromWeb(response.body)
      .on("error", (cause) => outgoing.destroy(cause))
      .pipe(outgoing);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `https://127.0.0.1:${String(server.address().port)}`,
    bucket,
    capabilities,
    requests,
    revoked,
    leases,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function buildOrdinaryViteCandidate() {
  const source = await mkdtemp(join(scratch, "vite-source-"));
  const output = join(source, "dist");
  await writeFile(
    join(source, "index.html"),
    '<!doctype html><html><body><main id="boot"></main><script type="module" src="./main.ts"></script></body></html>',
  );
  await writeFile(
    join(source, "main.ts"),
    'import "./style.css";\nconst boot = document.querySelector("#boot");\nif (!(boot instanceof HTMLElement)) throw new Error("boot fixture missing");\nboot.textContent = "module executed";\n',
  );
  await writeFile(
    join(source, "style.css"),
    '@font-face { font-family: "BootFixture"; src: url("./fixture.woff2") format("woff2"); font-display: block; }\n#boot { font-family: "BootFixture", sans-serif; font-size: 24px; }\n',
  );
  await writeFile(
    join(source, "fixture.woff2"),
    await readFile(
      new globalThis.URL(
        "../../stipe/fonts/InstrumentSans-VF-latin.woff2",
        import.meta.url,
      ),
    ),
  );
  await viteBuild({
    root: source,
    configFile: false,
    base: "./",
    logLevel: "silent",
    build: { outDir: output, emptyOutDir: true, assetsInlineLimit: 0 },
  });
  const files = [];
  const pending = [output];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else files.push(path);
    }
  }
  const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".woff2", "font/woff2"],
  ]);
  return Promise.all(
    files.map(async (file, index) => {
      const bytes = await readFile(file);
      const contentType = contentTypes.get(extname(file));
      assert.ok(contentType, `unhandled Vite asset ${extname(file)}`);
      return {
        path: `/${relative(output, file).split("\\").join("/")}`,
        contentType,
        artifactRef: `artifact:boot-page-${String(index)}`,
        bytes,
        storedBytes: bytes,
      };
    }),
  );
}

const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function check(assets) {
  const provider = localSessions();
  const route = await startRoute(assets);
  try {
    const outcome = await reportBootPage({
      origin: route.origin,
      check: (target) => checkBootPage(provider.sessions, target),
      readUi: async () => ({
        identity,
        base: "./",
        assets: assets.map(({ path, contentType, artifactRef, bytes }) => ({
          path,
          contentType,
          artifactRef,
          digest: sha256(bytes),
        })),
      }),
      bucket: route.bucket,
      capabilities: route.capabilities,
      now: Date.now,
    });
    return { outcome, route, live: provider.live() };
  } finally {
    await route.close();
  }
}

test("actual Chromium mounts an ordinary Vite module, CSS and font through the capability route", async () => {
  const { outcome, route, live } = await check(
    await buildOrdinaryViteCandidate(),
  );
  assert.deepEqual(outcome, { kind: "passed" });
  // Every request stayed under the pinned prefix; no URL carried the token.
  assert.ok(route.requests.length > 0);
  for (const request of route.requests) {
    assert.ok(request.url.startsWith(`/_boot/${identity.releaseId}/`));
    // Every request under the release path carried the capability header.
    const [token] = [request.headers["x-oyster-boot-capability"]].flat();
    assert.ok(token, `${request.url} carried no capability`);
    assert.ok(!request.url.includes(token));
  }
  assert.ok(
    route.requests.some((request) => request.url.endsWith(".woff2")),
    "the font was requested",
  );
  // The lease is revoked and the provider session is closed.
  assert.equal(route.revoked.length, 1);
  assert.equal(route.leases.size, 0);
  assert.deepEqual(live, []);
});

test("actual Chromium reports a throwing candidate module as a sanitized mount failure", async () => {
  const assets = await buildOrdinaryViteCandidate();
  const failing = assets.map((asset) => {
    if (!asset.path.endsWith(".js")) return asset;
    const bytes = new globalThis.TextEncoder().encode(
      'console.error("Candidate report https://attacker.invalid/path?token=hidden");\nthrow new Error("\\u001b[31mCandidate exploded https://attacker.invalid/path?query=secret\\u001b[0m");\n',
    );
    return { ...asset, bytes, storedBytes: bytes };
  });
  const { outcome, live } = await check(failing);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.code, "ui_mount_failed");
  assert.equal(outcome.diagnostics?.failedPredicate, "page_error");
  for (const message of [
    ...(outcome.diagnostics?.consoleErrors ?? []),
    ...(outcome.diagnostics?.pageErrors ?? []),
  ]) {
    assert.doesNotMatch(message, /attacker\.invalid|hidden|secret/u);
    assert.ok(!message.includes("\u001b"));
  }
  assert.deepEqual(live, []);
});

test("actual Chromium refuses same-length tampered bytes", async () => {
  const html = new globalThis.TextEncoder().encode(
    "<!doctype html><body>verified candidate</body>",
  );
  const tampered = new globalThis.TextEncoder().encode(
    "<!doctype html><body>tampered candidate</body>",
  );
  assert.equal(tampered.byteLength, html.byteLength);
  const { outcome } = await check([
    {
      path: "/index.html",
      contentType: "text/html; charset=utf-8",
      artifactRef: "artifact:boot-page-html",
      bytes: html,
      storedBytes: tampered,
    },
  ]);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.code, "ui_mount_failed");
});

test("actual Chromium refuses a capability whose authorized object is missing", async () => {
  const html = new globalThis.TextEncoder().encode(
    "<!doctype html><body>never served</body>",
  );
  const { outcome } = await check([
    {
      path: "/index.html",
      contentType: "text/html; charset=utf-8",
      artifactRef: "artifact:boot-page-missing",
      bytes: html,
      storedBytes: html,
      missing: true,
    },
  ]);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.code, "ui_mount_failed");
});
