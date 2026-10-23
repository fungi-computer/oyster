import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
// Edit in Inkcap on the production standalone root: captured Tourtois, Bonsai
// and Inkcap Releases, a local real Git provider, and a real browser.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { log, error } from "node:console";
import process from "node:process";
import { parse } from "jsonc-parser";
import { chromium, expect } from "playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const shots = process.env.EDIT_IN_INKCAP_SHOTS;
assert.ok(shots, "Set EDIT_IN_INKCAP_SHOTS to the review screenshot directory");
await mkdir(shots, { recursive: true });
for (const args of [
  [
    "--workspace-root",
    "run",
    "turbo:run",
    "run",
    "build",
    "--filter=@fungi.computer/oyster...",
    "--concurrency=3",
    "--output-logs=errors-only",
  ],
]) {
  const prepared = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  assert.equal(prepared.status, 0, "Edit in Inkcap proof prerequisites failed");
}
const { packRelease, installRelease } =
  await import("@fungi.computer/oyster/pack");
const { standaloneAppSet } =
  await import("@fungi.computer/oyster/standalone/app-set");
const { workflowGitProvider } = await import("./workflow-git.fixture.mjs");
const { seedDemo } =
  await import("../../../../apps/bonsai/scripts/seed-demo.mjs");

await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/edit-in-inkcap-`);
const key = randomBytes(24).toString("hex");
const keyFile = `${work}/owner-key`;
await writeFile(keyFile, key, { mode: 0o600 });
const port = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const store = execFileSync("pnpm", ["store", "path"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const installations = ["tourtois", "bonsai", "inkcap"];
const releases = new Map();
for (const installationId of installations) {
  const app = standaloneAppSet.find(
    (item) => item.installationId === installationId,
  );
  assert.ok(app, `${installationId} is in the standalone App set`);
  const directory = `${root}.botanical/edit-in-inkcap-releases/${revision}/${installationId}`;
  try {
    const release = JSON.parse(
      await readFile(`${directory}/release.json`, "utf8"),
    );
    assert.equal(
      release.artifact.provenance.sourceRevision,
      `git:${revision}`,
      "Cached Release must match committed source",
    );
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    await packRelease({
      appId: app.appId,
      sourceDirectory: repository,
      sourceRevision: `git:${revision}`,
      packageStoreDirectory: store,
      recipe: committedAppRecipe(repository, app, revision),
      outDirectory: directory,
    });
  }
  releases.set(installationId, directory);
}
const provider = await workflowGitProvider();
const config = parse(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/workflows-root.fixture.ts`;
config.r2_buckets = config.r2_buckets.map((bucket) => ({
  ...bucket,
  bucket_name: `edit-in-inkcap-${bucket.binding.toLowerCase().replaceAll("_", "-")}`,
}));
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
// The browser and harness use loopback; the root sees its declared HTTPS origin.
const worker = spawn(
  `${root}node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    `${work}/wrangler.json`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--local-upstream",
    "oyster.test",
    "--upstream-protocol",
    "https",
    "--var",
    `OYSTER_OWNER_KEY:${key}`,
    "--var",
    "OYSTER_ORIGIN:https://oyster.test",
    "--var",
    "OYSTER_HOME_INSTALLATION:tourtois",
    "--var",
    `GIT_ORIGIN:${provider.origin}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let output = "";
worker.stdout.on("data", (chunk) => {
  output += chunk;
});
worker.stderr.on("data", (chunk) => {
  output += chunk;
});
const stopped = new Promise((resolve) => worker.once("exit", resolve));
const redact = (text) => text.split(key).join("[redacted]");
let browser;
let activePage;

/** One Tourtois App's window pane (title bar, minimize button, body). */
function paneOf(page, name) {
  return page.locator(`.tourtois-app-pane[aria-label="${name}"]`);
}

/** One Tourtois window's App frame, chosen by the App's own window pane. */
function appFrame(page, name) {
  return paneOf(page, name).frameLocator(".tourtois-pane-body iframe");
}

/** Bring a running App back through the shell's own running-App control,
 * same as tourtois-home.browser.mjs's restoreApp. */
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

async function runProof() {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 480 && !ready; attempt++) {
      ready = await globalThis
        .fetch(`${origin}/login`, {
          signal: globalThis.AbortSignal.timeout(1_000),
        })
        .then(
          (response) => response.ok,
          () => false,
        );
      if (!ready) await delay(250);
    }
    assert.ok(ready, "Local Oyster did not start");
    for (const installationId of installations) {
      const installed = await installRelease({
        directory: releases.get(installationId),
        url: origin,
        key,
        installationId,
      });
      assert.equal(
        installed.status,
        201,
        `${installationId} installation failed: ${await installed.text()}`,
      );
    }
    await seedDemo({
      origin,
      work: `${work}/seed`,
      ownerKeyFile: keyFile,
      phase: "prepare",
    });
    browser = await chromium.launch({ headless: true });
    const errors = [];
    let run = 0;
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        run++;
        const page = await browser.newPage({
          viewport: { width, height: width === 390 ? 844 : 960 },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        activePage = page;
        page.on("pageerror", (cause) => errors.push(cause.message));
        await page.goto(`${origin}/login`);
        await page.getByLabel("Owner key").fill(key);
        await page.getByRole("button", { name: /sign in/i }).click();
        await page.goto(origin);
        const desktop = page.locator("#oyster-shell [data-tourtois-shell]");
        await expect(desktop).toBeVisible({
          timeout: 30_000,
        });
        await desktop
          .getByRole("button", { name: "Bonsai", exact: true })
          .click();
        const bonsai = appFrame(page, "Bonsai");
        await bonsai
          .getByRole("link", { name: "koi-pond", exact: true })
          .first()
          .click({ timeout: 30_000 });
        // The Code tab shows the repository README until another file is chosen.
        await bonsai.getByRole("link", { name: /^Code/ }).first().click();
        const edit = bonsai.getByRole("button", {
          name: "Edit in Inkcap",
          exact: true,
        });
        await expect(edit).toBeVisible();
        await page.screenshot({
          path: `${shots}/bonsai-code-${width}-${theme}.png`,
        });
        await edit.click();
        const inkcap = appFrame(page, "Inkcap");
        const editor = inkcap.getByRole("textbox", {
          name: "README.md",
          exact: true,
        });
        await expect(editor).toBeVisible({ timeout: 30_000 });
        await page.screenshot({
          path: `${shots}/inkcap-open-${width}-${theme}.png`,
        });
        const line = `Edited in Inkcap run ${String(run)}`;
        await editor.press("ControlOrMeta+End");
        await page.keyboard.insertText(`\n${line}\n`);
        await inkcap
          .locator(".inkcap-file-toolbar:visible")
          .getByRole("button", { name: "Save", exact: true })
          .click();
        await page.screenshot({
          path: `${shots}/inkcap-saved-${width}-${theme}.png`,
        });
        // Bonsai is already open behind Inkcap here (unlike the very first
        // click above, before any window exists) — its own window title bar
        // now also matches a plain "Bonsai" button, same ambiguity
        // restoreApp already exists to resolve.
        await restoreApp(page, "Bonsai");
        await expect(bonsai.getByText(line).first()).toBeVisible({
          timeout: 30_000,
        });
        const unsynced = bonsai.getByText("Unsynced edit", { exact: true });
        const sync = bonsai.getByRole("button", { name: "Sync", exact: true });
        if (await unsynced.isVisible()) {
          await page.screenshot({
            path: `${shots}/bonsai-unsynced-${width}-${theme}.png`,
          });
          await sync.click();
        }
        await expect(unsynced).toHaveCount(0, { timeout: 60_000 });
        await page.screenshot({
          path: `${shots}/bonsai-synced-${width}-${theme}.png`,
        });
        assert.ok(
          (await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth,
          )) <= width,
          "no horizontal page scroll",
        );
        await page.close();
      }

    // Row 10, 52 (local part), 53, 54: the History tab, Inkcap's own
    // Computer Explorer (no repository open request, unlike the handoff
    // above), Markdown/video preview, and unsaved edits across minimize and
    // restore.
    {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
        reducedMotion: "reduce",
      });
      activePage = page;
      page.on("pageerror", (cause) => errors.push(cause.message));
      await page.goto(`${origin}/login`);
      await page.getByLabel("Owner key").fill(key);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.goto(origin);
      const desktop = page.locator("#oyster-shell [data-tourtois-shell]");
      await expect(desktop).toBeVisible({ timeout: 30_000 });

      // Row 10: the History tab lists this proof's own README saves.
      await desktop
        .getByRole("button", { name: "Bonsai", exact: true })
        .click();
      const bonsai = appFrame(page, "Bonsai");
      await bonsai
        .getByRole("link", { name: "koi-pond", exact: true })
        .first()
        .click({ timeout: 30_000 });
      // The tab's internal id is "commits" but its displayed label is
      // "History" (apps/bonsai/web/repo-navigation.tsx:20).
      await bonsai
        .getByRole("link", { name: /^History/ })
        .first()
        .click();
      await expect(bonsai.getByText("Edit README.md").first()).toBeVisible({
        timeout: 30_000,
      });
      await page.screenshot({ path: `${shots}/bonsai-commits.png` });

      // Seed a text file through Inkcap's own writeFile method and a video
      // (which that method cannot carry; it is UTF-8 text only) through the
      // Computer's direct content door, before opening Inkcap on the
      // Computer rather than through a repository handoff.
      const auth = { Authorization: `Bearer ${key}` };
      const markdown = "# Notes\n\nSeeded for the demo E2E proof.\n";
      const wroteNotes = await globalThis.fetch(
        `${origin}/apps/inkcap/methods/writeFile`,
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/notes.md", content: markdown }),
        },
      );
      assert.equal(wroteNotes.status, 200, await wroteNotes.text());
      // Inkcap's CC0 test clip; read, not fetched, and never committed a
      // second time here.
      const clip = await readFile(
        `${repository}apps/inkcap/test/fixtures/flower.mp4`,
      );
      const wroteClip = await globalThis.fetch(
        `${origin}/files/content?path=/clip.mp4`,
        {
          method: "PUT",
          headers: { ...auth, "X-Oyster-Installation": "inkcap" },
          body: clip,
        },
      );
      assert.equal(wroteClip.status, 204, await wroteClip.text());

      // Bonsai is still maximized from the History check above; its own
      // window covers the desktop's app icons (confirmed: a direct
      // getByRole("button", {name:"Inkcap"}) click times out while
      // Bonsai is maximized — the same icon grid the very first "Bonsai"
      // click above used is simply not reachable). Minimize it first,
      // the same generic control "Minimize Inkcap" uses later in this file
      // (packages/caps/src/components/window.tsx's `Minimize ${title}`).
      await paneOf(page, "Bonsai")
        .getByRole("button", { name: "Minimize Bonsai", exact: true })
        .click();
      await desktop
        .getByRole("button", { name: "Inkcap", exact: true })
        .click();
      const inkcap = appFrame(page, "Inkcap");
      await expect(
        inkcap.getByRole("main", { name: "Inkcap editor" }),
      ).toBeVisible({ timeout: 30_000 });

      // Row 53: the Explorer root label is the Computer's real name, not a
      // generic placeholder, and the tree loads within 10s with no "Loading".
      const rootDecoration = inkcap.locator(
        '[data-item-path="/"] [data-item-section="decoration"]',
      );
      await expect(rootDecoration).toBeVisible({ timeout: 10_000 });
      await expect(inkcap.getByText("Loading files…")).toHaveCount(0);
      const computerName = await rootDecoration.innerText();
      assert.ok(
        computerName.length > 0,
        "Explorer root shows the Computer's real name",
      );

      async function openTreeItem(path) {
        const treeRoot = inkcap.getByRole("treeitem").first();
        if ((await treeRoot.getAttribute("aria-expanded")) === "false")
          await treeRoot.press("ArrowRight");
        await inkcap
          .locator(`[role="treeitem"][data-item-path="${path}"]`)
          .click();
      }

      // Row 53: the Markdown preview renders a heading from the seeded file.
      await openTreeItem("/notes.md");
      const notesEditor = inkcap.getByRole("textbox", {
        name: "/notes.md",
        exact: true,
      });
      await expect(notesEditor).toBeVisible({ timeout: 10_000 });
      const previewToggle = inkcap.getByRole("button", {
        name: "Preview Markdown",
        exact: true,
      });
      await previewToggle.click();
      await expect(
        inkcap.getByRole("heading", { name: "Notes", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: `${shots}/inkcap-markdown-preview.png` });
      await previewToggle.click();
      await expect(notesEditor).toBeVisible();

      // Row 53: the seeded clip renders real, playable video controls.
      await openTreeItem("/clip.mp4");
      const video = inkcap.locator("video");
      await expect(video).toBeVisible({ timeout: 10_000 });
      await expect(video).toHaveAttribute("controls", "");
      await expect
        .poll(() => video.evaluate((element) => element.videoWidth))
        .toBeGreaterThan(0);
      await page.screenshot({ path: `${shots}/inkcap-video-preview.png` });

      // Row 54: type without saving, minimize, restore — the edit, the open
      // file and its dirty (unsaved) state must all survive.
      await openTreeItem("/notes.md");
      await expect(notesEditor).toBeVisible({ timeout: 10_000 });
      await notesEditor.click();
      await notesEditor.press("ControlOrMeta+End");
      const unsavedLine = "Typed before minimize, never saved";
      await page.keyboard.insertText(`\n${unsavedLine}\n`);
      const saveButton = inkcap
        .locator(".inkcap-file-toolbar:visible")
        .getByRole("button", { name: "Save", exact: true });
      await expect(saveButton).toBeEnabled();
      await paneOf(page, "Inkcap")
        .getByRole("button", { name: "Minimize Inkcap", exact: true })
        .click();
      await expect(paneOf(page, "Inkcap")).toBeHidden();
      await page.screenshot({ path: `${shots}/inkcap-minimized.png` });
      await restoreApp(page, "Inkcap");
      await expect(paneOf(page, "Inkcap")).toBeVisible();
      await expect(notesEditor).toContainText(unsavedLine);
      await expect(saveButton).toBeEnabled();
      await page.screenshot({ path: `${shots}/inkcap-restored.png` });

      await page.close();
    }
    const history = await globalThis.fetch(
      `${origin}/apps/bonsai/methods/commits.list`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo: "koi-pond", ref: "main", limit: 8 }),
      },
    );
    const commits = await history.text();
    assert.equal(history.status, 200, commits);
    await writeFile(`${shots}/commits.json`, commits);
    assert.equal(
      commits.split('"message":"Edit README.md').length - 1,
      run,
      "each save lands as one member-authored commit",
    );
    assert.deepEqual(errors, []);
    log(
      `PASS Edit in Inkcap live: Bonsai Code → Inkcap opens README.md → save → Bonsai pending/synced, ${String(run)} commits, 1440/390 light/dark. Shots: ${shots}`,
    );
    return true;
  } catch (cause) {
    if (activePage && !activePage.isClosed()) {
      await activePage.screenshot({ path: `${shots}/failure.png` });
      const frames = await Promise.all(
        activePage.frames().map(async (frame) => ({
          url: frame.url(),
          body: await frame
            .locator("body")
            .innerText()
            .catch((reason) => `unreadable: ${String(reason)}`),
        })),
      );
      await writeFile(
        `${work}/browser-dom.json`,
        redact(JSON.stringify(frames, null, 2)),
      );
    }
    error(
      `Edit in Inkcap live proof failed: ${cause instanceof Error ? redact(cause.stack ?? cause.message) : "unknown failure"}. Receipt: ${work}`,
    );
    return false;
  } finally {
    await browser?.close();
    worker.kill("SIGTERM");
    await stopped;
    await provider.close();
    await writeFile(`${work}/worker.log`, redact(output), { mode: 0o600 });
  }
}
if (!(await runProof())) process.exitCode = 1;
