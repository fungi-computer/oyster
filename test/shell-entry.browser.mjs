import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { URL } from "node:url";
import { chromium } from "playwright";
import { homePageFixture } from "./home-page.fixture.mjs";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { standaloneComputerFleetRoutes } from "../src/standalone/computer-fleet.ts";

// The page imports this host-owned entry; the Release's own module stays at
// its UI path, where released Oyster 0.2.0 served it immutable.
const entryPath = "/ui-entry/desktop/rel_desktop/shell.js";
const releaseModulePath = "/ui/desktop/rel_desktop/shell.js";
// A same-origin script that only reports it ran, in a Worker or Service Worker.
const probeWorkerPath = "/probe-worker.js";
const shellCode = `
  document.documentElement.dataset.shellImported = "yes";
  export const mountShell = async (root) => {
    const marker = document.createElement("h1");
    marker.id = "shell-probe-mounted";
    marker.textContent = "Approved shell loaded";
    root.appendChild(marker);
    return () => marker.remove();
  };
`;

/** A real HTTP origin, so Chromium's HTTP cache behaves as it does for users.
 * (Playwright request routing disables that cache.) */
async function shellOrigin(code = shellCode, host = {}) {
  const app = await homePageFixture({
    approved: true,
    shellModule: true,
    pageScript: null,
    shellCode: code,
    ...host,
  });
  const state = {
    // Serve the Release module with released Oyster 0.2.0's cache policy
    // (origin/main 58e2b5c2d7, host.ts:645-704) until the server upgrades.
    released: false,
    pause: null,
    requests: [],
  };
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", origin);
    if (url.pathname === probeWorkerPath) {
      state.requests.push({ path: url.pathname, status: 200 });
      outgoing.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      outgoing.end('self.postMessage?.("ran");\n');
      return;
    }
    if (url.pathname === "/prime") {
      outgoing.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      outgoing.end(
        `<!doctype html><title>priming</title><script type="module">await import(${JSON.stringify(releaseModulePath)}); document.title = "primed";</script>`,
      );
      return;
    }
    if (
      state.pause !== null &&
      url.pathname.startsWith("/_oyster/assets/") &&
      url.pathname.endsWith("/page.js")
    ) {
      state.pause.paused.resolve();
      await state.pause.resume.promise;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new globalThis.Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      for (const item of Array.isArray(value) ? value : [value])
        if (item !== undefined) headers.append(name, item);
    const response = await app.request(url.href, {
      method: incoming.method,
      headers,
      body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
    });
    const sent = new globalThis.Headers(response.headers);
    if (state.released && url.pathname === releaseModulePath)
      sent.set("Cache-Control", "public, max-age=31536000, immutable");
    if (url.pathname === entryPath || url.pathname === releaseModulePath)
      state.requests.push({
        path: url.pathname,
        status: response.status,
        cacheControl: sent.get("Cache-Control"),
      });
    outgoing.writeHead(response.status, Object.fromEntries(sent));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // A TCP listener reports its bound port; a pipe or closed server does not.
  const port = server.address()?.port;
  assert.ok(Number.isInteger(port));
  const origin = `http://127.0.0.1:${port}`;
  return { app, state, origin, close: () => server.close() };
}

test(
  "the real Oyster shell offers the owner's admitted fleet rather than only its selected Computer",
  { timeout: 30_000 },
  async () => {
    const ids = defineIdFamily({
      family: "computer",
      version: 1,
      kinds: { computer: { prefix: "computer" } },
    });
    const computers = ["A", "B"].map((name) => ({
      computerId: ids.computer.generate(),
      name,
      createdAt: 1,
      updatedAt: 1,
    }));
    const origin = await shellOrigin(
      `
    export const mountShell = async (root, { workbench }) => {
      const result = await workbench.computers({ limit: 100, offset: 0 });
      const marker = document.createElement("output");
      marker.id = "fleet-computers";
      marker.textContent = JSON.stringify(result.computers.map(row => row.computerId));
      root.appendChild(marker);
      return () => marker.remove();
    };
  `,
      {
        computerId: computers[0].computerId,
        ownerRoutes: standaloneComputerFleetRoutes(() => ({
          directory: async () => ({ apps: [], roles: {} }),
          selectedComputer: async () => computers[0].computerId,
          computerFleet: async (memberId, request) => {
            assert.equal(memberId, "owner");
            assert.equal(request.operation, "list");
            const end = request.page.offset + request.page.limit;
            return {
              computers: computers.slice(request.page.offset, end),
              nextOffset: end < computers.length ? end : null,
            };
          },
        })),
      },
    );
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`${origin.origin}/apps/desktop/`);
      const offered = await page.locator("#fleet-computers").textContent();
      assert.deepEqual(
        JSON.parse(offered),
        computers.map((row) => row.computerId),
      );
      const refused = await origin.app.request(
        `${origin.origin}/api/computers`,
        {
          headers: { "x-who": "key" },
        },
      );
      assert.equal(refused.status, 403);
    } finally {
      await browser?.close();
      origin.close();
    }
  },
);

/** The ordinary owner API, exactly as Permissions uses it. */
async function revoke(app, origin) {
  const grants = `${origin}/api/installations/desktop/grants`;
  const projectionResponse = await app.request(grants, {
    headers: { Accept: "application/json" },
  });
  assert.equal(projectionResponse.status, 200);
  const projection = await projectionResponse.json();
  const response = await app.request(grants, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: projection.permissions.authority.authorityVersion,
      artifactDigest: projection.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [{ capability: "team.workbenchHost", grant: null }],
      },
    }),
  });
  assert.equal(response.status, 200);
}

