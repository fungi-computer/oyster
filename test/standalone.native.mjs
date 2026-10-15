// End-to-end proof of the standalone Oyster: pack the Notes example App,
// start the standalone Worker with `wrangler dev`, install the Release over
// HTTP, call its methods and backend, and drive its UI in a browser.
//
//   node test/standalone.native.mjs                 # workerd (wrangler dev)
//   CELLD_PLATFORM_CELLD=$(…/pinned-celld.sh) \
//     node --import …/wrangler-on-celld.mjs test/standalone.native.mjs  # celld
/* global URL, fetch, setTimeout, console, process */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { z } from "zod";
import { installRelease, packRelease } from "../dist/pack.js";
import { proveMcp } from "./mcp.native.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRevision = `git:${execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim()}`;
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/standalone-`);
const key = randomBytes(24).toString("hex");
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// 1. Build UI, backend and declaration from the exact committed repository.
const packed = await packRelease({
  appId: "app_notes",
  releaseId: "rel_notes1",
  sourceDirectory: repository,
  sourceRevision,
  packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  recipe: {
    entry: "packages/oyster/examples/notes-app/ui/index.html",
    assets: {
      maxManifestBytes: 1_048_576,
      maxObjects: 1024,
      maxObjectBytes: 16_777_216,
      maxTotalBytes: 67_108_864,
    },
    assetBase: "./",
    maxOutputBytes: 67_108_864,
    backend: {
      entry: "packages/oyster/test/guest-headers.fixture.ts",
      exportName: "Notes",
      compatibilityDate: "2026-09-04",
      runtime: { kind: "durable-facet", stateSchema: 1 },
    },
  },
  outDirectory: `${work}/release`,
});
assert.equal(packed.release.appId, "app_notes");
assert.equal(packed.release.artifact.provenance.sourceRevision, sourceRevision);

// 2. Start the standalone Oyster.
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const wrangler = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    `${root}test/guest-worker.fixture.ts`,
    "--config",
    `${root}test/scoped-mcp.wrangler.jsonc`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--var",
    `OYSTER_OWNER_KEY:${key}`,
    "--var",
    `OYSTER_ORIGIN:${origin}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
wrangler.stdout.on("data", (chunk) => (output += chunk));
wrangler.stderr.on("data", (chunk) => (output += chunk));
const stopped = new Promise((resolve) => wrangler.once("exit", resolve));

