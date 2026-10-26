import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
// Real standalone root, immutable captured Tourtois composed as the trusted
// top-level shell, and each child App's sandboxed frame inside its window.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { TextEncoder, promisify } from "node:util";
import { log } from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { build } from "esbuild";
import { parse } from "jsonc-parser";
import { chromium, expect } from "playwright/test";
import { Schema } from "effect";
import {
  appStorageReadResultSchema,
  appStorageMutationResultSchema,
} from "@fungi.computer/agar/storage-wire";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { sha256 } from "@fungi.computer/oyster/host";
import { installOnOyster } from "../../dist/installation-client.js";
import { createAppBuild } from "@fungi.computer/puffball/app";
import {
  workbenchDirectorySchema,
  workbenchComputerDirectorySchema,
} from "@fungi.computer/nacre/workbench-directory";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { labComputer } from "./lab-computer.fixture.mjs";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const work = `${root}.botanical/tourtois-home`;
const shots = process.env.OYSTER_HOME_SHOTS;
const appSet = process.env.OYSTER_PROOF_APP_SET === "1";
const gillProof = process.env.OYSTER_PROOF_GILLS === "1";
const shellFork = process.env.OYSTER_PROOF_SHELL_FORK === "1";
assert.ok(shots, "Set OYSTER_HOME_SHOTS to the review screenshot directory");
await mkdir(work, { recursive: true });
const state = await mkdtemp(`${work}/state-`);
await mkdir(shots, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const releaseDirectory = `${work}/release-${revision}`;
const packedPath = `${work}/release-${revision}.json`;
let packed;
if (!appSet)
  try {
    packed = JSON.parse(await readFile(packedPath, "utf8"));
    assert.equal(packed.revision, revision, "Cached Release must match source");
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    const tourtois = standaloneAppSet.find(
      (app) => app.installationId === "tourtois",
    );
    assert.ok(tourtois);
    const result = await packRelease({
      appId: "app_tourtois",
      sourceDirectory: repository,
      sourceRevision: `git:${revision}`,
      packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      recipe: committedAppRecipe(repository, tourtois, revision),
      outDirectory: releaseDirectory,
    });
    packed = { revision, ...result };
    await writeFile(packedPath, JSON.stringify(packed));
  }
// The App set is built by the Oyster itself: from each App's published
// source, on the claimed lab Computer, with the production root over the
// native Git provider (as the app-build native proof runs it).
const lab = appSet ? await labComputer() : null;
const provider = appSet ? await workflowGitProvider() : null;
const config = parse(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = appSet
  ? `${root}test/standalone/landed-push-root.fixture.ts`
  : `${root}src/standalone/worker.ts`;
// The proof gives release bytes and App-owned blobs separate local buckets.
// Celld requires a distinct bucket for each binding, unlike Wrangler aliases.
config.r2_buckets = config.r2_buckets.map((bucket) => ({
  ...bucket,
  bucket_name: `bonsai-proof-${bucket.binding.toLowerCase().replaceAll("_", "-")}`,
}));
const configuration = `${work}/wrangler.json`;
await writeFile(configuration, JSON.stringify(config));
const key = randomBytes(24).toString("hex");
const port =
  lab?.port ??
  (await new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  }));
const labVars =
  lab === null || provider === null
    ? {}
    : { ...lab.vars, GIT_ORIGIN: provider.origin };
/** The owner key and lab Computer values never reach a log or artifact. */
const redact = (text) =>
  [key, ...Object.values(labVars)].reduce(
    (message, value) => message.replaceAll(value, "[REDACTED]"),
    String(text),
  );