/** Approved document -> page script paused -> optional revocation -> resume. */
async function loadHome(page, { app, state, origin }, revoked) {
  state.pause = {
    paused: Promise.withResolvers(),
    resume: Promise.withResolvers(),
  };
  const before = state.requests.length;
  try {
    const documentResponse = await page.goto(`${origin}/apps/desktop/`, {
      waitUntil: "commit",
    });
    assert.ok(documentResponse !== null);
    assert.equal(documentResponse.status(), 200);
    const document = await documentResponse.text();
    assert.ok(document.includes('"workbench":true'));
    await state.pause.paused.promise;
    assert.deepEqual(state.requests.slice(before), [], "nothing imported yet");
    if (revoked) await revoke(app, origin);
  } finally {
    state.pause.resume.resolve();
  }
  await page.waitForLoadState("networkidle");
  state.pause = null;
  return {
    requests: state.requests.slice(before),
    mounted: await page.locator("#shell-probe-mounted").count(),
    imported: await page.evaluate(
      () => globalThis.document.documentElement.dataset.shellImported ?? null,
    ),
  };
}

for (const revoked of [true, false]) {
  test(
    revoked
      ? "owner revocation after the approved document refuses its first shell import"
      : "an approved document can import and mount its uncached shell entry",
    { timeout: 30_000 },
    async () => {
      const origin = await shellOrigin();
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        assert.deepEqual(await loadHome(page, origin, revoked), {
          requests: revoked
            ? [{ path: entryPath, status: 403, cacheControl: "no-store" }]
            : [
                { path: entryPath, status: 200, cacheControl: "no-store" },
                {
                  path: releaseModulePath,
                  status: 200,
                  cacheControl: "no-store",
                },
              ],
          mounted: revoked ? 0 : 1,
          imported: revoked ? null : "yes",
        });
        // Ordinary UI assets retain their existing immutable cache policy.
        const ordinary = await origin.app.request(
          "/ui/desktop/rel_desktop/index.html",
        );
        assert.equal(ordinary.status, 200);
        assert.equal(
          ordinary.headers.get("Cache-Control"),
          "public, max-age=31536000, immutable",
        );
      } finally {
        await browser.close();
        origin.close();
      }
    },
  );
}

test(
  "a browser holding Oyster 0.2.0's immutable shell module still refuses it after revocation",
  { timeout: 30_000 },
  async () => {
    const origin = await shellOrigin();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      origin.state.released = true;
      const priming = await context.newPage();
      await priming.goto(`${origin.origin}/prime`);
      await priming.waitForFunction(
        () => globalThis.document.title === "primed",
      );
      await priming.close();
      assert.deepEqual(origin.state.requests, [
        {
          path: releaseModulePath,
          status: 200,
          cacheControl: "public, max-age=31536000, immutable",
        },
      ]);
      // Upgrade the server. The seeded copy is live: importing the released
      // path again is served from cache, with no request this host could check.
      origin.state.released = false;
      const cached = await context.newPage();
      await cached.goto(`${origin.origin}/prime`);
      await cached.waitForFunction(
        () => globalThis.document.title === "primed",
      );
      await cached.close();
      assert.equal(
        origin.state.requests.length,
        1,
        "served from the seeded cache",
      );

      const page = await context.newPage();
      assert.deepEqual(await loadHome(page, origin, true), {
        requests: [{ path: entryPath, status: 403, cacheControl: "no-store" }],
        mounted: 0,
        imported: null,
      });
    } finally {
      await browser.close();
      origin.close();
    }
  },
);

test(
  "the trusted home shell cannot start a Worker or register a Service Worker",
  { timeout: 30_000 },
  async () => {
    const origin = await shellOrigin(`
    const attempts = {};
    try {
      const worker = new Worker(${JSON.stringify(probeWorkerPath)});
      attempts.worker = await new Promise((resolve) => {
        worker.onmessage = () => resolve("ran");
        worker.onerror = () => resolve("refused");
      });
    } catch {
      attempts.worker = "refused";
    }
    attempts.serviceWorker = await navigator.serviceWorker
      .register(${JSON.stringify(probeWorkerPath)})
      .then(() => "registered", () => "refused");
    document.documentElement.dataset.workerAttempts = JSON.stringify(attempts);
    export const mountShell = async () => () => {};
  `);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const violations = [];
      page.on("console", (message) => {
        if (/worker-src/u.test(message.text())) violations.push(message.text());
      });
      await loadHome(page, origin, false);
      await page.waitForFunction(
        () => globalThis.document.documentElement.dataset.workerAttempts,
      );
      assert.deepEqual(
        JSON.parse(
          await page.evaluate(
            () => globalThis.document.documentElement.dataset.workerAttempts,
          ),
        ),
        { worker: "refused", serviceWorker: "refused" },
      );
      assert.deepEqual(
        origin.state.requests.filter(({ path }) => path === probeWorkerPath),
        [],
        "the policy refuses before any worker script is fetched",
      );
      assert.ok(
        violations.length > 0,
        "Chromium reports the worker-src refusal",
      );
    } finally {
      await browser.close();
      origin.close();
    }
  },
);
