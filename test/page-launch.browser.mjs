import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { Hono } from "hono";
import {
  createAppBuild,
  emptyAppDeclaration,
} from "@fungi.computer/puffball/app";
import { assetBuildMediaType } from "@fungi.computer/puffball/assets";
import { createOyster } from "../dist/host.js";
import { sha256 } from "../dist/release.js";
import { computerSlots } from "../dist/computer.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { approvedInstallation } from "../dist/testing/index.js";
import { instanceIds } from "../dist/index.js";

async function wasmAssetHost(mainSource) {
  const artifacts = new Map();
  const encode = (text) => new globalThis.TextEncoder().encode(text);
  async function put(bytes) {
    const digest = await sha256(bytes);
    const artifactRef = `artifact:sha256-${digest.slice(7)}`;
    artifacts.set(artifactRef, bytes);
    return { artifactRef, digest, version: digest, byteLength: bytes.length };
  }
  const assets = [];
  for (const [path, contentType, bytes] of [
    [
      "/index.html",
      "text/html; charset=utf-8",
      encode(
        '<!doctype html><body><script type="module" src="./main.js"></script>',
      ),
    ],
    [
      "/main.js",
      "text/javascript",
      encode(
        mainSource ??
          `
        const result = {};
        try {
          const response = await fetch("./module.wasm");
          await WebAssembly.instantiateStreaming(response);
          result.wasm = true;
        } catch { result.wasm = false; }
        for (const url of ["/outside", "https://external.invalid/probe"]) {
          try { await fetch(url); result[url] = "allowed"; }
          catch { result[url] = "blocked"; }
        }
        try { new Function("return 1")(); result.eval = "allowed"; }
        catch { result.eval = "blocked"; }
        document.body.textContent = JSON.stringify(result);
      `,
      ),
    ],
    // Valid, empty WASM module: the browser must fetch and compile real bytes.
    [
      "/module.wasm",
      "application/wasm",
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    ],
  ]) {
    assets.push({ path, contentType, ...(await put(bytes)) });
  }
  const ui = await put(
    encode(JSON.stringify({ format: "fungi-assets-v1", base: "./", assets })),
  );
  const root = await put(
    encode(
      JSON.stringify(
        createAppBuild({ ...ui, mediaType: assetBuildMediaType }, null),
      ),
    ),
  );
  const installation = await approvedInstallation({
    installationId: "wasm-probe",
    instanceId: instanceIds.instance.generate(),
    declaration: emptyAppDeclaration,
    release: {
      appId: "app_wasmprobe",
      releaseId: "rel_wasmprobe",
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
  });
  return createOyster({
    bootUi: () => Promise.resolve({ kind: "passed" }),
    auth: {
      authenticate: async () => ({
        kind: "admitted",
        principal: {
          actor: { kind: "member", memberId: "owner" },
          role: "owner",
        },
      }),
    },
    artifacts: { get: async (ref) => artifacts.get(ref) ?? null },
    installations: {
      get: async (id) =>
        id === installation.installationId ? installation : null,
    },
    instances: {
      get: () => {
        throw new Error("UI assets do not call a backend");
      },
    },
  });
}

test("Oyster assets compile their own WASM while remote fetch and JavaScript eval remain blocked", async () => {
  const app = await wasmAssetHost();
  const url = "http://oyster.test/ui/wasm-probe/rel_wasmprobe/";
  const response = await app.request(url);
  assert.equal(response.status, 200);
  const csp = response.headers.get("Content-Security-Policy");
  assert.ok(csp.includes(`script-src ${url} 'wasm-unsafe-eval'`));
  assert.ok(csp.includes(`connect-src data: ${url};`));
  assert.ok(csp.includes("frame-src 'none';"));
  assert.ok(csp.includes("form-action 'none';"));
  assert.ok(csp.includes("sandbox allow-scripts"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const escapedRequests = [];
    await page.route("**/*", async (route) => {
      if (!route.request().url().startsWith(url)) {
        escapedRequests.push(route.request().url());
        await route.abort();
        return;
      }
      const served = await app.request(route.request().url());
      await route.fulfill({
        status: served.status,
        headers: Object.fromEntries(served.headers),
        body: Buffer.from(await served.arrayBuffer()),
      });
    });
    await page.goto(url);
    await page.locator("body").filter({ hasText: '"wasm"' }).waitFor();
    assert.deepEqual(JSON.parse(await page.locator("body").innerText()), {
      wasm: true,
      "/outside": "blocked",
      "https://external.invalid/probe": "blocked",
      eval: "blocked",
    });
    assert.deepEqual(escapedRequests, []);
  } finally {
    await browser.close();
  }
});

test("the emitted App page launches Agar with the admitted Computer or null", async () => {
  const guest = await build({
    stdin: {
      contents: `import { connectApp } from "@fungi.computer/agar";
        const app = await connectApp({ host: "parent" });
        document.body.textContent = JSON.stringify(app.context.get());`,
      resolveDir: new globalThis.URL("..", import.meta.url).pathname,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [computerId, principal, expected] of [
      [
        "host-selected-computer",
        { actor: { kind: "member", memberId: "owner" }, role: "owner" },
        "host-selected-computer",
      ],
      [
        undefined,
        { actor: { kind: "member", memberId: "owner" }, role: "owner" },
        null,
      ],
      // An anonymous reader of the public App is the host's visitor.
      ["private-computer", null, null],
    ]) {
      const host = await computerHost(principal, computerId);
      const installations =
        principal === null
          ? {
              ...host.installations,
              get: async (id) => {
                const installation = await host.installations.get(id);
                return (
                  installation && { ...installation, visibility: "public" }
                );
              },
            }
          : host.installations;
      const app = createOyster({
        ...host,
        installations,
        capabilities: [
          {
            ...computerSlots.ports,
            permission: "computer.execute",
            admits: () => true,
            routes: new Hono(),
          },
        ],
      });
      const page = await browser.newPage();
      try {
        await page.route("http://oyster.test/**", async (route) => {
          const url = new globalThis.URL(route.request().url());
          if (url.pathname.startsWith("/ui/")) {
            await route.fulfill({
              contentType: "text/html",
              body: `<body><script type="module">${guest.outputFiles[0].text}</script></body>`,
            });
            return;
          }
          const response = await app.request(url.href);
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: await response.text(),
          });
        });
        await page.goto(
          "http://oyster.test/apps/context-probe/?computerId=guest-computer",
        );
        const frame = page.frameLocator("#oyster-app").locator("body");
        await frame.filter({ hasText: '"computerId"' }).waitFor();
        assert.equal(JSON.parse(await frame.innerText()).computerId, expected);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test("host browser actions save exact bytes and copy text from an opaque App click", async () => {
  const guest = await build({
    stdin: {
      contents: `import { connectApp } from "@fungi.computer/agar";
        const app = await connectApp({ host: "parent" });
        const output = document.createElement("output");
        document.body.append(output);
        for (const [label, request] of [
          ["Save", { kind: "saveFile", name: "workflow.json", mime: "application/json", bytes: new TextEncoder().encode('{"title":"Pond 🌿"}\\n') }],
          ["Copy", { kind: "copyText", text: '{"title":"Pond 🌿"}\\n' }],
        ]) {
          const button = document.createElement("button");
          button.textContent = label;
          button.onclick = async () => {
            try { output.textContent = JSON.stringify(await app.ui.requestBrowserAction(request)); }
            catch (cause) { output.textContent = JSON.stringify({ error: cause.message }); }
          };
          document.body.append(button);
        }`,
      resolveDir: new globalThis.URL("..", import.meta.url).pathname,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const app = await wasmAssetHost(guest.outputFiles[0].text);
  // Full Chromium supplies native clipboard permissions; headless-shell denies
  // even a direct trusted-page copy without an artificial permission grant.
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.route("https://oyster.test/**", async (route) => {
      const response = await app.request(route.request().url());
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const policy = await app.request(
      "https://oyster.test/ui/wasm-probe/rel_wasmprobe/",
    );
    assert.ok(
      policy.headers
        .get("content-security-policy")
        .includes("sandbox allow-scripts"),
    );
    assert.ok(
      !policy.headers
        .get("content-security-policy")
        .includes("allow-downloads"),
    );
    assert.ok(
      !policy.headers
        .get("content-security-policy")
        .includes("allow-same-origin"),
    );
    const documentResponse = await page.goto(
      "https://oyster.test/apps/wasm-probe/",
    );
    assert.equal(documentResponse?.status(), 200);
    const frame = page.frameLocator("#oyster-app");
    const output = frame.locator("output");
    const downloads = [];
    page.on("download", (download) => downloads.push(download));
    await frame.getByRole("button", { name: "Save", exact: true }).click();
    await output.filter({ hasText: /./ }).waitFor();
    assert.deepEqual(JSON.parse(await output.innerText()), { kind: "saved" });
    const downloaded = downloads[0] ?? (await page.waitForEvent("download"));
    assert.equal(downloads.length, 1);
    assert.equal(downloaded.suggestedFilename(), "workflow.json");
    assert.equal(
      await readFile(await downloaded.path(), "utf8"),
      '{"title":"Pond 🌿"}\n',
    );
    await output.evaluate((element) => {
      element.textContent = "";
    });
    await frame.getByRole("button", { name: "Copy", exact: true }).click();
    await output.filter({ hasText: /./ }).waitFor();
    assert.deepEqual(JSON.parse(await output.innerText()), { kind: "copied" });
    await context.grantPermissions(["clipboard-read"], {
      origin: "https://oyster.test",
    });
    assert.equal(
      await page.evaluate(() => globalThis.navigator.clipboard.readText()),
      '{"title":"Pond 🌿"}\n',
    );
    assert.equal(
      await frame.locator("body").evaluate(() => globalThis.origin),
      "null",
    );
    // A click in the host page must not authorize an unfocused App.
    await page.locator("#oyster-app").evaluate((element) => {
      element.style.height = "50%";
    });
    await page.locator("body").click({ position: { x: 8, y: 590 } });
    await output.evaluate((element) => {
      element.textContent = "";
    });
    await frame
      .getByRole("button", { name: "Save", exact: true })
      .evaluate((button) => button.click());
    await output.filter({ hasText: /./ }).waitFor();
    assert.deepEqual(JSON.parse(await output.innerText()), {
      kind: "refused",
      reason: "no-user-gesture",
    });
    assert.equal(downloads.length, 1);
  } finally {
    await browser.close();
  }
});
