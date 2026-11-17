// End-to-end proof of the standalone Oyster: pack the Notes example App,
// start the standalone Worker with `wrangler dev`, install the Release over
// HTTP, call its methods and backend, and drive its UI in a browser.
//
//   node test/standalone.native.mjs                 # workerd (wrangler dev)
//   CELLD_PLATFORM_CELLD=$(…/pinned-celld.sh) \
//     node --import …/wrangler-on-celld.mjs test/standalone.native.mjs  # celld
/* global URL, URLSearchParams, fetch, setTimeout, console, process, AbortSignal */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  launchIsolatedChromium,
  portsOf,
} from "../../../tooling/proof-runner/isolated-chromium.mjs";
import { parseArgs } from "node:util";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { z } from "zod";
import { installRelease, packRelease } from "../dist/pack.js";
import { installationSchema } from "../dist/apps/installation.js";
import { installationOperationSchema } from "../dist/installation-operations.js";
import { observeInstallation } from "../dist/installation-client.js";
import { proveMcp } from "./mcp.native.mjs";
import { ApprovalViewSchema } from "@fungi.computer/approvals";
import * as Schema from "effect/Schema";

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
// The production-alarm witness is Worker console output. The maintained celld
// adapter hides it by default; request its ordinary logs, not a new proof door.
if (runtime === "celld") process.env.CELLD_PLATFORM_LOGS = "1";
let passed = false;

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
// A pinned build may be prepared before entering the runtime's private network.
// It still passes the normal installer/artifact verification below.
const prebuilt = parseArgs({
  options: { "release-directory": { type: "string" } },
}).values["release-directory"];
const releaseDirectory = prebuilt ?? work + "/release";
const release =
  prebuilt === undefined
    ? (
        await packRelease({
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
          outDirectory: releaseDirectory,
        })
      ).release
    : Schema.decodeUnknownSync(Schema.fromJsonString(releaseSchema))(
        await readFile(releaseDirectory + "/release.json", "utf8"),
      );