const origin = `http://127.0.0.1:${port}`;
// The seeded tenant lives at an HTTPS origin. Wrangler presents loopback
// requests to the Worker at that origin, as TLS termination does in production.
const tenantHost = "oyster.test";
const headers = { Authorization: `Bearer ${key}` };
let worker;
let stopped;
let output = "";
async function stop() {
  if (!worker) return;
  worker.kill("SIGTERM");
  await stopped;
  worker = undefined;
}
async function start(home) {
  worker = spawn(
    `${root}node_modules/.bin/wrangler`,
    [
      "dev",
      "--config",
      configuration,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--local-upstream",
      tenantHost,
      "--upstream-protocol",
      "https",
      "--var",
      `OYSTER_OWNER_KEY:${key}`,
      "--var",
      `OYSTER_ORIGIN:https://${tenantHost}`,
      "--var",
      `OYSTER_HOME_INSTALLATION:${home}`,
      ...Object.entries(labVars).flatMap(([name, value]) => [
        "--var",
        `${name}:${value}`,
      ]),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  output = "";
  worker.stdout.on("data", (chunk) => {
    output += chunk;
  });
  worker.stderr.on("data", (chunk) => {
    output += chunk;
  });
  stopped = new Promise((resolve) => worker.once("exit", resolve));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = await globalThis.fetch(`${origin}/login`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) return;
    assert.ok(Date.now() < deadline, "Standalone root did not become ready");
    await delay(100);
  }
}
async function persist(bytes) {
  const digest = await sha256(bytes);
  const artifactRef = `artifact:sha256-${digest.slice(7)}`;
  const response = await globalThis.fetch(
    `${origin}/api/artifacts/${artifactRef}?digest=${digest}`,
    {
      method: "PUT",
      headers,
      body: bytes,
    },
  );
  assert.equal(response.status, 204, await response.text());
  return { artifactRef, digest, version: digest, byteLength: bytes.length };
}
async function installChild(installationId, displayName) {
  // Each load stamps a fresh token, so a reload is visible to the proof.
  const code = await build({
    stdin: {
      contents: `import React from 'react'; import {mountApp} from '@fungi.computer/agar/react'; const load = String(Math.random()).slice(2); mountApp(document.getElementById('root'),{name:${JSON.stringify(displayName)}},({app,status})=>React.createElement('main',{'data-child-ready':app!==null,'data-load':load,style:{minHeight:'100vh',margin:0,padding:'16px',boxSizing:'border-box',font:'16px system-ui',background:'#f3c96b',color:'#1d1d1d'}},app?${JSON.stringify(displayName)}:status));`,
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const ui = {
    ...(await persist(
      new TextEncoder().encode(
        `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module">${code.outputFiles[0].text}</script></body></html>`,
      ),
    )),
    mediaType: "text/html; charset=utf-8",
  };
  let backend = null;
  let declaration = {
    displayName,
    capabilities: [],
    handlers: [],
    roles: [],
    storage: [],
  };
  if (gillProof) {
    const fixture = await import("./gill-declaration.fixture.ts");
    declaration = fixture.gillDeclaration;
    const built = await build({
      entryPoints: [`${root}test/standalone/gill-facet.fixture.ts`],
      bundle: true,
      write: false,
      minify: true,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:*"],
      conditions: ["workerd", "worker", "browser"],
      target: "es2022",
    });
    backend = {
      ...(await persist(
        new TextEncoder().encode(
          JSON.stringify({
            runtime: { kind: "durable-facet", stateSchema: 1 },
            compatibilityDate: "2026-09-04",
            exportName: "SavedRows",
            code: built.outputFiles[0].text,
          }),
        ),
      )),
      mediaType: "application/vnd.fungi.app-backend+json",
    };
  }
  const artifact = await persist(
    new TextEncoder().encode(
      JSON.stringify(createAppBuild(ui, backend, declaration)),
    ),
  );
  const release = {
    appId: `app_${installationId}`,
    releaseId: `rel_${installationId}`,
    artifact: {
      artifactRef: artifact.artifactRef,
      artifactDigest: artifact.digest,
      provenance: {
        sourceRevision: `git:${revision}`,
        sourceTreeDigest: artifact.digest,
        buildRecipeDigest: artifact.digest,
      },
    },
  };
  const operation = await installOnOyster({
    url: origin,
    key,
    installationId,
    release,
  });
  assert.equal(operation.state, "succeeded", JSON.stringify(operation));
  assert.equal(operation.creation, "fresh");
}
const appFrameSandbox = "allow-scripts allow-modals allow-popups allow-forms";
const paneOf = (page, name) =>
  page.locator(`.tourtois-app-pane[aria-label="${name}"]`);
const childOf = (page, name) =>
  paneOf(page, name).frameLocator(".tourtois-pane-body iframe");
const loadOf = (page, name) =>
  childOf(page, name).locator("main").getAttribute("data-load");

/** Every App frame lives in its own window's slot; no overlay, no shield. */
async function assertFramesInWindows(page) {
  await expect(page.locator(".tourtois-pane-activation-shield")).toHaveCount(0);
  await expect(page.locator("#oyster-workbench-overlay")).toHaveCount(0);
  const homes = await page.evaluate(() =>
    Array.from(globalThis.document.querySelectorAll("iframe"), (frame) => ({
      inWindow:
        frame.closest(".tourtois-app-pane .tourtois-pane-body") !== null,
      sandbox: frame.getAttribute("sandbox"),
    })),
  );
  assert.ok(homes.length > 0, "An App frame must be mounted");
  for (const home of homes) {
    assert.equal(home.inWindow, true, "App frames live inside their windows");
    assert.equal(home.sandbox, appFrameSandbox);
  }
}

/** Launch an App from the desktop, or from the phone's App list. */
async function launchApp(page, name) {
  const openApps = page.getByRole("button", { name: "Open Apps", exact: true });
  if (await openApps.isVisible()) {
    await openApps.click();
    await page
      .getByRole("group", { name: "Team Apps", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  } else {
    await page
      .locator(".tourtois-gill-body")
      .getByRole("button", { name, exact: true })
      .click();
  }
}

/** Open a proof child App and wait for its own ready marker. */
async function openApp(page, name) {
  await launchApp(page, name);
  await expect(
    childOf(page, name).locator('[data-child-ready="true"]'),
  ).toHaveText(name);
}

/** The window status bar Tourtois renders from an App's own reports. */
const statusOf = (page, name) =>
  paneOf(page, name).getByLabel(`${name} status`, { exact: true });

/**
 * Each non-shell starter App's own settled content, read from that App's
 * current UI source. Where the App reports window status only once it is
 * connected to its host, that report is required too: a frame that merely
 * loaded, or an App still connecting, does not pass.
 */
const starterContent = {
  Bonsai: async (page, app) => {
    // HomePage's board mounts in main.bonsai-page; "Live" is Bonsai's own
    // window status once its live event stream connects (web/main.tsx).
    // The page must show its settled content, not just mount: a fresh
    // Oyster's "No repositories yet" or a repository tile (home-page.tsx).
    const home = app.locator("main.bonsai-page");
    await expect(home).toBeVisible();
    await expect(statusOf(page, "Bonsai")).toContainText("Live");
    await expect(
      home
        .getByRole("heading", { name: "No repositories yet", exact: true })
        .or(home.locator('[data-tile^="repo:"]').first()),
    ).toBeVisible();
    await expect(home.getByText("Loading repositories")).toHaveCount(0);
  },
  Shed: async (_page, app) => {
    // The Terminal region holds the light shell, or a state only a connected
    // Shed shows: its Computer's terminal is unavailable, the request for
    // Computer access, or a granted window with no Computer (shed-app.tsx).
    const terminal = app.getByRole("region", { name: "Terminal", exact: true });
    await expect(terminal).toBeVisible();
    await expect(
      terminal
        .locator(".terminal-host canvas")
        .or(terminal.getByText("Terminal unavailable", { exact: true }))
        .or(
          terminal.getByRole("button", {
            name: "Allow Computer access",
            exact: true,
          }),
        )
        .or(
          terminal.getByText("No Computer is attached to this window.", {
            exact: true,
          }),
        ),
    ).toBeVisible();
  },
  Inkcap: async (page, app) => {
    // InkcapView's editor landmark and tab bar (test/workbench.browser.mjs);
    // its open-file count is reported only through its host connection.
    const editor = app.getByRole("main", {
      name: "Inkcap editor",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await expect(
      editor
        .locator(".inkcap-tab-bar")
        .getByRole("button", { name: "New draft", exact: true }),
    ).toBeVisible();
    await expect(statusOf(page, "Inkcap")).toContainText(/\d+ open files?/u);
  },
  Workflows: async (_page, app) => {
    // A connected client renders the workspace, which settles on the loaded
    // library: its first-workflow prompt or an open editor (workspace.tsx).
    await expect(
      app.getByRole("tablist", { name: "Trellis", exact: true }),
    ).toBeVisible();
    await expect(
      app
        .getByRole("heading", {
          name: "Create your first workflow",
          exact: true,
        })
        .or(app.locator("main.wf-editor")),
    ).toBeVisible();
    await expect(
      app.getByText("Open Workflows from your Team to edit and run workflows."),
    ).toHaveCount(0);
  },
  Prints: async (_page, app) => {
    // The media pane settles its generation state past loading and its
    // gallery past "Loading prints…" (MediaPane.tsx).
    const media = app.locator('main[data-app-pane="media"]');
    await expect(media).toBeVisible();
    await expect(media).toHaveAttribute(
      "data-generation-state",
      /^(ready|unavailable)$/u,
    );
    await expect(
      media
        .getByText("Nothing printed yet.", { exact: true })
        .or(
          media.locator(".prints-gallery-content [data-media-source]").first(),
        ),
    ).toBeVisible();
  },
  Grove: async (page, app) => {
    // The inbox and its conversation list (inbox.tsx); its Agents control is
    // reported to the window only through its host connection.
    await expect(app.locator("main[data-inbox-app]")).toBeVisible();
    const list = app.locator("#grove-list-rail");
    await expect(list).toContainText("All Agents");
    // The Agent directory and the conversation list both settle past their
    // loading rows (inbox.tsx, inbox-list.tsx); a fresh Oyster then shows
    // its first-Agent invitation and, where the list column is open, its
    // empty list.
    await expect(
      list.getByText(/^Loading (Agents|conversations)…$/u),
    ).toHaveCount(0);
    await expect(
      app
        .getByRole("heading", { name: "No one's here yet.", exact: true })
        .or(app.locator(".inbox-row").first()),
    ).toBeVisible();
    if (await list.isVisible())
      await expect(
        list
          .getByText("No conversations yet.", { exact: true })
          .or(list.locator(".inbox-row").first()),
      ).toBeVisible();
    await expect(
      statusOf(page, "Grove").getByRole("button", {
        name: /^Agents( and conversations)?$/u,
      }),
    ).toBeVisible();
  },
};

/**
 * Open every installed starter App through Tourtois's own launcher, wait for
 * that App's real content in its window, keep an attributable screenshot,
 * then minimize it through the window's own control.
 */
async function proveStarterApps(page, shot) {
  for (const [name, settled] of Object.entries(starterContent)) {
    await launchApp(page, name);
    const pane = paneOf(page, name);
    await expect(pane).toBeVisible();
    await settled(page, childOf(page, name));
    await expect(pane.locator(".tourtois-app-loading")).toHaveCount(0);
    await expect(pane.locator(".tourtois-window-status")).toHaveCount(0);
    await assertFramesInWindows(page);
    await page.screenshot({
      path: `${shots}/starter-${name.toLowerCase()}-${shot}.png`,
    });
    await pane
      .getByRole("button", { name: `Minimize ${name}`, exact: true })
      .click();
    await expect(pane).toBeHidden();
  }
}

/** The real picker drives the host's JSON configuration, not a story catalog. */
async function proveFleetPicker(page, shot, configured, computers) {
  await restoreApp(page, "Shed");
  const picker = paneOf(page, "Shed").getByRole("button", {
    name: "Choose Computer for Shed",
    exact: true,
  });
  for (const [index, computer] of computers.entries()) {
    await expect(picker).toBeEnabled();
    await picker.click();
    for (const choice of [configured, ...computers])
      await expect(
        page.getByRole("option", { name: choice.name, exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole("option", {
        name: index === 0 ? configured.name : computers[index - 1].name,
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: `${shots}/native-fleet-picker-${String(index)}-${shot}.png`,
    });
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const target = new URL(candidate.url());
        return (
          target.pathname === "/apps/shed/" &&
          target.searchParams.get("computerId") === computer.computerId &&
          candidate.request().headers().accept === "application/json"
        );
      }),
      page.getByRole("option", { name: computer.name, exact: true }).click(),
    ]);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).computerId, computer.computerId);
    await starterContent.Shed(page, childOf(page, "Shed"));
    await expect(picker).toBeEnabled();
    await picker.click();
    await expect(
      page.getByRole("option", { name: computer.name, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: `${shots}/native-fleet-attached-${String(index)}-${shot}.png`,
    });
  }
  const unchanged = await globalThis.fetch(
    `${origin}/api/workbench/directory`,
    { headers },
  );
  assert.equal(unchanged.status, 200);
  assert.equal(
    workbenchDirectorySchema.parse(await unchanged.json()).computer?.computerId,
    configured.computerId,
    "Window picker choices must not mutate the durable default",
  );
}

/** Bring a running App back through the shell's own running-App control. */
async function restoreApp(page, name) {
  const switcher = page.getByRole("button", {
    name: "Switch open Apps",
    exact: true,
  });
  if (await switcher.isVisible()) {
    await switcher.click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  } else {
    await page
      .getByRole("group", { name: "Running apps", exact: true })
      .getByRole("button", { name, exact: true })
      .click({ position: { x: 3, y: 3 } });
  }
}

/** One rendered frame's geometry for a window and the App frame inside it. */
const windowSample = (page, name) =>
  page.evaluate(
    (title) =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => {
          const pane = globalThis.document.querySelector(
            `.tourtois-app-pane[aria-label="${title}"]`,
          );
          const frame = pane?.querySelector(".tourtois-pane-body iframe");
          if (!pane || !frame) throw new Error(`${title} window is missing`);
          const outer = pane.getBoundingClientRect();
          const inner = frame.getBoundingClientRect();
          resolve({
            x: outer.x,
            y: outer.y,
            offsetX: inner.x - outer.x,
            offsetY: inner.y - outer.y,
          });
        });
      }),
    name,
  );

/** Which window owns the topmost element at a point, by its title. */
const windowAt = (page, x, y) =>
  page.evaluate(
    ([px, py]) =>
      globalThis.document
        .elementFromPoint(px, py)
        ?.closest(".tourtois-app-pane")
        ?.getAttribute("aria-label") ?? null,
    [x, y],
  );

/**
 * The trusted-shell window laws: each App's sandboxed frame sits in its
 * window, so it drags in the same frame, clips to rounded corners under
 * overlap, stays below Tourtois menus, raises on a direct click, and keeps
 * its globalThis.document through minimize and restore.
 */
async function proveAppWindows(page, width, shot) {
  // Any App frame removed or re-inserted would reload that App: each frame
  // may enter the document once, when its window opens, and never leave.
  await page.evaluate(() => {
    const root = globalThis.document.documentElement;
    const moves = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records)
        for (const [kind, nodes] of [
          ["added", record.addedNodes],
          ["removed", record.removedNodes],
        ])
          for (const node of nodes)
            if (node instanceof globalThis.Element)
              for (const frame of node.matches("iframe")
                ? [node]
                : node.querySelectorAll("iframe"))
                moves.push(`${kind}:${frame.title}`);
      root.dataset.appFrameMoves = JSON.stringify(moves);
    }).observe(globalThis.document.body, { childList: true, subtree: true });
  });
  const frameMoves = async () =>
    JSON.parse(
      (await page.locator("html").getAttribute("data-app-frame-moves")) ?? "[]",
    );
  await openApp(page, "Proof App");
  await assertFramesInWindows(page);
  const firstLoad = await loadOf(page, "Proof App");
  assert.ok(firstLoad);

  // A Tourtois menu paints above the App frame it overlaps.
  await page
    .getByRole("button", { name: "Team and account menu", exact: true })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.evaluate((open) =>
    Promise.all(
      open.getAnimations({ subtree: true }).map((motion) => motion.finished),
    ),
  );
  const menuHit = await page.evaluate(() => {
    const open = globalThis.document.querySelector('[role="menu"]');
    const frame = globalThis.document.querySelector(
      ".tourtois-app-pane iframe",
    );
    if (!open || !frame) throw new Error("Menu or App frame is missing");
    const a = open.getBoundingClientRect();
    const b = frame.getBoundingClientRect();
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right - left < 8 || bottom - top < 8)
      return { overlap: false, menu: a.toJSON(), frame: b.toJSON() };
    const hit = globalThis.document.elementFromPoint(
      (left + right) / 2,
      (top + bottom) / 2,
    );
    return { overlap: true, inMenu: hit !== null && open.contains(hit) };
  });
  assert.equal(
    menuHit.overlap,
    true,
    `The menu must overlap the App for this proof: ${JSON.stringify(menuHit)}`,
  );
  assert.equal(menuHit.inMenu, true, "The Tourtois menu paints above the App");
  await page.screenshot({ path: `${shots}/menu-above-app-${shot}.png` });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  if (width === 1440) {
    await page.getByRole("button", { name: "Layout", exact: true }).click();
    await page
      .getByRole("menuitemcheckbox", { name: "Floating", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-layout-mode]")).toHaveAttribute(
      "data-layout-mode",
      "floating",
    );
    // Dragging moves the App frame with its window in every rendered frame.
    const handle = paneOf(page, "Proof App").locator(
      "[data-caps-window-handle]",
    );
    const box = await handle.boundingBox();
    assert.ok(box);
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = await windowSample(page, "Proof App");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const samples = [];
    for (const step of [1, 2, 3, 4]) {
      await page.mouse.move(start.x + step * 40, start.y + step * 25, {
        steps: 5,
      });
      samples.push(await windowSample(page, "Proof App"));
    }
    await page.mouse.up();
    const after = samples.at(-1);
    assert.ok(
      after.x - before.x > 100 && after.y - before.y > 60,
      `The window follows the pointer: ${JSON.stringify({ before, after })}`,
    );
    for (const sample of samples)
      assert.deepEqual(
        [sample.offsetX, sample.offsetY],
        [before.offsetX, before.offsetY],
        "The App frame moves with its window in the same rendered frame",
      );
    await page.screenshot({ path: `${shots}/drag-${shot}.png` });

    // A second window overlaps the first and clips to its rounded corners.
    await openApp(page, "Second App");
    await assertFramesInWindows(page);
    const first = await paneOf(page, "Proof App").boundingBox();
    const second = await paneOf(page, "Second App").boundingBox();
    assert.ok(first && second);
    const overlap = {
      x:
        (Math.max(first.x, second.x) +
          Math.min(first.x + first.width, second.x + second.width)) /
        2,
      y:
        (Math.max(first.y, second.y) +
          Math.min(first.y + first.height, second.y + second.height)) /
        2,
    };
    assert.equal(await windowAt(page, overlap.x, overlap.y), "Second App");
    await expect(paneOf(page, "Second App")).toHaveAttribute(
      "data-active",
      "true",
    );
    const clip = await paneOf(page, "Second App").evaluate((pane) => {
      const style = globalThis.getComputedStyle(pane);
      return {
        radius: Number.parseFloat(style.borderBottomRightRadius),
        overflow: style.overflow,
      };
    });
    assert.ok(clip.radius >= 4, `Windows are rounded: ${JSON.stringify(clip)}`);
    assert.match(clip.overflow, /hidden|clip/u);
    // The outermost corner pixel of the top window is outside its rounded
    // clip, so the window below shows through there.
    assert.equal(
      await windowAt(
        page,
        second.x + second.width - 1,
        second.y + second.height - 1,
      ),
      "Proof App",
      "The top window's App is clipped by its rounded corner",
    );
    await page.screenshot({ path: `${shots}/overlap-${shot}.png` });
    await page.screenshot({
      path: `${shots}/overlap-corner-${shot}.png`,
      clip: {
        x: second.x + second.width - 60,
        y: second.y + second.height - 60,
        width: 120,
        height: 120,
      },
    });

    // A direct click into the inactive App raises its window; no shield.
    await expect(paneOf(page, "Proof App")).toHaveAttribute(
      "data-active",
      "false",
    );
    const firstFrame = await paneOf(page, "Proof App")
      .locator(".tourtois-pane-body iframe")
      .boundingBox();
    assert.ok(firstFrame);
    const target = {
      x: firstFrame.x + firstFrame.width - 40,
      y: firstFrame.y + firstFrame.height - 40,
    };
    assert.ok(
      target.x > second.x + second.width || target.y > second.y + second.height,
    );
    assert.equal(await windowAt(page, target.x, target.y), "Proof App");
    await page.mouse.click(target.x, target.y);
    await expect(paneOf(page, "Proof App")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect
      .poll(() => windowAt(page, overlap.x, overlap.y))
      .toBe("Proof App");
    await page.screenshot({ path: `${shots}/raised-${shot}.png` });
  }

  // Minimize keeps the App's globalThis.document mounted; restore shows the same one.
  await paneOf(page, "Proof App")
    .getByRole("button", { name: "Minimize Proof App", exact: true })
    .click();
  await expect(paneOf(page, "Proof App")).toBeHidden();
  assert.equal(
    await page.evaluate(() =>
      Array.from(globalThis.document.querySelectorAll("iframe")).some(
        (frame) => frame.title === "Proof App" && frame.isConnected,
      ),
    ),
    true,
    "A minimized App stays mounted",
  );
  await page.screenshot({ path: `${shots}/minimized-${shot}.png` });
  await restoreApp(page, "Proof App");
  await expect(paneOf(page, "Proof App")).toBeVisible();
  assert.equal(
    await loadOf(page, "Proof App"),
    firstLoad,
    "Restore shows the same App globalThis.document without a reload",
  );
  assert.deepEqual(
    await frameMoves(),
    width === 1440
      ? ["added:Proof App", "added:Second App"]
      : ["added:Proof App"],
    "Each App frame entered its window once and was never re-parented",
  );
  await assertFramesInWindows(page);
  await page.screenshot({ path: `${shots}/restored-${shot}.png` });
}

