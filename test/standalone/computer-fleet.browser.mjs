// The owner's path through Settings > Computers on standalone Oyster, with two
// real platform Computers: create A and B, list them, start each, choose the
// default for new Apps, keep both identities across a host restart, replay a
// create without a second Computer, and refuse an id that names none.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { error, log } from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { chromium, expect } from "playwright/test";
import { z } from "zod";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { teamComputerSchema } from "@fungi.computer/nacre/workbench";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import {
  launchIsolatedChromium,
  portsOf,
} from "../../../../tooling/proof-runner/isolated-chromium.mjs";
import {
  nativeAppClient,
  nativeWorkflowRoot,
  until,
} from "./workflow-native.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const screenshots = `${root}.botanical/computer-fleet-browser`;
const host = await nativeWorkflowRoot({
  root,
  prefix: "computer-fleet-browser-",
  main: "landed-push-root.fixture.ts",
  artifactBucket: "computer-fleet-browser-app-artifacts",
  computer: "platform-container",
  computerInstances: 2,
});
const jsonAuth = { ...host.auth, "Content-Type": "application/json" };
const page_ = z.object({ computers: z.array(teamComputerSchema) });
const directory = z.object({
  computer: z.object({ computerId: z.string() }),
});
const runState = z.object({ state: z.string() });
let browser;

async function owner(path, init = {}) {
  return globalThis.fetch(`${host.origin}${path}`, {
    ...init,
    headers: jsonAuth,
  });
}

async function listed() {
  const response = await owner("/api/computers");
  assert.equal(response.status, 200, await response.clone().text());
  return page_.parse(await response.json()).computers;
}

async function selected() {
  const response = await owner("/api/workbench/directory");
  assert.equal(response.status, 200, await response.clone().text());
  return directory.parse(await response.json()).computer.computerId;
}

async function state(computerId) {
  const response = await owner(
    `/api/computers/${encodeURIComponent(computerId)}/state`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return runState.parse(await response.json()).state;
}

async function openComputers(page, width) {
  await page.getByRole("button", { name: "Team and account menu" }).click();
  await page.getByRole("menuitem", { name: /System Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "System Settings" });
  await dialog.waitFor();
  if (width === 390)
    await dialog
      .getByRole("combobox", { name: "Settings category" })
      .selectOption({ label: "Computers" });
  else
    await dialog
      .getByRole("navigation", { name: "Settings categories" })
      .getByRole("button", { name: "Computers", exact: true })
      .click();
  const view = dialog.getByRole("region", { name: "Computers" });
  await view.waitFor();
  return view;
}

async function createInView(view, name) {
  const form = view.getByRole("form", { name: "Create Computer" });
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Create Computer" }).click();
  await expect(view.getByRole("region", { name, exact: true })).toBeVisible();
}

async function startInView(view, name, computerId) {
  const row = view.getByRole("region", { name, exact: true });
  await row.getByRole("button", { name: `Start ${name}`, exact: true }).click();
  await until(
    () => state(computerId),
    (current) => current === "running",
    `${name} running`,
    120_000,
  );
  await expect(
    row.getByRole("button", { name: `Stop ${name}`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

try {
  await host.ready();
  await mkdir(screenshots, { recursive: true });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const app = standaloneAppSet.find(
    ({ installationId }) => installationId === "tourtois",
  );
  assert.ok(app);
  const release = `${host.work}/tourtois-release`;
  await packRelease({
    appId: "app_tourtois",
    sourceDirectory: repository,
    sourceRevision: `git:${revision}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: committedAppRecipe(repository, app, revision),
    outDirectory: release,
  });
  const installed = await installRelease({
    url: host.origin,
    key: host.key,
    installationId: "tourtois",
    directory: release,
  });
  assert.equal(installed.status, 201, await installed.text());
  await nativeAppClient(host.origin, host.auth, { key: host.key }).approve(
    "tourtois",
  );
  const configPath = `${host.work}/wrangler.json`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.vars.OYSTER_HOME_INSTALLATION = "tourtois";
  await writeFile(configPath, JSON.stringify(config));
  await host.restart();

  browser = await launchIsolatedChromium(chromium, portsOf(host.origin));
  for (const width of [1440, 390]) {
    const nameA = `Fleet A ${String(width)}`;
    const nameB = `Fleet B ${String(width)}`;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (cause) => errors.push(cause.message));
    await page.goto(`${host.origin}/login`);
    await page.getByLabel("Owner key").fill(host.key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(host.origin);
    let view = await openComputers(page, width);

    // Create A and B through the form; the list holds each exactly once.
    const before = await listed();
    await createInView(view, nameA);
    await createInView(view, nameB);
    const created = await listed();
    assert.equal(created.length, before.length + 2);
    const a = created.find(({ name }) => name === nameA);
    const b = created.find(({ name }) => name === nameB);
    assert.ok(a && b && a.computerId !== b.computerId);

    // Start each from its own row.
    await startInView(view, nameA, a.computerId);
    await startInView(view, nameB, b.computerId);

    // Choose B as the default for new Apps.
    const rowB = view.getByRole("region", { name: nameB, exact: true });
    await rowB
      .getByRole("button", { name: `Use ${nameB} for new Apps`, exact: true })
      .click();
    await expect(rowB.getByText("Default for new Apps")).toBeVisible();
    assert.equal(await selected(), b.computerId);
    await page.screenshot({
      path: `${screenshots}/${String(width)}-two-computers.png`,
      fullPage: true,
    });

    // A replayed create answers the same Computer and adds no row.
    const replay = {
      method: "POST",
      body: JSON.stringify({
        name: `Fleet replay ${String(width)}`,
        requestId: `fleet-replay-${String(width)}`,
      }),
    };
    const first = await owner("/api/computers", replay);
    assert.equal(first.status, 200, await first.clone().text());
    const again = await owner("/api/computers", replay);
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal(
      teamComputerSchema.parse(await again.json()).computerId,
      teamComputerSchema.parse(await first.json()).computerId,
    );
    assert.equal((await listed()).length, created.length + 1);

    // An id that names no Computer is refused, never created or started.
    const unknown = await owner("/api/computers/computer_unknown/start", {
      method: "POST",
    });
    assert.equal(unknown.status, 404, await unknown.clone().text());
    assert.equal((await listed()).length, created.length + 1);

    // A restart keeps both identities and the chosen default.
    await host.restart();
    await page.reload();
    view = await openComputers(page, width);
    // The restarted host stopped both; each row reads its state and its
    // settings again.
    for (const name of [nameA, nameB]) {
      const row = view.getByRole("region", { name, exact: true });
      await expect(
        row.getByRole("button", { name: `Start ${name}`, exact: true }),
      ).toBeEnabled();
      await expect(row.getByText("Sleeping", { exact: true })).toBeVisible();
      await expect(
        row.getByRole("switch", { name: `Internet access for ${name}` }),
      ).toBeEnabled();
    }
    await expect(
      view
        .getByRole("region", { name: nameB, exact: true })
        .getByText("Default for new Apps"),
    ).toBeVisible();
    const kept = await listed();
    assert.deepEqual(
      kept.filter(({ computerId }) =>
        [a.computerId, b.computerId].includes(computerId),
      ).length,
      2,
    );
    assert.equal(await selected(), b.computerId);
    await page.screenshot({
      path: `${screenshots}/${String(width)}-after-restart.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
    log(
      `PASS Oyster Computers ${String(width)}: create A/B, list, start each, default B, replayed create, unknown refused, restart`,
    );
  }
} catch (cause) {
  error(host.output());
  throw cause;
} finally {
  await browser?.close();
  await host.close();
}
