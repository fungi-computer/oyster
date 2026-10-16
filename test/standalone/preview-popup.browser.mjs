import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import * as console from "node:console";
import { URL } from "node:url";
const { Response, Request, Headers } = globalThis;
import { chromium } from "playwright";
import * as z from "zod";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { assetBuildMediaType } from "@fungi.computer/puffball/assets";
import { createOyster, sha256 } from "@fungi.computer/oyster/host";
import { ownerKeyAuth } from "../../src/auth.ts";
import { computerSlots } from "@fungi.computer/oyster/computer";
import { instanceIds } from "@fungi.computer/oyster";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "cloudflare:workers" ||
      specifier === "cloudflare:workflows"
    )
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { ComputerDO, standaloneComputerCapabilities } =
  await import("../../src/standalone/computer.ts");
const { default: worker } = await import("../../src/standalone/worker.ts");

const work = new URL("../../.botanical/preview-popup/", import.meta.url);
await mkdir(work, { recursive: true });
const key = new URL("local.key", work);
const certificate = new URL("local.crt", work);
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
    "/CN=oyster.shiit.app",
    "-keyout",
    key.pathname,
    "-out",
    certificate.pathname,
  ],
  { stdio: "ignore" },
);
const artifacts = new Map();
async function put(bytes) {
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  artifacts.set(artifactRef, bytes);
  return { artifactRef, digest, version: digest, byteLength: bytes.length };
}
const types = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript"],
  ["css", "text/css"],
  ["woff2", "font/woff2"],
  ["wasm", "application/wasm"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
]);
const assets = [];
const dist = new URL("../../../../apps/shed/dist/", import.meta.url);
for (const path of await readdir(dist, { recursive: true })) {
  const contentType = types.get(path.split(".").at(-1));
  if (!contentType) continue;
  assets.push({
    path: `/${path}`,
    contentType,
    ...(await put(await readFile(new URL(path, dist)))),
  });
}
const ui = await put(
  new TextEncoder().encode(
    JSON.stringify({ format: "fungi-assets-v1", base: "./", assets }),
  ),
);
const build = createAppBuild({ ...ui, mediaType: assetBuildMediaType }, null, {
  capabilities: ["computer.execute"],
  handlers: [],
  roles: [],
});
const root = await put(new TextEncoder().encode(JSON.stringify(build)));
const installation = {
  installationId: "shed",
  instanceId: instanceIds.instance.generate(),
  authorityVersion: 1,
  status: "enabled",
  release: {
    appId: "app_shed",
    releaseId: "rel_shed",
    artifact: {
      artifactRef: root.artifactRef,
      artifactDigest: root.digest,
      provenance: {
        sourceRevision: `git:${"a".repeat(40)}`,
        sourceTreeDigest: root.digest,
        buildRecipeDigest: root.digest,
      },
    },
  },
};
const ownerKey = randomBytes(32).toString("hex");
const ownerAuth = ownerKeyAuth(ownerKey);
const calls = [];
let previewOrigin;
const database = new DatabaseSync(":memory:");
const secrets = new Map();
let exposed = true;
let forwarded = 0;
class BrowserComputer extends ComputerDO {
  listPortsAfterAcceptance(accept) {
    accept();
    return Promise.resolve({ ports: exposed ? [3000] : [] });
  }
  portPreviewAfterAcceptance(port, request, accept) {
    if (!exposed) return Promise.resolve(new Response(null, { status: 404 }));
    accept();
    assert.equal(port, 3000);
    assert.equal(request.headers.has("cookie"), false);
    assert.equal(request.headers.has("authorization"), false);
    forwarded++;
    return Promise.resolve(
      new Response(
        `<h1>Passive preview</h1><p>hi</p><a href="/api/owner-probe" target="_self">Hostile self navigation</a><a href="${canonicalOrigin}/api/owner-probe" target="_self">Hostile owner navigation</a><a href="/apps/owner-probe" target="_top">Hostile top navigation</a><a href="/login" target="_parent">Hostile parent navigation</a><form method="post" action="/api/owner-probe"><button>Hostile form</button></form><script>document.body.dataset.scriptExecuted="yes";fetch("/api/owner-probe");opener.document.body.dataset.escape="yes";</script>`,
        {
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie":
              "oyster_session=evil; Secure; HttpOnly; SameSite=Strict",
          },
        },
      ),
    );
  }
}
let artifactBarrier;
const env = {
  OYSTER_OWNER_KEY: ownerKey,
  OYSTER_COMPUTER_ID: "workspace",
  REGISTRY: {
    getByName: () => ({
      get: async (id) =>
        id === installation.installationId ? installation : null,
    }),
  },
  RELEASES: {
    get: async (ref) => {
      await artifactBarrier?.();
      const bytes = artifacts.get(ref);
      return bytes === undefined
        ? null
        : {
            arrayBuffer: async () =>
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ),
          };
    },
  },
};
const native = new BrowserComputer(
  {
    id: { name: "workspace" },
    storage: {
      ...fromNodeSqlite(database),
      get: async (name) => secrets.get(name),
      put: async (name, value) => {
        secrets.set(name, value);
      },
    },
  },
  env,
);
env.COMPUTER = {
  getByName: (id) => {
    assert.equal(id, "workspace");
    return native;
  },
};
const app = createOyster({
  auth: ownerAuth,
  computerId: "workspace",
  artifacts: { get: async (ref) => artifacts.get(ref) ?? null },
  installations: {
    get: async (id) => (id === "shed" ? installation : null),
    list: async () => [installation],
  },
  instances: {
    get: () => {
      throw new Error("No backend call belongs in the preview popup gate");
    },
  },
  capabilities: standaloneComputerCapabilities(env, {
    computerId: "workspace",
  }).filter((capability) => capability.id === computerSlots.ports.id),
});
let canonicalOrigin;
const server = createServer(
  { key: await readFile(key), cert: await readFile(certificate) },
  async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const url = new URL(incoming.url, `https://${headers.get("host")}`);
      const options = {
        method: incoming.method,
        headers,
      };
      if (incoming.method === "POST") options.body = Buffer.concat(chunks);
      const request = new Request(url, options);
      calls.push({
        host: url.hostname,
        path: url.pathname.replace(/\/([a-z2-7]{20})\//u, "/[ticket]/"),
        cookie: headers.has("cookie"),
        bearer: headers.has("authorization"),
      });
      let response;
      if (url.origin === previewOrigin)
        response = await worker.fetch(request, env, {});
      else response = await app.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (cause) {
      console.error("Popup fixture failed", cause);
      outgoing.writeHead(500);
      outgoing.end("Fixture failure");
    }
  },
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = z
  .object({ port: z.number().int().positive() })
  .parse(server.address());
canonicalOrigin = `https://oyster.shiit.app:${address.port}`;
previewOrigin = `https://oyster-contest.levi-fe0.workers.dev:${address.port}`;
env.OYSTER_ORIGIN = canonicalOrigin;
env.OYSTER_PREVIEW_ORIGIN = previewOrigin;
// With OYSTER_PREVIEW_ORIGIN correctly naming previewOrigin, that host stays
// fenced off from the normal router even when the rest of the pair (the
// owner origin) is broken or missing — misconfiguration never falls through.
for (const invalid of [
  { OYSTER_ORIGIN: undefined, OYSTER_PREVIEW_ORIGIN: previewOrigin },
  { OYSTER_ORIGIN: "not an origin", OYSTER_PREVIEW_ORIGIN: previewOrigin },
]) {
  Object.assign(env, invalid);
  assert.equal(
    (await worker.fetch(new Request(`${canonicalOrigin}/login`), env, {}))
      .status,
    200,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request(`${canonicalOrigin}/api/installations`),
        env,
        {},
      )
    ).status,
    401,
  );
  assert.equal(
    (await worker.fetch(new Request(`${previewOrigin}/login`), env, {})).status,
    404,
  );
}
// A preview configured at an unrelated origin never makes previewOrigin
// special: nothing names it as the preview tunnel, so it is left to the
// normal router like any other Host, same as before preview was configured.
env.OYSTER_ORIGIN = canonicalOrigin;
env.OYSTER_PREVIEW_ORIGIN = "https://unrelated.example";
assert.equal(
  (await worker.fetch(new Request(`${previewOrigin}/login`), env, {})).status,
  200,
);
env.OYSTER_ORIGIN = canonicalOrigin;
env.OYSTER_PREVIEW_ORIGIN = previewOrigin;
const browser = await chromium.launch({
  args: [
    "--host-resolver-rules=MAP oyster.shiit.app 127.0.0.1,MAP oyster-contest.levi-fe0.workers.dev 127.0.0.1",
    "--no-proxy-server",
  ],
});
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(`${canonicalOrigin}/login`);
    await page.locator('input[name="key"]').fill(ownerKey);
    await Promise.all([
      page.waitForURL(`${canonicalOrigin}/`),
      page.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    await page.goto(`${canonicalOrigin}/apps/shed/`);
    const frame = page.frameLocator("#oyster-app");
    await page.getByRole("button", { name: /Ports/u }).click();
    const button = frame.getByRole("button", {
      name: "Open preview of port 3000",
      exact: true,
    });
    await button.waitFor();
    await page.screenshot({
      path: new URL(`before-${width}.png`, work).pathname,
    });
    const popupPromise = page.waitForEvent("popup", { timeout: 3000 });
    await button.click();
    const popup = await popupPromise;
    await popup
      .getByRole("heading", { name: "Passive preview", exact: true })
      .waitFor();
    const ticketUrl = popup.url();
    assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
    assert.equal(
      await popup.locator("body").getAttribute("data-script-executed"),
      null,
    );
    await popup.screenshot({
      path: new URL(`popup-${width}.png`, work).pathname,
    });
    assert.equal(
      await frame.locator('iframe[title="Preview · port 3000"]').count(),
      0,
    );
    assert.equal(
      await page.locator("#oyster-app").getAttribute("sandbox"),
      "allow-scripts allow-modals allow-popups allow-forms",
    );
    assert.ok(
      !(await context.cookies(previewOrigin)).some(
        (cookie) => cookie.name === "oyster_session",
      ),
    );
    const bodyProbe = calls.length;
    await popup
      .getByRole("button", { name: "Hostile form", exact: true })
      .click();
    await popup.waitForLoadState("networkidle");
    assert.equal(
      calls.length,
      bodyProbe,
      "Sandbox must block the actual form request",
    );
    for (const label of [
      "Hostile self navigation",
      "Hostile top navigation",
      "Hostile parent navigation",
    ]) {
      await popup.goto(ticketUrl);
      const navigation = popup.waitForResponse(
        (response) =>
          response.url().startsWith(previewOrigin) && response.status() === 404,
      );
      await popup.getByRole("link", { name: label, exact: true }).click();
      await navigation;
    }
    await popup.goto(ticketUrl);
    const ownerProbe = calls.length;
    await popup
      .getByRole("link", { name: "Hostile owner navigation", exact: true })
      .click();
    await popup.waitForLoadState("networkidle");
    assert.ok(
      calls
        .slice(ownerProbe)
        .filter((call) => call.host === "oyster.shiit.app")
        .every((call) => !call.cookie && !call.bearer),
      "Preview navigation must not carry the owner credential",
    );
    for (const path of [
      "/api",
      "/apps",
      "/ui",
      "/login",
      "/mcp",
      "/__vm/lab/ws",
    ]) {
      const before = forwarded;
      const result = await popup.goto(`${previewOrigin}${path}`);
      assert.equal(result?.status(), 404);
      assert.equal(forwarded, before);
    }
    const invalid = new URL(ticketUrl);
    invalid.pathname = invalid.pathname.replace(
      /\/[a-z2-7]{20}\//u,
      "/aaaaaaaaaaaaaaaaaaaa/",
    );
    assert.equal((await popup.goto(invalid.href))?.status(), 403);
    const wrongPort = new URL(ticketUrl);
    wrongPort.pathname = wrongPort.pathname.replace("/3000/", "/3001/");
    assert.equal((await popup.goto(wrongPort.href))?.status(), 403);
    const originalInstance = installation.instanceId;
    installation.instanceId = instanceIds.instance.generate();
    assert.equal((await popup.goto(ticketUrl))?.status(), 403);
    installation.instanceId = originalInstance;
    installation.authorityVersion++;
    assert.equal((await popup.goto(ticketUrl))?.status(), 403);
    installation.authorityVersion--;
    installation.status = "disabled";
    assert.equal((await popup.goto(ticketUrl))?.status(), 403);
    installation.status = "enabled";
    for (const change of ["disable", "version"]) {
      const reading = Promise.withResolvers();
      const release = Promise.withResolvers();
      const before = forwarded;
      artifactBarrier = () => {
        reading.resolve();
        return release.promise;
      };
      const navigation = popup.goto(ticketUrl);
      await reading.promise;
      if (change === "disable") installation.status = "disabled";
      else installation.authorityVersion++;
      release.resolve();
      try {
        assert.equal((await navigation)?.status(), 403);
        assert.equal(
          forwarded,
          before,
          "Revocation during artifact verification must precede physical forwarding",
        );
      } finally {
        artifactBarrier = undefined;
        if (change === "disable") installation.status = "enabled";
        else installation.authorityVersion--;
      }
    }
    exposed = false;
    assert.equal((await popup.goto(ticketUrl))?.status(), 404);
    exposed = true;
    const noOwner = await browser.newContext({ ignoreHTTPSErrors: true });
    const bearerPage = await noOwner.newPage();
    assert.equal(
      (await bearerPage.goto(ticketUrl))?.status(),
      200,
      "Valid scoped bearer works without an owner session, as explicitly approved",
    );
    await noOwner.close();
    const clock = Date.now;
    try {
      Date.now = () => clock() + 10 * 60_000;
      assert.equal((await popup.goto(ticketUrl))?.status(), 403);
    } finally {
      Date.now = clock;
    }
    assert.ok(
      calls
        .filter((call) => call.host === "oyster-contest.levi-fe0.workers.dev")
        .every((call) => !call.cookie && !call.bearer),
    );
    await page.screenshot({
      path: new URL(`after-${width}.png`, work).pathname,
    });
    await context.close();
  }
  await writeFile(
    new URL("report.json", work),
    JSON.stringify(
      {
        calls,
        popupGate: "pass",
        forwarded,
        nativeTickets: "persisted local SQLite",
        productionWorker: "actual source preview fence",
        physicalPort: "fake inventory/HTTP only",
      },
      null,
      2,
    ),
  );
  console.log(
    "Actual Oyster shell / captured Shed opaque UI / persisted ticket / Worker-fenced popup gate PASS; physical port I/O fake",
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((cause) => (cause ? reject(cause) : resolve())),
  );
  database.close();
  hooks.deregister();
}