try {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${origin}/login`).then(
      (response) => response.ok,
      (cause) => ({ notListening: cause }),
    );
    if (ready === true) break;
    if (attempt > 240)
      throw new Error(
        `Oyster did not start:\n${output.replaceAll(key, "[redacted]")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`standalone Oyster on ${runtime}: server ready`);
  const auth = { Authorization: `Bearer ${key}` };

  // 3. Refusals before install.
  assert.equal((await fetch(`${origin}/api/installations`)).status, 401);
  assert.equal(
    (
      await fetch(`${origin}/api/installations`, {
        headers: { Authorization: "Bearer wrong-key-wrong-key-wrong" },
      })
    ).status,
    401,
  );

  // 4. Install over HTTP.
  const installed = await installRelease({
    directory: `${work}/release`,
    url: origin,
    key,
    installationId: "notes",
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  const installation = await installed.json();
  assert.equal(installation.status, "enabled");

  // File routes re-check the live Release and installation on every request.
  assert.equal(
    (
      await fetch(`${origin}/files/content?path=/welcome.txt`, {
        method: "PUT",
        headers: auth,
        body: "must not write",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${origin}/files/content?path=/welcome.txt`, {
        method: "PUT",
        headers: { ...auth, "X-Oyster-Installation": "notes" },
        body: "from the capability slot",
      })
    ).status,
    204,
  );

  // 5. App API methods, as an Agent or script calls them.
  const call = (name, input) =>
    fetch(`${origin}/apps/notes/methods/${name}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  assert.deepEqual(await (await call("readNote", {})).json(), { text: null });
  const keyResponse = await fetch(`${origin}/api/proof-key`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(
    keyResponse.status,
    201,
    "owner can issue the local named Agent credential",
  );
  const { plaintext: agentKey } = z
    .object({
      key: z.object({
        name: z.literal("contest-agent"),
        createdAt: z.number(),
      }),
      plaintext: z.string().startsWith("oyk_"),
    })
    .parse(await keyResponse.json());
  assert.equal(
    (
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer oyk_unknown_local_credential" },
      })
    ).status,
    401,
  );
  const agentAuth = { Authorization: `Bearer ${agentKey}` };
  assert.equal(
    (await fetch(`${origin}/api/installations`, { headers: agentAuth })).status,
    403,
  );
  await proveMcp(
    origin,
    agentKey,
    async () => await (await call("readNote", {})).json(),
  );
  assert.deepEqual(await (await call("readNote", {})).json(), {
    text: "via mcp",
  });
  // The App UI reads the same state written by the MCP Agent.
  const mcpBrowser = await chromium.launch();
  try {
    const page = await mcpBrowser.newPage();
    await page.goto(`${origin}/login`);
    await page.fill("input[name=key]", key);
    await page.click("button");
    await page.waitForURL(`${origin}/`);
    await page.click("a[href='/apps/notes/']");
    const app = page.frameLocator("#oyster-app");
    await app.locator("#status").filter({ hasText: "Connected" }).waitFor();
    assert.equal(await app.locator("#note").inputValue(), "via mcp");
    if (process.env.OYSTER_MCP_SHOTS) {
      await mkdir(process.env.OYSTER_MCP_SHOTS, { recursive: true });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          animations: "disabled",
          path: `${process.env.OYSTER_MCP_SHOTS}/oyster-mcp-${width}.png`,
        });
      }
    }
  } finally {
    await mcpBrowser.close();
  }
  assert.deepEqual(
    await (await call("saveNote", { text: "from methods" })).json(),
    {
      saved: true,
    },
  );
  assert.deepEqual(await (await call("readNote", {})).json(), {
    text: "from methods",
  });
  // A method the Release never declared is refused by the App gate before
  // the Instance runs any guest code.
  const undeclared = await call("dropTables", {});
  assert.equal(undeclared.status, 403);
  assert.deepEqual(await undeclared.json(), { error: "not_declared" });

  // 6. The UI's backend route.
  const backend = await fetch(`${origin}/apps/notes/backend`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "text/plain" },
    body: JSON.stringify({ method: "readNote", input: {} }),
  });
  assert.deepEqual(await backend.json(), { text: "from methods" });
  for (const name of [
    "Set-Cookie",
    "Clear-Site-Data",
    "Service-Worker-Allowed",
    "Content-Security-Policy-Report-Only",
  ]) {
    assert.equal(backend.headers.get(name), null, `guest controlled ${name}`);
  }
  assert.equal(
    backend.headers.get("Content-Security-Policy"),
    "sandbox; default-src 'none'",
  );

  // 7. UI delivery is digest-pinned and sandboxed.
  const document = await fetch(`${origin}/ui/notes/rel_notes1/`);
  assert.equal(document.status, 200);
  assert.match(
    document.headers.get("content-security-policy"),
    /sandbox allow-scripts/,
  );
  assert.equal((await fetch(`${origin}/ui/notes/rel_other/`)).status, 404);

  // 8. A person signs in and uses the App in a browser.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const capture = async (view) => {
      if (!process.env.OYSTER_STATUS_SHOTS) return;
      await mkdir(process.env.OYSTER_STATUS_SHOTS, { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        animations: "disabled",
        path: `${process.env.OYSTER_STATUS_SHOTS}/oyster-${runtime}${view}.png`,
      });
    };
    await page.goto(`${origin}/login`);
    await page.fill("input[name=key]", key);
    await page.click("button");
    await page.waitForURL(`${origin}/`);
    await page.click("a[href='/apps/notes/']");
    const app = page.frameLocator("#oyster-app");
    await app.locator("#status").filter({ hasText: "Connected" }).waitFor();
    assert.equal(await app.locator("#note").inputValue(), "from methods");
    await app.locator("#read-file").click();
    await app
      .locator("#file")
      .filter({ hasText: "from the capability slot" })
      .waitFor();
    await app.locator("#note").fill("from the browser");
    await app.locator("#save").click();
    await app.locator("#status").filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(await (await call("readNote", {})).json(), {
      text: "from the browser",
    });

    // App menus, the command chord and status items belong to the picked
    // shell (Tourtois), not the plain host page. Their proofs live with that
    // shell: apps/tourtois test/focused-app-menus.test.tsx and
    // test/shell-keys.test.tsx, and bonsai test:tourtois-home on a real Oyster.
    assert.equal(
      await page.getByRole("button", { name: "File", exact: true }).count(),
      0,
      "the plain host page renders no shell menu bar",
    );
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+K" : "Control+K",
    );
    assert.equal(
      await page.getByRole("dialog", { name: "Keys", exact: true }).count(),
      0,
      "the plain host page owns no command chord",
    );
    await capture("");
  } finally {
    await browser.close();
  }

  // 9. Delete purges the App's state.
  assert.equal(
    (
      await fetch(`${origin}/api/installations/notes`, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
    204,
  );
  assert.equal((await call("readNote", {})).status, 404);
  console.log(
    `standalone Oyster on ${runtime}: install, named-key MCP approval + owner-admin denial, App UI MCP readback, methods, backend, capability file read and delete passed`,
  );
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  await rm(work, { recursive: true, force: true });
}