/**
 * A Tourtois fork: this exact source plus one commit that marks its shell
 * root. Packed as its own Release, so only that Release's code can carry
 * the mark into the host page.
 */
async function packShellFork() {
  const clone = await mkdtemp(`${work}/fork-`);
  execFileSync("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    repository,
    clone,
  ]);
  execFileSync("git", [
    "-C",
    clone,
    "checkout",
    "--quiet",
    "--detach",
    revision,
  ]);
  const file = `${clone}/apps/tourtois/src/shell.tsx`;
  const source = await readFile(file, "utf8");
  const marked = source.replace(
    "const reactRoot = createRoot(root);",
    'root.dataset.shellFork = "proof";\n  const reactRoot = createRoot(root);',
  );
  assert.notEqual(marked, source, "The fork must change the shell's code");
  await writeFile(file, marked);
  execFileSync("git", [
    "-C",
    clone,
    "-c",
    "user.name=Shell fork proof",
    "-c",
    "user.email=proof@oyster.test",
    "commit",
    "--quiet",
    "-am",
    "proof: mark the forked shell",
  ]);
  const forkRevision = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const tourtois = standaloneAppSet.find(
    (app) => app.installationId === "tourtois",
  );
  assert.ok(tourtois);
  const directory = `${work}/fork-release-${forkRevision}`;
  const result = await packRelease({
    appId: "app_tourtois",
    sourceDirectory: clone,
    sourceRevision: `git:${forkRevision}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: committedAppRecipe(clone, tourtois, forkRevision),
    outDirectory: directory,
  });
  await rm(clone, { recursive: true, force: true });
  return { directory, release: result.release };
}

/** The shell modules a page imported, by path. */
function shellModules(page) {
  const modules = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/shell.js")) modules.push(path);
  });
  return modules;
}

let browser;
let activePage;
const errors = [];
try {
  await start("not-configured");
  if (appSet) {
    // The real installer: publish, build on the Computer, install.
    const installed = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        `${root}src/standalone/install-apps-bin.ts`,
        "install-apps",
        "--from",
        repository,
        // The lab compares sequential and parallel builds on one Computer.
        "--concurrency",
        process.env.OYSTER_PROOF_BUILD_CONCURRENCY ?? "1",
        "--timings",
        `${root}.botanical/app-set-timings.json`,
      ],
      {
        cwd: root,
        env: { ...process.env, OYSTER_URL: origin, OYSTER_OWNER_KEY: key },
      },
    );
    log(redact(installed.stdout));
    // Nothing was compiled or packed on this machine.
    await assert.rejects(access(`${root}.botanical/app-set`));
  } else {
    const installed = await installRelease({
      url: origin,
      key,
      installationId: "tourtois",
      directory: releaseDirectory,
    });
    assert.equal(installed.status, 201, await installed.text());
    await installChild("proof", "Proof App");
    await installChild("second", "Second App");
    if (gillProof) {
      const response = await globalThis.fetch(`${origin}/apps/proof/gills`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ viewId: "saved" }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.deepEqual(JSON.parse(body).rows, [
        { id: "saved-row", title: "Saved App data" },
      ]);
    }
  }
  const expectedApps = {
    tourtois: "Tourtois",
    bonsai: "Bonsai",
    shed: "Shed",
    inkcap: "Inkcap",
    trellis: "Trellis",
    prints: "Prints",
    grove: "Grove",
  };
  // Every non-shell starter App has its own settled-content check.
  assert.deepEqual(
    Object.keys(starterContent),
    Object.entries(expectedApps)
      .filter(([id]) => id !== "tourtois")
      .map(([, name]) => name),
  );
  let installedDirectory;
  const nativeFleet = [];
  if (appSet) {
    const response = await globalThis.fetch(
      `${origin}/api/workbench/directory`,
      { headers },
    );
    assert.equal(response.status, 200);
    installedDirectory = workbenchDirectorySchema.parse(await response.json());
    assert.ok(installedDirectory.computer);
    // Create real inventory through the existing owner route. Do not start
    // another host, substitute a provider, or mutate the configured default.
    for (const name of ["Fleet A", "Fleet B"]) {
      const created = await globalThis.fetch(`${origin}/api/computers`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name, requestId: `tourtois-home-${name}` }),
      });
      assert.equal(created.status, 200, await created.clone().text());
      nativeFleet.push(
        workbenchComputerDirectorySchema.shape.computers.element.parse(
          await created.json(),
        ),
      );
    }
    assert.equal(installedDirectory.apps.length, 7);
    for (const [installationId, name] of Object.entries(expectedApps)) {
      const row = installedDirectory.apps.find(
        (app) => app.installationId === installationId,
      );
      assert.ok(row);
      assert.equal(row.appId, `app_${installationId}`);
      assert.equal(row.displayName, name);
      assert.equal(row.availability, "available");
    }
  }
  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      reducedMotion: "reduce",
    });
    await page.goto(`${origin}/login`);
    await page.getByLabel("Owner key").fill(key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(origin);
    await expect(page.getByRole("link", { name: "tourtois" })).toBeVisible();
    await page.screenshot({ path: `${shots}/before-oyster-home-${width}.png` });
    await page.close();
  }
  await stop();
  await start("tourtois");
  for (const [width, colorScheme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
    [390, "dark"],
  ]) {
    const shot = `${width}-${colorScheme}`;
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      reducedMotion: "reduce",
      colorScheme,
    });
    activePage = page;
    const eventStream = gillProof
      ? await page.context().newCDPSession(page)
      : null;
    let markerReady = 0;
    let markerChanges = 0;
    if (eventStream !== null) {
      const markerRequests = new Set();
      eventStream.on("Network.requestWillBeSent", (event) => {
        if (
          new URL(event.request.url).pathname ===
          "/api/workbench/storage/proof/events"
        )
          markerRequests.add(event.requestId);
      });
      await eventStream.send("Network.enable");
      eventStream.on("Network.eventSourceMessageReceived", (event) => {
        if (!markerRequests.has(event.requestId)) return;
        if (event.eventName === "ready") markerReady++;
        if (event.eventName === "changed") markerChanges++;
      });
    }
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const modules = shellModules(page);
    await page.goto(`${origin}/login`);
    await page.getByLabel("Owner key").fill(key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(origin);
    await expect(page).toHaveURL(`${origin}/apps/tourtois/`);
    // Tourtois is the top-level shell document: no outer menu, no home frame.
    await expect(page.locator("#oyster-menu")).toHaveCount(0);
    await expect(page.locator("#oyster-app")).toHaveCount(0);
    const desktop = page;
    await expect(
      desktop.locator("#oyster-shell [data-tourtois-shell]"),
    ).toBeVisible();
    // The host's approval-checked entry, then the home Release's own module.
    const home = appSet
      ? null
      : [
          `/ui-entry/tourtois/${packed.release.releaseId}/shell.js`,
          `/ui/tourtois/${packed.release.releaseId}/shell.js`,
        ];
    assert.equal(modules.length, 2, JSON.stringify(modules));
    if (home !== null) assert.deepEqual(modules, home);
    await expect(page.locator("#oyster-shell")).not.toHaveAttribute(
      "data-shell-fork",
      /./u,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      colorScheme === "dark" ? "mocha" : "latte",
    );
    await expect(
      desktop.getByRole("button", { name: "Default Apps", exact: true }),
    ).toHaveCount(0);
    if (appSet) {
      for (const [id, name] of Object.entries(expectedApps)) {
        if (id !== "tourtois")
          await expect(
            desktop.getByRole("button", { name, exact: true }),
          ).toBeVisible();
      }
    } else {
      await expect(
        desktop.getByRole("button", { name: "Proof App", exact: true }),
      ).toBeVisible();
    }
    if (appSet) {
      const allApps = desktop.getByRole("button", {
        name: "All Apps ›",
        exact: true,
      });
      await expect
        .poll(() =>
          allApps.evaluate((button) => {
            const body = button.closest(".tourtois-gill-body");
            if (!body) throw new Error("Launcher body is missing");
            const tile = button.getBoundingClientRect();
            const bounds = body.getBoundingClientRect();
            return tile.top >= bounds.top && tile.bottom <= bounds.bottom;
          }),
        )
        .toBe(true);
      const bonsaiIcon = desktop
        .getByRole("button", { name: "Bonsai", exact: true })
        .locator('[data-sigil="bonsai"]');
      await expect(bonsaiIcon).toBeVisible();
      await bonsaiIcon.screenshot({
        path: `${shots}/bonsai-sigil-launcher-${shot}.png`,
      });
    }
    await page.screenshot({ path: `${shots}/after-oyster-home-${shot}.png` });
    await desktop
      .getByRole("button", { name: "Team and account menu", exact: true })
      .click();
    await desktop.getByRole("menuitem", { name: /System Settings/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("App desktop");
    // Connectors and Keys are standalone ports; Hub's Team sections are not.
    for (const label of ["Members", "Billing", "Selling"])
      await expect(
        page.getByRole("button", { name: label, exact: true }),
      ).toHaveCount(0);
    await expect(page.getByRole("dialog")).not.toContainText("app_tourtois");
    if (width === 390) {
      await page
        .getByRole("combobox", { name: "Settings category" })
        .selectOption({ label: "Tourtois" });
    } else {
      await page
        .getByRole("navigation", { name: "Settings categories" })
        .getByRole("button", { name: "Tourtois", exact: true })
        .click();
    }
    await expect(
      page.getByRole("heading", { name: "Tourtois", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `${shots}/after-oyster-settings-${shot}.png`,
    });
    if (gillProof) {
      if (width === 390)
        await page
          .getByRole("combobox", { name: "Settings category" })
          .selectOption({ label: "App desktop" });
      else
        await page
          .getByRole("navigation", { name: "Settings categories" })
          .getByRole("button", { name: "App desktop", exact: true })
          .click();
      await page
        .getByLabel("Apps to review")
        .getByRole("button", { name: "Proof App", exact: true })
        .click();
      const add = page.getByRole("button", {
        name: "Add to desktop",
        exact: true,
      });
      const remove = page.getByRole("button", {
        name: "Remove from desktop",
        exact: true,
      });
      await expect
        .poll(() =>
          add
            .or(remove)
            .evaluateAll((buttons) =>
              buttons.some((button) => !button.hasAttribute("disabled")),
            ),
        )
        .toBe(true);
      if (!(await remove.count())) {
        await add.click();
        // Keep the consent receiver alive until the accepted mutation and its
        // canonical layout refresh have completed, before closing Settings.
        await expect(remove).toBeVisible();
        await expect(remove).toBeEnabled();
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (gillProof) {
      await expect(
        desktop.getByText("Saved App data", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: `${shots}/gill-saved-rows-${shot}.png` });
      await expect.poll(() => markerReady).toBeGreaterThan(0);
      const previousChanges = markerChanges;
      let refreshed = 0;
      const observe = (request) => {
        if (new URL(request.url()).pathname === "/apps/proof/gills")
          refreshed++;
      };
      page.on("request", observe);
      const marker = await globalThis.fetch(
        `${origin}/api/workbench/storage/proof/read?key=widget-changed`,
        { headers },
      );
      assert.equal(marker.status, 200);
      const before = Schema.decodeUnknownSync(appStorageReadResultSchema)(
        await marker.json(),
      );
      assert.equal(before.kind, "accepted");
      const changed = await globalThis.fetch(
        `${origin}/api/workbench/storage/proof/write`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "widget-changed",
            scope: "member",
            basedOn: before.value.member?.revision ?? null,
            value: width,
          }),
        },
      );
      assert.equal(changed.status, 200);
      const mutation = Schema.decodeUnknownSync(appStorageMutationResultSchema)(
        await changed.json(),
      );
      assert.equal(mutation.kind, "accepted");
      await expect.poll(() => markerChanges).toBeGreaterThan(previousChanges);
      await expect.poll(() => refreshed).toBeGreaterThan(0);
      page.off("request", observe);
    }

    if (appSet) {
      await proveStarterApps(page, shot);
      await proveFleetPicker(
        page,
        shot,
        installedDirectory.computer,
        nativeFleet,
      );
    } else await proveAppWindows(page, width, shot);
    await page.close();
  }
  assert.deepEqual(errors, []);
  if (shellFork) {
    // The owner picks a forked shell Release as home: that Release's own
    // module, from this host, mounts top-level in place of the default.
    const fork = await packShellFork();
    const installed = await installRelease({
      url: origin,
      key,
      installationId: "tourtois-fork",
      directory: fork.directory,
    });
    assert.equal(installed.status, 201, await installed.text());
    await stop();
    await start("tourtois-fork");
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    activePage = page;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const modules = shellModules(page);
    await page.goto(`${origin}/login`);
    await page.getByLabel("Owner key").fill(key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(origin);
    await expect(page).toHaveURL(`${origin}/apps/tourtois-fork/`);
    await expect(
      page.locator(
        '#oyster-shell[data-shell-fork="proof"] [data-tourtois-shell]',
      ),
    ).toBeVisible();
    assert.deepEqual(modules, [
      `/ui-entry/tourtois-fork/${fork.release.releaseId}/shell.js`,
      `/ui/tourtois-fork/${fork.release.releaseId}/shell.js`,
    ]);
    assert.equal(page.frames().length, 1, "The shell is the top-level page");
    await openApp(page, "Proof App");
    await assertFramesInWindows(page);
    await page.screenshot({ path: `${shots}/fork-shell-1440.png` });
    await page.close();
    assert.deepEqual(errors, []);
  }
  await writeFile(
    `${shots}/release.json`,
    JSON.stringify(
      appSet
        ? { sourceRevision: revision, directory: installedDirectory }
        : { sourceRevision: revision, release: packed.release },
      null,
      2,
    ),
  );
  log(
    appSet
      ? "PASS fresh Oyster App set: Tourtois home, six real named App tiles, and each App opened in its window with its own content; 1440/390 light+dark"
      : "PASS Oyster trusted shell: top-level Tourtois from its Release's shell module, Settings, sandboxed App frames inside their windows (drag, rounded overlap clip, menu above App, raise without shield, minimize/restore without reload); 1440/390 light+dark",
  );
} catch (cause) {
  await writeFile(
    `${work}/browser-errors.json`,
    redact(JSON.stringify(errors)),
  );
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: `${work}/browser-failure.png` });
    const frames = await Promise.all(
      activePage.frames().map(async (frame) => ({
        url: frame.url(),
        body: await frame.locator("body").innerText(),
      })),
    );
    await writeFile(`${work}/browser-dom.json`, redact(JSON.stringify(frames)));
  }
  if (cause instanceof Error) {
    cause.message = redact(cause.message);
    if (cause.stack !== undefined) cause.stack = redact(cause.stack);
  }
  throw cause;
} finally {
  await browser?.close();
  await stop();
  await rm(state, { recursive: true, force: true });
  // Owner key stays private even when Wrangler echoes local bindings.
  await provider?.close();
  await writeFile(`${work}/worker.log`, redact(output));
}
