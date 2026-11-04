/* global fetch, AbortSignal, console, Headers, URL */
// A page on a separate loopback origin embeds a self-hosted Oyster's website
// chat. The owner adds the website in Oyster's own Settings and copies its
// snippet from there; a visitor chats with the Agent through the real edge and
// website Agent in local workerd; the owner then reads the transcript.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";
import { build } from "esbuild";
import { chromium } from "playwright";
import { launchIsolatedChromium } from "../../../../tooling/proof-runner/isolated-chromium.mjs";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const shots = `${repository}.botanical/shots`;
await mkdir(shots, { recursive: true });
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/website-channel-`);

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const workerPort = await freePort();
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const ownerKey = ["fixture", "owner", "word"].join("-").padEnd(30, "o");
let child;
let output = "";
const servers = [];

/**
 * The launcher lives in a closed shadow root, so it is found through the
 * accessibility tree, as a person's assistive technology finds it.
 */
async function openChat(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  await page.locator("[data-fungi-embed]").waitFor({ state: "attached" });
  let backendNodeId;
  for (
    let attempt = 0;
    attempt < 40 && backendNodeId === undefined;
    attempt++
  ) {
    const tree = await cdp.send("Accessibility.getFullAXTree");
    backendNodeId = tree.nodes.find(
      (node) =>
        node.role?.value === "button" && node.name?.value === "Open chat",
    )?.backendDOMNodeId;
    if (backendNodeId === undefined) await delay(250);
  }
  assert.ok(backendNodeId, "The launcher never offered Open chat");
  const mounted = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame.url().startsWith(`${workerOrigin}/embed/v1/s/`),
    timeout: 15_000,
  });
  await cdp.send("DOM.focus", { backendNodeId });
  await page.keyboard.press("Enter");
  return mounted;
}
/** Pages kept so a failure can say what the browser showed. */
const failurePages = [];
let passed = false;

try {
  await writeFile(
    `${work}/wrangler.json`,
    JSON.stringify({
      name: "oyster-website-channel-browser-proof",
      main: `${root}test/standalone/website-channel.browser.fixture.ts`,
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        OYSTER_ORIGIN: workerOrigin,
        OYSTER_OWNER_NAME: "owner",
        OWNER_KEY: ownerKey,
        OYSTER_WEBSITE_PROOF_KEY: ["fixture", "proof"]
          .join("-")
          .padEnd(40, "p"),
        OYSTER_WEBSITE_ADDRESS_KEY: ["fixture", "address"]
          .join("-")
          .padEnd(40, "a"),
      },
      durable_objects: {
        bindings: [
          { name: "AGENTS", class_name: "FixtureAgent" },
          { name: "AGENT_DIRECTORY", class_name: "AgentDirectory" },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["FixtureAgent", "AgentDirectory"],
        },
      ],
    }),
  );
  child = spawn(
    `${repository}node_modules/.bin/wrangler`,
    [
      "dev",
      "--config",
      `${work}/wrangler.json`,
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--persist-to",
      `${work}/state`,
    ],
    {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: work, XDG_CONFIG_HOME: `${work}/config` },
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      output += bytes.toString();
    });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Worker stopped during startup: ${output.slice(-3500)}`);
    try {
      ready =
        (
          await fetch(`${workerOrigin}/health`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).status === 200;
    } catch (cause) {
      // workerd is still starting; the last refusal is kept if it never does.
      if (attempt === 119)
        throw new Error(`Worker did not start: ${output.slice(-3500)}`, {
          cause,
        });
    }
    if (!ready) await delay(500);
  }
  assert.ok(ready, `Worker did not start: ${output.slice(-3500)}`);
  const seeded = await fetch(`${workerOrigin}/__fixture/seed`, {
    signal: AbortSignal.timeout(10_000),
  });
  const seededText = await seeded.text();
  console.log("seed", seededText);
  assert.equal(seeded.status, 200, seededText);
  const directory = await fetch(`${workerOrigin}/api/websites`, {
    headers: { authorization: `Bearer ${ownerKey}` },
  });
  console.log("directory", directory.status, await directory.text());

  // The owner's Settings is the production entry, bundled from source.
  const bundle = await build({
    stdin: {
      contents: `
        import { mountPlatformControls } from "./apps/tourtois/src/oyster-platform-controls.tsx";
        import { keyWire } from "./packages/ear-tag/src/keys.ts";
        import { oysterKeyVocabulary } from "./packages/oyster/src/keys.ts";
        const mounted = await mountPlatformControls(document.getElementById("controls"), {
          teamId: "fixture",
          keysWire: keyWire(oysterKeyVocabulary),
          requestAppAccess: () => Promise.resolve("declined"),
        });
        globalThis.openChannels = () =>
          mounted.controls.openSettings({ category: "channels" });
        document.documentElement.dataset.ready = "true";
      `,
      resolveDir: repository,
      loader: "js",
    },
    bundle: true,
    format: "esm",
    write: false,
    outdir: `${work}/owner`,
    loader: {
      ".woff2": "file",
      ".woff": "file",
      ".svg": "file",
      ".png": "file",
    },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const files = new Map(
    bundle.outputFiles.map((file) => [
      file.path.slice(`${work}/owner`.length),
      file.contents,
    ]),
  );
  // The owner's origin is the Oyster's own host as the browser sees it: pages
  // and assets here, owner requests relayed to the worker with the owner key.
  const ownerServer = createHttpServer(async (request, response) => {
    const path = new URL(request.url, "http://owner").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stdin.css"><div id="controls"></div><script type="module" src="/stdin.js"></script>',
      );
      return;
    }
    const file = files.get(path);
    if (file !== undefined) {
      response.writeHead(200, {
        "content-type": path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "text/javascript"
            : "application/octet-stream",
      });
      response.end(file);
      return;
    }
    if (path.startsWith("/api/websites")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers({
        authorization: `Bearer ${ownerKey}`,
        "content-type": request.headers["content-type"] ?? "application/json",
      });
      if (request.headers["x-request-id"])
        headers.set("x-request-id", request.headers["x-request-id"]);
      const relayed = await fetch(`${workerOrigin}${request.url}`, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : Buffer.concat(chunks),
      });
      response.writeHead(relayed.status, {
        "content-type": relayed.headers.get("content-type") ?? "text/plain",
      });
      response.end(Buffer.from(await relayed.arrayBuffer()));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => ownerServer.listen(0, "127.0.0.1", resolve));
  servers.push(ownerServer);
  const ownerOrigin = `http://127.0.0.1:${ownerServer.address().port}`;

  let snippet = "";
  const siteServer = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fern and Frond</title><body style="font-family:sans-serif"><h1>Fern and Frond</h1><p>Ask us about plants.</p>${snippet}</body>`,
    );
  });
  await new Promise((resolve) => siteServer.listen(0, "127.0.0.1", resolve));
  servers.push(siteServer);
  const siteOrigin = `http://127.0.0.1:${siteServer.address().port}`;

  const browser = await launchIsolatedChromium(chromium, [
    workerPort,
    ownerServer.address().port,
    siteServer.address().port,
  ]);
  try {
    const owner = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    failurePages.push(owner);
    owner.on("pageerror", (error) => {
      throw error;
    });
    await owner.goto(`${ownerOrigin}/`);
    await owner.locator("html[data-ready=true]").waitFor();
    await owner.evaluate(() => globalThis.openChannels());
    await owner.getByRole("heading", { name: "Channels" }).waitFor();
    await owner.getByRole("button", { name: "Add website" }).click();
    await owner.getByLabel("Website address").fill(siteOrigin);
    await owner
      .getByLabel("What should the Agent do here?")
      .fill("Help shoppers pick a fern. Keep answers short.");
    await owner.getByRole("button", { name: "Add website" }).last().click();
    await owner
      .getByRole("button", { name: /^Close Fern on / })
      .waitFor({ timeout: 15_000 });
    const embedded = await owner
      .locator('[aria-label="Embed snippet for Fern"] code')
      .innerText();
    assert.match(embedded, new RegExp(`src="${workerOrigin}/embed/v1.js"`));
    assert.match(embedded, /data-site="site_pk_/u);
    snippet = embedded;

    // The owner's Website view, in both themes and widths.
    // The guide above, then the controls and conversations below it.
    const captureOwner = async (name) => {
      await owner.screenshot({ path: `${shots}/owner-website-${name}.png` });
      await owner
        .getByRole("heading", { name: "Conversations" })
        .scrollIntoViewIfNeeded();
      await owner.screenshot({
        path: `${shots}/owner-website-controls-${name}.png`,
      });
      await owner
        .getByRole("heading", { name: "Add it to your website" })
        .or(owner.getByRole("heading", { name: "3. Install and test chat" }))
        .scrollIntoViewIfNeeded();
    };
    for (const scheme of ["light", "dark"]) {
      await owner.emulateMedia({ colorScheme: scheme });
      for (const width of [1440, 390]) {
        await owner.setViewportSize({ width, height: 900 });
        await delay(300);
        await captureOwner(`${width}-${scheme}`);
      }
    }
    await owner.emulateMedia({ colorScheme: "light" });
    await owner.setViewportSize({ width: 1440, height: 900 });

    // A visitor, on the separate origin, chats through the copied snippet.
    for (const scheme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        failurePages.push(page);
        page.on("console", (message) => {
          console.error("site console:", message.text());
        });
        page.on("pageerror", (error) => {
          throw error;
        });
        await page.goto(siteOrigin);
        const frame = await openChat(page);
        await frame
          .getByText("Send a message to Fern.")
          .waitFor({ timeout: 15_000 });
        const message = `Which fern suits a dim room? (${scheme} ${String(width)})`;
        await frame.getByRole("textbox").fill(message);
        await frame.getByRole("button", { name: "Send message" }).click();
        await frame
          .getByText("Ferns like bright, indirect light.")
          .waitFor({ timeout: 30_000 });
        await page.screenshot({
          path: `${shots}/widget-${width}-${scheme}.png`,
        });
        await context.close();
      }
    }

    // The owner reads what the visitors said, from the same Settings.
    await owner.reload();
    await owner.locator("html[data-ready=true]").waitFor();
    await owner.evaluate(() => globalThis.openChannels());
    await owner.getByRole("button", { name: /^Set up Fern on / }).click();
    await owner.getByRole("button", { name: "Show conversations" }).click();
    await owner
      .getByRole("button", { name: /^Read transcript of / })
      .first()
      .click();
    const transcript = owner.getByRole("list", { name: "Transcript" });
    await transcript.waitFor();
    const text = await transcript.innerText();
    assert.match(text, /Visitor: Which fern suits a dim room\?/u);
    assert.match(text, /Agent: Ferns like bright, indirect light\./u);
    assert.doesNotMatch(text, /OWNER-ONLY BRIEF/u);
    await transcript.scrollIntoViewIfNeeded();
    await owner.screenshot({
      path: `${shots}/owner-transcript-1440-light.png`,
    });
    await owner.setViewportSize({ width: 390, height: 900 });
    await transcript.scrollIntoViewIfNeeded();
    await owner.screenshot({ path: `${shots}/owner-transcript-390-light.png` });

    // A visitor's token opens no owner route.
    const key = /data-site="([^"]+)"/u.exec(embedded)?.[1];
    const minted = await fetch(
      `${workerOrigin}/api/embed/v1/sites/${key}/visitors`,
      {
        method: "POST",
        headers: { origin: workerOrigin, "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(minted.status, 201);
    const { accessToken } = await minted.json();
    for (const path of ["/api/websites", "/api/websites/chb_x/conversations"]) {
      const refused = await fetch(`${workerOrigin}${path}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.equal(refused.status, 401, path);
    }
    console.log(
      "website chat: owner added the site, a visitor on another origin chatted, the owner read the transcript PASS",
    );
    passed = true;
  } finally {
    if (!passed)
      for (const page of failurePages.filter((open) => !open.isClosed())) {
        console.error("page text:", await page.locator("body").innerText());
        await page.screenshot({ path: `${shots}/failure.png` });
      }
    await browser.close();
  }
} catch (error) {
  console.error("website channel browser proof failed", error);
  console.error(output.slice(-4500));
  process.exitCode = 1;
} finally {
  for (const server of servers) server.close();
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(3_000),
    ]);
  }
  await rm(work, { recursive: true, force: true });
}
