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
import { build as bundle } from "esbuild";
import { shellStyles } from "../../dist/page-script.js";
import {
  launchIsolatedChromium,
  portsOf,
} from "../../../../tooling/proof-runner/isolated-chromium.mjs";
import * as z from "zod";
import * as Result from "effect/Result";
import { createAppBuild } from "@fungi.computer/puffball/app";
import { assetBuildMediaType } from "@fungi.computer/puffball/assets";
import { ownerKeyAuth } from "../../src/auth.ts";
import { computerSlots } from "@fungi.computer/oyster/computer";
import { instanceIds, selectionOf } from "@fungi.computer/oyster";
import {
  applyInstallationCommand,
  deriveDeclaredOperations,
} from "../../src/apps/index.ts";
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
const { createOyster, sha256, verifyRelease } =
  await import("../../src/host.ts");
const { standalonePortEntryRoutes } =
  await import("../../src/standalone/preview.ts");
const { ComputerDO, standaloneComputerCapabilities } =
  await import("../../src/standalone/computer.ts");
const { default: worker } = await import("../../src/standalone/worker.ts");
const { StandaloneTenants, standaloneTenancy } =
  await import("../../src/standalone/tenancy.ts");

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
const release = {
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
};
let installation = null;
const ownerKey = randomBytes(32).toString("hex");
const calls = [];
let previewOrigin;
const previewDomain = "preview.example.net";
const database = new DatabaseSync(":memory:");
const tenantsDatabase = new DatabaseSync(":memory:");
const tenantValues = new Map();
const tenants = new StandaloneTenants({
  storage: {
    ...fromNodeSqlite(tenantsDatabase),
    get: async (name) => tenantValues.get(name),
    put: async (name, value) => {
      tenantValues.set(name, value);
    },
  },
  blockConcurrencyWhile: (work) => work(),
});
const secrets = new Map();
let exposed = true;
let forwarded = 0;
class BrowserComputer extends ComputerDO {
  portPreviewAfterAcceptance(port, request, accept) {
    if (!exposed) return Promise.resolve(new Response(null, { status: 404 }));
    accept();
    assert.equal(port, 3000);
    assert.equal(request.headers.has("cookie"), false);
    assert.equal(request.headers.has("authorization"), false);
    forwarded++;
    if (new URL(request.url).pathname !== "/")
      return new Response(null, { status: 404 });
    return Promise.resolve(
      new Response(
        `<h1>Private preview</h1><p>hi</p><a href="/api/owner-probe" target="_self">Hostile self navigation</a><a href="${canonicalOrigin}/api/owner-probe" target="_self">Hostile owner navigation</a><a href="/apps/owner-probe" target="_top">Hostile top navigation</a><a href="/login" target="_parent">Hostile parent navigation</a><form method="post" action="/api/owner-probe"><button>Hostile form</button></form><script>document.body.dataset.scriptExecuted="yes";fetch("/api/owner-probe");opener.document.body.dataset.escape="yes";</script>`,
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

const env = {
  OYSTER_OWNER_KEY: ownerKey,
  OYSTER_COMPUTER_ID: "workspace",
  TENANTS: { getByName: () => tenants },
  REGISTRY: {
    getByName: () => ({
      ownsComputer: (id) => id === env.OYSTER_COMPUTER_ID,
      get: async (id) =>
        id === installation.installationId ? installation : null,
    }),
  },
  RELEASES: {
    get: async (ref) => {
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
await native.exposePort({ port: 3000 });
env.COMPUTER = {
  getByName: (id) => {
    assert.equal(id, "workspace");
    return native;
  },
};
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
      if (
        url.hostname === previewDomain ||
        url.hostname.endsWith(`.${previewDomain}`)
      )
        response = await worker.fetch(request, env, {});
      else response = await app.fetch(request);
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        "set-cookie": response.headers.getSetCookie(),
      });
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
canonicalOrigin = "https://oyster.shiit.app";
previewOrigin = `https://workspace-3000.${previewDomain}`;
env.OYSTER_ORIGIN = canonicalOrigin;
env.OYSTER_PREVIEW_DOMAIN = previewDomain;
const owner = await (await standaloneTenancy(env)).owner();
assert.ok(owner);
const capabilities = standaloneComputerCapabilities(env, {
  computerId: "workspace",
}).filter((capability) => capability.id === computerSlots.ports.id);
const verified = await verifyRelease(
  { get: async (ref) => artifacts.get(ref) ?? null },
  release,
  undefined,
  false,
);
assert.ok(verified.declaration);
const declaredOperations = await deriveDeclaredOperations(
  release,
  verified.declaration,
  capabilities,
);
const identity = {
  installationId: "shed",
  instanceId: instanceIds.instance.generate(),
};
const commit = (command) => {
  const result = applyInstallationCommand(installation, command, {
    by: owner.actor,
    role: owner.role,
    expectedVersion:
      installation === null ? null : selectionOf(installation).authorityVersion,
    declaration: verified.declaration,
    declaredOperations,
    now: Date.now(),
    identity,
  });
  if (Result.isFailure(result))
    throw new Error(`Preview fixture approval refused: ${result.failure.code}`);
  installation = result.success.next;
};
commit({ kind: "install", release, releasePin: "pinned" });
commit({
  kind: "change-grants",
  changes: declaredOperations.capabilities.map(
    ({ capability, operations }) => ({
      capability,
      grant: { operations, resources: "tenant-scope" },
    }),
  ),
});
// A standalone App page has no desktop chrome. Retain its real mount and
// expose the public host action used by Tourtois to open Shed's Ports tray.
const pageBundle = await bundle({
  stdin: {
    contents: `import { mountOysterPage } from "@fungi.computer/oyster/page";
      globalThis.previewProofHost = await mountOysterPage();`,
    resolveDir: new URL("../../", import.meta.url).pathname,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  define: { OYSTER_SHELL_STYLES: JSON.stringify(shellStyles) },
  minify: true,
  write: false,
});
const app = createOyster({
  tenantId: "default",
  pageScript: pageBundle.outputFiles[0].text,
  ownerRoutes: standalonePortEntryRoutes({
    ownsComputer: async (id) => id === "workspace",
    issue: (_id, ownerId, port) => native.issuePortConnect(ownerId, port),
  }),
  auth: ownerKeyAuth(ownerKey, owner.actor.memberId),
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
  capabilities,
});
// With OYSTER_PREVIEW_DOMAIN correctly naming previewOrigin, that host stays
// fenced off from the normal router even when the rest of the pair (the
// owner origin) is broken or missing — misconfiguration never falls through.
for (const invalid of [
  { OYSTER_ORIGIN: undefined, OYSTER_PREVIEW_DOMAIN: previewDomain },
  { OYSTER_ORIGIN: "not an origin", OYSTER_PREVIEW_DOMAIN: previewDomain },
]) {
  Object.assign(env, invalid);
  assert.equal(
    (await worker.fetch(new Request(`${canonicalOrigin}/login`), env, {}))
      .status,
    500,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request(`${canonicalOrigin}/api/installations`),
        env,
        {},
      )
    ).status,
    500,
  );
  assert.equal(
    (await worker.fetch(new Request(`${previewOrigin}/login`), env, {})).status,
    404,
  );
}
// An unconfigured preview host reaches the tenant owner's origin fence.
env.OYSTER_ORIGIN = canonicalOrigin;
env.OYSTER_PREVIEW_DOMAIN = "unrelated.example";
assert.equal(
  (await worker.fetch(new Request(`${previewOrigin}/login`), env, {})).status,
  404,
);
env.OYSTER_ORIGIN = canonicalOrigin;
env.OYSTER_PREVIEW_DOMAIN = previewDomain;
const browser = await launchIsolatedChromium(
  chromium,
  portsOf(`https://127.0.0.1:${address.port}`),
  {
    args: [
      `--host-resolver-rules=MAP oyster.shiit.app:443 127.0.0.1:${address.port},MAP *.${previewDomain}:443 127.0.0.1:${address.port},MAP ${previewDomain}:443 127.0.0.1:${address.port}`,
      "--no-proxy-server",
    ],
  },
);
// A fresh page avoids races with Chromium's internal error-page navigation
// after an empty refusal. It retains the browser context's real cookie rules.
async function responseStatus(page, url) {
  const probe = await page.context().newPage();
  try {
    const received = probe.waitForResponse(
      (response) =>
        response.url() === url && response.request().isNavigationRequest(),
    );
    await probe.goto(url).catch((cause) => {
      if (!String(cause).includes("net::ERR_HTTP_RESPONSE_CODE_FAILURE"))
        throw cause;
    });
    return (await received).status();
  } finally {
    await probe.close();
  }
}

try {
  for (const { width, height, colorScheme } of [
    { width: 1440, height: 900, colorScheme: "light" },
    { width: 1440, height: 900, colorScheme: "dark" },
    { width: 390, height: 844, colorScheme: "light" },
    { width: 390, height: 844, colorScheme: "dark" },
  ]) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      colorScheme,
    });
    const page = await context.newPage();
    await page.goto(`${canonicalOrigin}/login`);
    await page.locator('input[name="key"]').fill(ownerKey);
    await Promise.all([
      page.waitForURL(`${canonicalOrigin}/`),
      page.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    const appDocument = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.startsWith("/ui/shed/") &&
        response.request().resourceType() === "document"
      );
    });
    await page.goto(`${canonicalOrigin}/apps/shed/`);
    const documentResponse = await appDocument;
    const sandbox = new URL(documentResponse.url()).searchParams.get("sandbox");
    assert.ok(sandbox?.includes("allow-popups-to-escape-sandbox"));
    const documentPolicy =
      documentResponse.headers()["content-security-policy"];
    assert.ok(documentPolicy.endsWith(`sandbox ${sandbox}`));
    const frame = page.frameLocator("#oyster-app");
    await frame.getByText("Terminal unavailable", { exact: true }).waitFor();
    await page.waitForFunction(() => globalThis.previewProofHost !== undefined);
    assert.equal(
      await page.evaluate(() =>
        globalThis.previewProofHost.activateStatus({ itemId: "ports" }),
      ),
      true,
    );
    const button = frame.getByRole("button", {
      name: "Open preview of port 3000",
      exact: true,
    });
    await button.waitFor();
    await page.screenshot({
      path: new URL(`before-${width}-${colorScheme}.png`, work).pathname,
    });
    let connectUrl;
    const recordConnect = (request) => {
      const url = new URL(request.url());
      if (url.origin === previewOrigin && url.searchParams.has("token"))
        connectUrl = url.href;
    };
    context.on("request", recordConnect);
    const popupPromise = page.waitForEvent("popup", { timeout: 3000 });
    await button.click();
    const popup = await popupPromise;
    await popup
      .getByRole("heading", { name: "Private preview", exact: true })
      .waitFor();
    context.off("request", recordConnect);
    assert.ok(connectUrl);
    const previewUrl = popup.url();
    assert.equal(new URL(previewUrl).searchParams.has("token"), false);
    assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
    assert.equal(
      await popup.locator("body").getAttribute("data-script-executed"),
      "yes",
    );
    await popup.screenshot({
      path: new URL(`popup-${width}-${colorScheme}.png`, work).pathname,
    });
    assert.equal(
      await frame.locator('iframe[title="Preview · port 3000"]').count(),
      0,
    );
    assert.equal(
      await page.locator("#oyster-app").getAttribute("sandbox"),
      "allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-forms",
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
    assert.ok(
      calls.slice(bodyProbe).some((call) => call.path === "/api/owner-probe"),
      "The active page's form reaches only the fenced preview origin",
    );
    for (const label of [
      "Hostile self navigation",
      "Hostile top navigation",
      "Hostile parent navigation",
    ]) {
      await popup.goto(previewUrl);
      const navigation = popup.waitForResponse(
        (response) =>
          response.url().startsWith(previewOrigin) && response.status() === 404,
      );
      await popup.getByRole("link", { name: label, exact: true }).click();
      await navigation;
    }
    await popup.goto(previewUrl);
    const ownerProbe = calls.length;
    await popup
      .getByRole("link", { name: "Hostile owner navigation", exact: true })
      .click();
    await popup.waitForLoadState("networkidle");
    const hostileRequests = calls
      .slice(ownerProbe)
      .filter(
        (call) =>
          call.host === "oyster.shiit.app" && call.path === "/api/owner-probe",
      );
    assert.ok(hostileRequests.length > 0);
    assert.ok(
      hostileRequests.every((call) => !call.cookie && !call.bearer),
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
      assert.equal(
        await responseStatus(popup, `https://${previewDomain}${path}`),
        404,
      );
      assert.equal(forwarded, before);
    }
    const wrongPort = new URL(previewUrl);
    wrongPort.hostname = wrongPort.hostname.replace("-3000.", "-3001.");
    assert.equal(await responseStatus(popup, wrongPort.href), 401);
    // A session belongs to the owner and Computer, not the App used to open it.
    const originalInstallation = installation;
    commit({ kind: "set-status", status: "disabled" });
    assert.equal(await responseStatus(popup, previewUrl), 200);
    installation = originalInstallation;
    const noOwner = await browser.newContext({ ignoreHTTPSErrors: true });
    const bearerPage = await noOwner.newPage();
    assert.equal(
      await responseStatus(bearerPage, previewUrl),
      401,
      "A stable preview URL carries no authority",
    );
    assert.equal(
      await responseStatus(bearerPage, connectUrl),
      401,
      "A connect URL cannot be replayed",
    );
    await noOwner.close();
    const clock = Date.now;
    try {
      Date.now = () => clock() + 10 * 60_000;
      assert.equal(await responseStatus(popup, previewUrl), 200);
      Date.now = () => clock() + 61 * 60_000;
      assert.equal(await responseStatus(popup, previewUrl), 401);
    } finally {
      Date.now = clock;
    }
    assert.ok(
      calls
        .filter((call) => call.host.endsWith(`.${previewDomain}`))
        .every((call) => !call.bearer),
    );
    database.exec("DELETE FROM computer_exposed_ports WHERE port = 3000");
    exposed = false;
    assert.equal(await responseStatus(popup, previewUrl), 401);
    exposed = true;
    database.exec(
      "INSERT INTO computer_exposed_ports (port, process_id) VALUES (3000,NULL)",
    );
    await page.screenshot({
      path: new URL(`after-${width}-${colorScheme}.png`, work).pathname,
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
        portSessions: "persisted local SQLite",
        productionWorker: "actual source preview fence",
        physicalPort: "real exposure inventory; fake HTTP only",
      },
      null,
      2,
    ),
  );
  console.log(
    "Oyster owner entry / captured Shed opaque UI / public host status action / persisted session / Worker-fenced popup gate PASS; physical port I/O fake",
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((cause) => (cause ? reject(cause) : resolve())),
  );
  database.close();
  tenantsDatabase.close();
  hooks.deregister();
}
