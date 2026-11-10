// Actual standalone owner HTTP and installed Tourtois: Model keys settings.
// Without a credential key the owner is refused; with one, the real provider
// rejects a bogus key and nothing is stored. Agent model choice survives restart.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { error, log } from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { chromium, expect } from "playwright/test";
import { z } from "zod";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
import {
  launchIsolatedChromium,
  portsOf,
} from "../../../../tooling/proof-runner/isolated-chromium.mjs";
import {
  nativeAppClient,
  nativeWorkflowRoot,
} from "./workflow-native.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const host = await nativeWorkflowRoot({
  root,
  prefix: "model-keys-browser-",
  main: "landed-push-root.fixture.ts",
  artifactBucket: "model-keys-browser-app-artifacts",
  computer: null,
  ai: true,
});
const jsonAuth = { ...host.auth, "Content-Type": "application/json" };
const credentialKey = randomBytes(32).toString("base64url");
let browser;
const screenshotDirectory =
  process.env.OYSTER_MODEL_KEYS_SCREENSHOT_DIR ?? host.work;
await mkdir(screenshotDirectory, { recursive: true });

async function owner(path, init = {}) {
  return globalThis.fetch(`${host.origin}${path}`, {
    ...init,
    headers: { ...jsonAuth, ...init.headers },
  });
}

async function openKeys(page, width) {
  await page.getByRole("button", { name: "Team and account menu" }).click();
  await page.getByRole("menuitem", { name: /System Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "System Settings" });
  await dialog.waitFor();
  if (width === 390)
    await dialog
      .getByRole("combobox", { name: "Settings category" })
      .selectOption({ label: "Keys" });
  else
    await dialog
      .getByRole("navigation", { name: "Settings categories" })
      .getByRole("button", { name: "Keys", exact: true })
      .click();
  return dialog;
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
  await nativeAppClient(host.origin, host.auth, { key: host.key }).approve(
    "tourtois",
  );
  const configPath = `${host.work}/wrangler.json`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.vars.OYSTER_HOME_INSTALLATION = "tourtois";
  await writeFile(configPath, JSON.stringify(config));
  await host.restart();
  const created = await owner("/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Key proof", requestId: "model-keys-agent" }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { agentId } = z
    .object({ agentId: z.string() })
    .parse(await created.json());

  browser = await launchIsolatedChromium(chromium, portsOf(host.origin));
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (cause) => errors.push(cause.message));
  await page.goto(`${host.origin}/login`);
  await page.getByLabel("Owner key").fill(host.key);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.goto(host.origin);
  let dialog = await openKeys(page, 1440);
  await expect(dialog.getByText("No model keys yet.")).toBeVisible();
  await expect(
    dialog.getByLabel("Agent models").getByText("Key proof"),
  ).toBeVisible();
  const addKey = async (label, apiKey) => {
    const form = dialog.getByRole("form", { name: "Add model key" });
    await form.getByLabel("Name").fill(label);
    await form.getByLabel("API key").fill(apiKey);
    await form.getByRole("button", { name: "Add model key" }).click();
  };

  // Cloudflare comes first, with its required account rather than a token-only form.
  const firstForm = dialog.getByRole("form", { name: "Add model key" });
  await expect(firstForm.getByLabel("Provider")).toHaveValue(
    "cloudflare-workers-ai",
  );
  await expect(firstForm.getByLabel("Account ID")).toBeVisible();
  await firstForm.getByLabel("Name").fill("My Cloudflare");
  await firstForm.getByLabel("API key").fill("bogus-token");
  await firstForm.getByRole("button", { name: "Add model key" }).click();
  await expect(
    firstForm.getByText("Enter your 32-character Cloudflare account ID."),
  ).toBeVisible();
  await page.screenshot({
    path: `${screenshotDirectory}/model-keys-cloudflare-1440.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(firstForm.getByLabel("Account ID")).toBeVisible();
  await page.screenshot({
    path: `${screenshotDirectory}/model-keys-cloudflare-390.png`,
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. No credential key on this instance: explicit refusal, nothing stored.
  await dialog
    .getByRole("form", { name: "Add model key" })
    .getByLabel("Provider")
    .selectOption({ label: "OpenAI" });
  await expect(firstForm.getByLabel("Account ID")).toHaveCount(0);
  await addKey("Bogus", `sk-test-${"z".repeat(16)}`);
  await expect(dialog.getByText(/no credential key/u)).toBeVisible();
  assert.deepEqual(await (await owner("/api/model-keys")).json(), { keys: [] });
  await page.screenshot({
    path: `${screenshotDirectory}/model-keys-no-custody.png`,
  });

  // 2. With the key configured, the real provider rejects a bogus key.
  config.vars.OYSTER_CREDENTIAL_KEY = credentialKey;
  await writeFile(configPath, JSON.stringify(config));
  await host.restart();
  await page.reload();
  dialog = await openKeys(page, 1440);
  await dialog
    .getByRole("form", { name: "Add model key" })
    .getByLabel("Provider")
    .selectOption({ label: "OpenAI" });
  await addKey("Bogus", `sk-test-${"z".repeat(16)}`);
  await expect(
    dialog.getByText("The provider rejected this key"),
  ).toBeVisible();
  assert.deepEqual(await (await owner("/api/model-keys")).json(), { keys: [] });

  // 3. An Agent's persisted model choice survives a restart and shows in Settings.
  const choice = await owner(`/api/agent-models/${agentId}`, {
    method: "PUT",
    body: JSON.stringify({
      keySource: "workers-ai",
      model: {
        providerId: "cloudflare-workers-ai",
        modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      },
    }),
  });
  assert.equal(choice.status, 200, await choice.clone().text());
  await host.restart();
  await page.reload();
  dialog = await openKeys(page, 1440);
  await expect(
    dialog
      .getByLabel("Agent models")
      .getByText("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  ).toBeVisible();
  await page.screenshot({
    path: `${screenshotDirectory}/model-keys-settings.png`,
  });
  assert.deepEqual(errors, []);
  log(
    "PASS Model keys: no-custody refusal, provider rejection, restart-persisted Agent model",
  );
} catch (cause) {
  error(host.output());
  throw cause;
} finally {
  await browser?.close();
  await host.close();
}