assert.equal(release.appId, "app_notes");
assert.equal(release.releaseId, "rel_notes1");
assert.equal(release.artifact.provenance.sourceRevision, sourceRevision);

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
    directory: releaseDirectory,
    url: origin,
    key,
    installationId: "notes",
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  const installation = installationSchema.parse(await installed.json());
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
  // The owner's own writes use the same durable policy, not a special
  // pre-approved-key bypass or an outer inline confirmation prompt.
  await proveMcp(
    origin,
    key,
    async () => await (await call("readNote", {})).json(),
  );
  // The actual MCP writes above reached the real App backend. Even under
  // auto-approve it must have produced a durable record in the host home.
  const approvalResponse = await fetch(origin + "/api/proof-approvals", {
    headers: auth,
  });
  assert.equal(approvalResponse.status, 200);
  const approvals = Schema.decodeUnknownSync(
    Schema.Struct({
      items: Schema.Array(ApprovalViewSchema),
      nextCursor: Schema.NullOr(Schema.String),
    }),
  )(await approvalResponse.json());
  const policyActions = approvals.items.filter(
    ({ record }) =>
      record.module === "oyster-app:notes" && record.operation === "saveNote",
  );
  assert.equal(
    policyActions.length,
    6,
    "The key and owner each perform three actual native writes with distinct durable records",
  );
  assert.equal(
    new Set(policyActions.map(({ record }) => record.recordId)).size,
    6,
  );
  for (const { record } of policyActions) {
    assert.equal(record.state, "applied");
    assert.deepEqual(record.by, { kind: "policy" });
  }

  // The App UI reads the same state written by the MCP Agent.
  const mcpBrowser = await launchIsolatedChromium(chromium, portsOf(origin));
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

  // 6. Arbitrary guest HTTP cannot overwrite host browser state. UI state is
  // read through the admitted named-method route above, not an App-made caller.
  const backend = await fetch(`${origin}/apps/notes/backend`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "text/plain" },
    body: JSON.stringify({ method: "readNote", input: {} }),
  });
  assert.deepEqual(await backend.json(), { probe: "guest headers" });
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
  const browser = await launchIsolatedChromium(chromium, portsOf(origin));
  let copyBackendUrl = "";
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
    // test/shell-keys.test.tsx, and the Oyster capture:tourtois-home review on a real Oyster.
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

    // Recovery is a host page/form, even with every App and Shell asset blocked.
    // Rollback changes code selection, not the live App facet's SQLite.
    const nextDirectory = `${work}/recovery-release`;
    await cp(releaseDirectory, nextDirectory, { recursive: true });
    await writeFile(
      `${nextDirectory}/release.json`,
      JSON.stringify({ ...release, releaseId: "rel_notes2" }),
    );
    const upgraded = await installRelease({
      directory: nextDirectory,
      url: origin,
      key,
      installationId: "notes",
    });
    assert.equal(upgraded.status, 200, await upgraded.clone().text());
    const selected = installationSchema.parse(await upgraded.json());
    assert.equal(selected.instanceId, installation.instanceId);
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === origin && url.pathname.startsWith("/recovery")
        ? route.continue()
        : route.abort();
    });
    await page.goto(`${origin}/recovery`);
    assert.equal(
      await page.getByRole("heading", { level: 1 }).textContent(),
      "App recovery",
    );
    await page.getByRole("link", { name: "Roll back", exact: true }).click();
    await page.getByRole("button", { name: "Roll back", exact: true }).click();
    await page.waitForURL(`${origin}/recovery?requestId=*`);
    const requestId = new URL(page.url()).searchParams.get("requestId");
    assert.ok(requestId, "The form redirects to its correlated observation");
    const signal = AbortSignal.timeout(20_000);
    const outcome = await observeInstallation({
      requestId,
      initial: null,
      signal,
      read: async () => {
        const response = await fetch(
          `${origin}/api/installations/notes/status?${new URLSearchParams({ requestId }).toString()}`,
          { headers: auth, signal },
        );
        assert.equal(response.status, 200);
        return installationOperationSchema.parse(await response.json());
      },
    });
    assert.equal(outcome.state, "succeeded");
    assert.equal(outcome.installation?.release.releaseId, release.releaseId);
    assert.equal(outcome.installation?.instanceId, installation.instanceId);
    assert.equal(
      outcome.installation?.authority.authorityVersion,
      selected.authority.authorityVersion + 1,
    );
    await page.getByRole("link", { name: "Check again" }).click();
    await page.getByText("Rolled back notes").waitFor();
    assert.deepEqual(await (await call("readNote", {})).json(), {
      text: "from the browser",
    });
    console.log(
      `standalone Oyster on ${runtime}: host form rollback preserves the Instance and native App SQLite, without App/Shell assets`,
    );

    // Even with every App/Shell asset still blocked, the owner can create and
    // discard the native sibling through ordinary host-owned forms.
    const oldCreation = new URLSearchParams({
      requestId: await page
        .locator(
          'form[action="/recovery/notes/test-copy"] input[name=requestId]',
        )
        .inputValue(),
      authorityVersion: await page
        .locator(
          'form[action="/recovery/notes/test-copy"] input[name=authorityVersion]',
        )
        .inputValue(),
      storeGeneration: await page
        .locator(
          'form[action="/recovery/notes/test-copy"] input[name=storeGeneration]',
        )
        .inputValue(),
    });
    await page
      .getByRole("button", { name: "Open test copy", exact: true })
      .click();
    await page.waitForURL(`${origin}/recovery/notes/test-copy/*`);
    const oldCopyUrl = page.url();
    const oldDiscard = new URLSearchParams({
      copyId: await page.locator("input[name=copyId]").inputValue(),
      authorityVersion: await page
        .locator("input[name=authorityVersion]")
        .inputValue(),
      storeGeneration: await page
        .locator("input[name=storeGeneration]")
        .inputValue(),
    });
    assert.equal(
      await page.getByRole("button", { name: "Discard test copy" }).count(),
      1,
    );
    await page.getByRole("button", { name: "Discard test copy" }).click();
    await page.waitForURL(`${origin}/recovery`);
    await page.unroute("**/*");
    await page.route("**/ui-entry/**", (route) => route.abort());

    // The ordinary App mount connects to the sibling doors, not the live
    // backend or editable Shell. Its SQLite writes never promote into live data.
    await page
      .getByRole("button", { name: "Open test copy", exact: true })
      .click();
    await page.waitForURL(`${origin}/recovery/notes/test-copy/*`);
    await app.locator("#status").filter({ hasText: "Connected" }).waitFor();
    assert.equal(await app.locator("#note").inputValue(), "from the browser");
    await app.locator("#note").fill("only in the test copy");
    await app.locator("#save").click();
    await app.locator("#status").filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(await (await call("readNote", {})).json(), {
      text: "from the browser",
    });
    const discardedCopy = `${page.url()}/backend`;
    await page.getByRole("button", { name: "Discard test copy" }).click();
    await page.waitForURL(`${origin}/recovery`);
    const readDiscarded = await fetch(discardedCopy, {
      method: "PUT",
      headers: { ...auth, Origin: origin, "Content-Type": "text/plain" },
      body: JSON.stringify({ method: "readNote", input: {} }),
    });
    assert.equal(readDiscarded.status, 403);
    const replayed = await fetch(`${origin}/recovery/notes/test-copy`, {
      method: "POST",
      headers: { ...auth, Origin: origin },
      body: oldCreation,
      redirect: "manual",
    });
    assert.equal(replayed.status, 303);
    const replayLocation = replayed.headers.get("Location");
    assert.ok(replayLocation);
    assert.notEqual(new URL(replayLocation, origin).href, oldCopyUrl);
    assert.equal(
      (
        await fetch(`${oldCopyUrl}/discard`, {
          method: "POST",
          headers: { ...auth, Origin: origin },
          body: oldDiscard,
          redirect: "manual",
        })
      ).status,
      303,
    );
    await page.goto(new URL(replayLocation, origin).href);
    await app.locator("#status").filter({ hasText: "Connected" }).waitFor();
    assert.equal(await app.locator("#note").inputValue(), "from the browser");
    copyBackendUrl = `${page.url()}/backend`;
    const copyMethod = (name, input) =>
      fetch(`${page.url()}/methods/${name}`, {
        method: "POST",
        headers: {
          ...auth,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    const typedRead = await copyMethod("readNote", {});
    assert.equal(typedRead.status, 200, await typedRead.clone().text());
    assert.deepEqual(await typedRead.json(), { text: "from the browser" });
    assert.equal((await copyMethod("saveNote", { text: 1 })).status, 400);
    assert.equal((await copyMethod("constructor", {})).status, 403);
    const typedWrite = await copyMethod("saveNote", {
      text: "from the typed copy",
    });
    assert.equal(typedWrite.status, 200, await typedWrite.clone().text());
    assert.deepEqual(await (await copyMethod("readNote", {})).json(), {
      text: "from the typed copy",
    });
    assert.deepEqual(await (await call("readNote", {})).json(), {
      text: "from the browser",
    });
    console.log(
      `standalone Oyster on ${runtime}: host forms without App/Shell assets, interactive native sibling reads/writes, unchanged live SQLite, discard and fresh sibling passed`,
    );

    // No copy observation/request during either wait: only the actual
    // production owner's alarm can publish these read-only fixture receipts.
    const expiryCopyId = new URL(page.url()).pathname.split("/").at(-1);
    assert.ok(expiryCopyId);
    const earlyDeadline = Date.now() + 20_000;
    while (
      !output.includes(`Oyster native copy alarm active ${expiryCopyId}`)
    ) {
      assert.ok(
        Date.now() < earlyDeadline,
        "Production copy admission must preserve the independent earlier wake",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const expiryDeadline = Date.now() + 5 * 60 * 1_000 + 20_000;
    while (
      !output.includes(`Oyster native copy alarm closed ${expiryCopyId}`)
    ) {
      assert.ok(
        Date.now() < expiryDeadline,
        "Production shared alarm must retire the copy at its fixed deadline",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(
      (
        await fetch(copyBackendUrl, {
          method: "PUT",
          headers: { ...auth, Origin: origin, "Content-Type": "text/plain" },
          body: JSON.stringify({ method: "readNote", input: {} }),
        })
      ).status,
      403,
    );
    console.log(
      `standalone Oyster on ${runtime}: production shared alarm preserved the early wake, re-armed the fixed lifetime and retired the idle copy`,
    );

    // Keep the existing deletion proof on a fresh, still-active sibling.
    await page.goto(`${origin}/recovery`);
    await page
      .getByRole("button", { name: "Open test copy", exact: true })
      .click();
    await page.waitForURL(`${origin}/recovery/notes/test-copy/*`);
    copyBackendUrl = `${page.url()}/backend`;
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
  assert.equal(
    (
      await fetch(copyBackendUrl, {
        method: "PUT",
        headers: { ...auth, Origin: origin, "Content-Type": "text/plain" },
        body: JSON.stringify({ method: "readNote", input: {} }),
      })
    ).status,
    404,
    "deleted owners cannot reach a retained copy",
  );
  console.log(
    `standalone Oyster on ${runtime}: install, named-key MCP approval + owner-admin denial, App UI MCP readback, methods, backend, capability file read and delete passed`,
  );
  passed = true;
} finally {
  wrangler.kill("SIGTERM");
  await stopped;
  if (passed) await rm(work, { recursive: true, force: true });
  else {
    await writeFile(`${work}/worker.log`, output.replaceAll(key, "[redacted]"));
    console.error("Native proof state preserved at " + work);
  }
}
