// The first-run promise of `oyster try`: sign in, click Hello on the Tourtois
// desktop, and the App's page is visible. Then the stranger's next step,
// `oyster install-apps` against that local Oyster, refuses once in plain words
// (it has no Computer to build on) instead of seven raw HTTP 500s. Runs the
// real CLI from an installed
// package (a packed tarball of this checkout, or the published spec), with a
// fresh HOME and project, on a free loopback port.
//
//   OYSTER_TRY_PACKAGE=<tarball or npm spec> [OYSTER_TRY_SHOT=<png>] \
//     pnpm run proof:try-hello
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright/test";

const spec = process.env.OYSTER_TRY_PACKAGE;
assert.ok(spec, "Set OYSTER_TRY_PACKAGE to a tarball path or npm spec");
const shot = process.env.OYSTER_TRY_SHOT;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => {
        resolve(port);
      });
    });
  });

const work = await mkdtemp(join(tmpdir(), "oyster-try-hello-"));
const port = await freePort();
const project = join(work, "project");
let output = "";
const child = spawn(
  "npx",
  [
    "-y",
    "--package",
    spec,
    "oyster",
    "try",
    project,
    "--port",
    String(port),
    "--no-open",
    "--package",
    spec,
  ],
  {
    cwd: work,
    detached: true,
    env: { ...process.env, HOME: join(work, "home"), CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output += chunk;
  });
// A group that already exited is the goal, not a failure.
const stopGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (cause?.code !== "ESRCH") throw cause;
  }
};
let browser;
try {
  const deadline = Date.now() + 600_000;
  while (!output.includes("Oyster is running")) {
    assert.equal(child.exitCode, null, `oyster try exited early:\n${output}`);
    assert.ok(Date.now() < deadline, `oyster try never started:\n${output}`);
    await delay(500);
  }
  const origin = `http://127.0.0.1:${String(port)}`;
  const key = (await readFile(join(project, ".oyster-owner"), "utf8")).trim();
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const signedIn = await page.context().request.post(`${origin}/login`, {
    form: { key },
    maxRedirects: 0,
  });
  assert.equal(signedIn.status(), 303, "the owner key signs in");
  await page.goto(`${origin}/apps/tourtois/`);
  await page
    .getByText("Hello", { exact: true })
    .locator("visible=true")
    .first()
    .click();
  // The App's page sits in nested sandboxed frames; any frame may show it.
  const shown = async () => {
    for (const frame of page.frames())
      if (
        await frame
          .getByRole("heading", { name: "Hello from my first Oyster App" })
          .isVisible()
      )
        return true;
    return false;
  };
  const until = Date.now() + 20_000;
  while (!(await shown())) {
    if (Date.now() > until) {
      if (shot) await page.screenshot({ path: shot });
      throw new Error(
        `Hello never became visible: ${await page.locator("body").innerText()}`,
      );
    }
    await delay(250);
  }
  assert.equal(
    await page.getByText("didn't respond in time").count(),
    0,
    "the window shows no open error",
  );
  if (shot) await page.screenshot({ path: shot });
  const installApps = spawnSync(
    "npx",
    ["-y", "--package", spec, "oyster", "install-apps"],
    {
      cwd: work,
      env: {
        ...process.env,
        HOME: join(work, "home"),
        CI: "1",
        OYSTER_URL: origin,
        OYSTER_OWNER_KEY: key,
      },
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  const said = `${installApps.stdout}${installApps.stderr}`;
  assert.equal(installApps.status, 1, `install-apps must refuse:\n${said}`);
  assert.match(
    said,
    /no Computer to build the starter Apps/u,
    `install-apps names the missing Computer:\n${said}`,
  );
  assert.doesNotMatch(said, /\b500\b|Internal Server Error/u, said);
} finally {
  await browser?.close();
  stopGroup("SIGTERM");
  await delay(3000);
  stopGroup("SIGKILL");
  await rm(work, { recursive: true, force: true });
}
