// Real starter Apps, owner consent, repository save, Git commit and Issues.
// OYSTER_TRY_PACKAGE may name a published version; otherwise pack this build.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { chromium, expect } from "playwright/test";

const artifacts = resolve(".botanical/first-issue");
await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(artifacts, "try-"));
// Keep the trial's Git operations separate from the enclosing source checkout.
execFileSync("git", ["init", "--quiet", work]);
let spec = process.env.OYSTER_TRY_PACKAGE;
if (!spec) {
  execFileSync("pnpm", ["pack", "--pack-destination", work], { stdio: "pipe" });
  const tarball = (await readdir(work)).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "packing produced an Oyster tarball");
  spec = join(work, tarball);
}
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const child = spawn(
  "npx",
  [
    "-y",
    "--package",
    spec,
    "oyster",
    "try",
    join(work, "project"),
    "--port",
    String(port),
    "--no-open",
    "--package",
    spec,
  ],
  { cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);
const stopGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (cause.code !== "ESRCH") throw cause;
  }
};
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output += chunk;
  });
const waitFor = async (check, message, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.equal(child.exitCode, null, "Oyster must remain running");
    assert.ok(Date.now() < deadline, message);
    await delay(250);
  }
};
let browser;
let page;
let passed = false;
try {
  await waitFor(
    () => /Open \(works once\):\s+\S+/u.test(output),
    "Oyster must offer sign-in",
    180_000,
  );
  const link = /Open \(works once\):\s+(\S+)/u.exec(output)?.[1];
  assert.ok(link);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && path.startsWith("/apps/"))
      process.stdout.write(`HTTP ${response.status()} ${path}\n`);
  });
  await page.goto(link);
  await waitFor(
    () => /^bonsai (ready|already installed)$/mu.test(output),
    "Bonsai starter must install",
    600_000,
  );
  await waitFor(
    () => /^inkcap (ready|already installed)$/mu.test(output),
    "Inkcap starter must install",
    600_000,
  );
  const open = async (name) => {
    const launcher = page.getByRole("button", {
      name: "Open Apps",
      exact: true,
    });
    if ((await launcher.getAttribute("aria-expanded")) !== "true")
      await launcher.click();
    await page
      .getByRole("group", { name: "Apps", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  };
  const findFrame = async (text) => {
    let found;
    await waitFor(async () => {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        if (await frame.getByText(text, { exact: true }).first().isVisible()) {
          found = frame;
          return true;
        }
      }
      return false;
    }, `App must show ${text}`);
    return found;
  };
  await open("Bonsai");
  let bonsai = await findFrame("Approve Git access");
  await bonsai
    .getByRole("button", { name: "Approve Git access", exact: true })
    .click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  bonsai = await findFrame("Start your first repository");
  await bonsai.getByRole("button", { name: "notes", exact: true }).click();
  await bonsai
    .getByRole("button", { name: "Create repository", exact: true })
    .click();
  await bonsai.getByRole("link", { name: "Issues", exact: true }).click();
  await bonsai
    .getByRole("button", { name: "Write the first issue", exact: true })
    .click();
  const inkcap = await findFrame("notes · main");
  const editor = inkcap.getByRole("textbox", {
    name: "issues/general/01-first-issue.md",
    exact: true,
  });
  await expect(editor).toContainText("Describe what you want to change.", {
    timeout: 30_000,
  });
  await expect(page.getByText(/^Synced ·/u).first()).toBeVisible({
    timeout: 60_000,
  });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nFirst issue browser proof.\n");
  await editor.press("ControlOrMeta+s");
  await expect(page.getByText(/^Synced ·/u).first()).toBeVisible({
    timeout: 60_000,
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({ path: join(artifacts, `synced-${width}.png`) });
  }
  await page.getByRole("button", { name: "Close Inkcap", exact: true }).click();
  await page.reload();
  await open("Bonsai");
  bonsai = await findFrame("notes");
  // Reopen the repository after a full reload, then read its committed issues.
  const repository = bonsai
    .getByRole("link", { name: "notes", exact: true })
    .first();
  if (await repository.isVisible()) await repository.click();
  await bonsai.getByRole("link", { name: "Issues", exact: true }).click();
  await expect(bonsai.getByText("No issues yet", { exact: true })).toHaveCount(
    0,
  );
  await bonsai.getByText("First issue", { exact: true }).first().click();
  await expect(
    bonsai.getByText("First issue browser proof.", { exact: true }),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({ path: join(artifacts, `issues-${width}.png`) });
  }
  passed = true;
  process.stdout.write(
    "PASS first issue: Bonsai → Inkcap edit/save → committed Bonsai Issues after reload; 1440/390\n",
  );
} catch (cause) {
  await page?.screenshot({ path: join(artifacts, "failed.png") });
  // Startup output contains the one-time sign-in URL. Never print it.
  const signIn = /Open \(works once\):\s+(\S+)/u.exec(output)?.[1];
  if (signIn && cause instanceof Error) {
    cause.message = cause.message.replaceAll(signIn, "[sign-in redacted]");
    if (cause.stack !== undefined)
      cause.stack = cause.stack.replaceAll(signIn, "[sign-in redacted]");
  }
  throw cause;
} finally {
  await browser?.close();
  stopGroup("SIGTERM");
  await delay(3000);
  stopGroup("SIGKILL");
  if (passed) await rm(work, { recursive: true, force: true });
}
