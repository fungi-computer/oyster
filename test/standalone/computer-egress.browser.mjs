// Actual standalone owner HTTP, installed Tourtois and persisted Computer state.
// A failed owner save must leave the same Computer refused to the real guest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { error, log } from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { chromium, expect } from "playwright/test";
import { z } from "zod";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { teamComputerSchema } from "@fungi.computer/nacre/workbench";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import { expectPublicDownload } from "./computer-egress-guest.fixture.mjs";
import {
  nativeAppClient,
  nativeWorkflowRoot,
} from "./workflow-native.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const host = await nativeWorkflowRoot({
  root,
  prefix: "computer-egress-browser-",
  main: "landed-push-root.fixture.ts",
  artifactBucket: "computer-egress-browser-app-artifacts",
  computer: "platform-container",
});
const setting = z.strictObject({ enabled: z.boolean() });
const settingPath = (id) =>
  `/api/computers/${encodeURIComponent(id)}/internet-access`;
const jsonAuth = { ...host.auth, "Content-Type": "application/json" };
let browser;

async function createComputer(name) {
  const response = await globalThis.fetch(`${host.origin}/api/computers`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ name, requestId: `browser-${name}` }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return teamComputerSchema.parse(await response.json()).computerId;
}

async function internetAccess(id, enabled) {
  const request = {
    method: enabled === undefined ? "GET" : "PUT",
    headers: jsonAuth,
  };
  if (enabled !== undefined) request.body = JSON.stringify({ enabled });
  const response = await globalThis.fetch(
    `${host.origin}${settingPath(id)}`,
    request,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return setting.parse(await response.json()).enabled;
}

async function openComputers(page, width) {
  await page.getByRole("button", { name: "Team and account menu" }).click();
  await page.getByRole("menuitem", { name: /System Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "System Settings" });
  await dialog.waitFor();
  if (width === 390)
    await dialog
      .getByRole("combobox", { name: "Settings category" })
      .selectOption({ label: "Internet access" });
  else
    await dialog
      .getByRole("navigation", { name: "Settings categories" })
      .getByRole("button", { name: "Internet access", exact: true })
      .click();
}

try {
  await host.ready();
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const app = standaloneAppSet.find(
    ({ installationId }) => installationId === "tourtois",
  );
  assert.ok(app);
  const directory = `${host.work}/tourtois-release`;
  await packRelease({
    appId: "app_tourtois",
    sourceDirectory: repository,
    sourceRevision: `git:${revision}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: committedAppRecipe(repository, app, revision),
    outDirectory: directory,
  });
  const installed = await installRelease({
    url: host.origin,
    key: host.key,
    installationId: "tourtois",
    directory,
  });
  assert.equal(installed.status, 201, await installed.text());
  // Selecting a trusted shell uses the current owner's pinned grant flow.
  await nativeAppClient(host.origin, host.auth, { key: host.key }).approve(
    "tourtois",
  );
  const configPath = `${host.work}/wrangler.json`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.vars.OYSTER_HOME_INSTALLATION = "tourtois";
  await writeFile(configPath, JSON.stringify(config));
  await host.restart();
  const a = await createComputer("Egress A");
  const b = await createComputer("Egress B");

  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    await internetAccess(a, false);
    await internetAccess(b, true);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (cause) => errors.push(cause.message));
    await page.goto(`${host.origin}/login`);
    await page.getByLabel("Owner key").fill(host.key);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(host.origin);
    await openComputers(page, width);
    const toggleA = page.getByRole("switch", {
      name: "Internet access for Egress A",
    });
    const toggleB = page.getByRole("switch", {
      name: "Internet access for Egress B",
    });
    await expect(toggleA).not.toBeChecked();
    await expect(toggleB).toBeChecked();

    // The owner cannot enable this refused Computer; the guest must still be refused.
    await page.route(
      `${host.origin}${settingPath(a)}`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "proof_owned_refusal" }),
        }),
      { times: 1 },
    );
    await toggleA.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Could not save Internet access for Egress A." })
      .waitFor();
    await expect(toggleA).not.toBeChecked();
    await expect(toggleA).toBeEnabled();
    assert.equal(await internetAccess(a), false);
    await expectPublicDownload(host, a, 403);
    await toggleA.click();
    await expect(toggleA).toBeChecked();
    await expect(toggleA).toBeEnabled();
    assert.equal(await internetAccess(a), true);
    assert.equal(await internetAccess(b), true);
    await expect(toggleB).toBeChecked();

    await host.restart();
    await page.reload();
    await openComputers(page, width);
    await expect(toggleA).toBeChecked();
    await expect(toggleB).toBeChecked();
    assert.equal(await internetAccess(a), true);
    assert.equal(await internetAccess(b), true);
    assert.deepEqual(errors, []);
    await page.close();
    log(
      `PASS Oyster Computers ${width}: failed enable -> guest 403, A/B save/readback, restart`,
    );
  }
} catch (cause) {
  error(host.output());
  throw cause;
} finally {
  await browser?.close();
  await host.close();
}
