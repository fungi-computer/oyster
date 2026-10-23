import { committedAppRecipe } from "./committed-app-recipe.fixture.mjs";
// The production standalone Oyster + real Bonsai release; local real Git provider.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { log, error } from "node:console";
import process from "node:process";
import { parse } from "jsonc-parser";
import * as z from "zod";
import { chromium, expect } from "playwright/test";
import { packRelease, installRelease } from "@fungi.computer/oyster/pack";
import { commitPage } from "@fungi.computer/agar/roles/files";
import { standaloneAppSet } from "@fungi.computer/oyster/standalone/app-set";
import { workflowGitProvider } from "./workflow-git.fixture.mjs";
import { seedDemo } from "../../../../apps/bonsai/scripts/seed-demo.mjs";
import { approvedOwnerMerge } from "./approved-owner-merge.native.mjs";
import { proveMcpFork } from "./mcp-fork.browser.mjs";
import {
  changeRecord,
  repoDetail,
  repoPage,
  repoSummary,
} from "../../../../apps/bonsai/shared/contract.ts";
import { repositoryDeletion } from "../../../../apps/bonsai/shared/repository-deletion.ts";

const proof = z.enum(["seed", "mcp"]).parse(process.env.BONSAI_PROOF ?? "seed");
const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/demo-seed-`);
const shots = `${work}/shots`;
await mkdir(shots);
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
// The seeded tenant lives at an HTTPS origin. Wrangler presents loopback
// requests to the Worker at that origin, as TLS termination does in production.
const tenantHost = "oyster.test";
const tenantOrigin = `https://${tenantHost}`;
execFileSync("pnpm", ["run", "build"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const bonsai = standaloneAppSet.find((app) => app.installationId === "bonsai");
assert.ok(bonsai);
const releaseDirectory = process.env.BONSAI_SEED_RELEASE ?? `${work}/release`;
if (process.env.BONSAI_SEED_RELEASE) {
  const release = JSON.parse(
    await readFile(`${releaseDirectory}/release.json`, "utf8"),
  );
  assert.equal(
    release.artifact.provenance.sourceRevision,
    `git:${revision}`,
    "Cached release must match committed source",
  );
} else {
  await packRelease({
    appId: bonsai.appId,
    sourceDirectory: repository,
    sourceRevision: `git:${revision}`,
    packageStoreDirectory: execFileSync("pnpm", ["store", "path"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    recipe: committedAppRecipe(repository, bonsai, revision),
    outDirectory: releaseDirectory,
  });
}
const provider = await workflowGitProvider();
const config = parse(
  await readFile(`${root}deploy/wrangler.celld.jsonc`, "utf8"),
);
config.main = `${root}test/standalone/workflows-root.fixture.ts`;
config.vars = {
  ...config.vars,
  OYSTER_HOME_INSTALLATION: "bonsai",
  OYSTER_ORIGIN: tenantOrigin,
  GIT_ORIGIN: provider.origin,
};
await writeFile(`${work}/wrangler.json`, JSON.stringify(config));
// Wrangler reads a private file; no secret is present in argv or printed output.
await writeFile(`${work}/.dev.vars`, `OYSTER_OWNER_KEY=${key}\n`, {
  mode: 0o600,
});
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
    tenantHost,
    "--upstream-protocol",
    "https",
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
let browser;
/** A public Oyster App method call, parsed with its real wire contract. */
async function callBonsai(method, input, schema, credential) {
  const response = await globalThis.fetch(
    `${origin}/apps/bonsai/methods/${method}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  assert.equal(response.status, 200, `${method} must succeed`);
  return schema.parse(await response.json());
}
const visibilityResponse = z.object({
  visibility: z.enum(["public", "private"]),
});
/** The owner toggles the whole installation's anonymous visibility. */
async function setVisibility(visibility) {
  const response = await globalThis.fetch(
    `${origin}/api/installations/bonsai/visibility`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visibility }),
    },
  );
  assert.equal(
    response.status,
    200,
    `Visibility PUT (${visibility}) must succeed`,
  );
  return visibilityResponse.parse(await response.json());
}
/**
 * A real `git` invocation; an optional Bearer credential, never printed.
 * Always asynchronous: the local Artifacts provider answers `git`'s network
 * calls from this same process, so a synchronous child would block the event
 * loop the provider needs and deadlock (reviews/git-fork-push-hang-2026-10-14.md).
 */
async function runGit(args, cwd, credential) {
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (credential) {
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "http.extraHeader";
    environment.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${credential}`;
  }
  const result = await promisify(execFile)("git", args, {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  return result.stdout;
}
const gitUrl = (name) => `${origin}/git/bonsai/${encodeURIComponent(name)}.git`;
// The trusted #oyster-shell + per-window pane pattern
// (tourtois-home.browser.mjs:244-248) only applies when the loaded App's own
// declaration includes "team.workbenchHost" (packages/oyster/src/host.ts:1280)
// — only Tourtois declares that (apps/tourtois/package.json:120). Bonsai
// never does, so a direct /apps/bonsai/ visit always renders the single bare
// #oyster-app iframe (packages/oyster/src/host.ts:1321-1323), for the owner
// and an anonymous visitor alike. Confirmed empirically: a failure screenshot
// from this file showed Bonsai filling the whole viewport with no window
// chrome around it.
const bonsaiApp = (viewer) => viewer.frameLocator("#oyster-app");
async function runProof() {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      ready = await globalThis
        .fetch(`${origin}/login`, {
          signal: globalThis.AbortSignal.timeout(1_000),
        })
        .then(
          (response) => response.ok,
          () => false,
        );
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "Local Oyster did not start");
    const installed = await installRelease({
      directory: releaseDirectory,
      url: origin,
      key,
      installationId: "bonsai",
    });
    assert.equal(installed.status, 201, "Local Bonsai installation failed");
    const options = { origin, work: `${work}/seed`, ownerKeyFile: keyFile };
    await seedDemo({ ...options, phase: "prepare" });
    if (!process.env.BONSAI_SEED_NO_BROWSER)
      browser = await chromium.launch({ headless: true });
    // The owner makes the installation public, so a signed-out visitor can
    // reach the front door, then the private surface refuses them again.
    await setVisibility("public");
    if (browser) {
      const anonContext = await browser.newContext();
      try {
        const anonPage = await anonContext.newPage();
        await anonPage.goto(`${origin}/`);
        await anonPage
          .getByRole("button", { name: "Bonsai", exact: true })
          .click();
        const anonApp = bonsaiApp(anonPage);
        await anonApp
          .getByRole("link", { name: "koi-pond", exact: true })
          .first()
          .click();
        await anonApp.getByRole("link", { name: /^Code/ }).first().click();
        await anonApp
          .getByText("README.md", { exact: true })
          .waitFor({ timeout: 5_000 });
        await anonApp
          .locator(".bonsai-markdown")
          .getByRole("heading", { name: "koi-pond", level: 1 })
          .waitFor();
      } finally {
        await anonContext.close();
      }
    }
    const anonWork = `${work}/anon`;
    await mkdir(anonWork, { recursive: true });
    const publicClone = `${anonWork}/public-clone`;
    await runGit(["clone", "-q", gitUrl("koi-pond"), publicClone]);
    const base = await callBonsai(
      "repos.get",
      { repo: "koi-pond" },
      repoDetail,
      key,
    );
    const mainHead = base.refs.find(
      (ref) => ref.name === "refs/heads/main",
    )?.hash;
    assert.ok(mainHead, "koi-pond must already carry a pushed base head");
    assert.equal(
      (await runGit(["rev-parse", "HEAD"], publicClone)).trim(),
      mainHead,
      "An anonymous clone's HEAD must equal the real pushed base head",
    );
    await writeFile(`${publicClone}/anonymous-probe.txt`, "anonymous\n");
    await runGit(["add", "."], publicClone);
    await runGit(
      [
        "-c",
        "user.name=anon",
        "-c",
        "user.email=anon@example.com",
        "commit",
        "-qm",
        "Anonymous probe commit",
      ],
      publicClone,
    );
    let anonPushRefusal = null;
    try {
      await runGit(["push", gitUrl("koi-pond"), "main"], publicClone);
    } catch (cause) {
      anonPushRefusal = String(cause.stderr ?? cause.message ?? "");
    }
    assert.ok(anonPushRefusal, "An anonymous push must be refused");
    // Without a Basic-auth challenge header, an unauthenticated git CLI
    // refuses to even ask ("terminal prompts disabled") before it ever shows
    // the real status; read that status directly from the same ref
    // advertisement request git itself made.
    const anonPushStatus = await globalThis.fetch(
      `${gitUrl("koi-pond")}/info/refs?service=git-receive-pack`,
    );
    assert.match(
      String(anonPushStatus.status),
      /^4(01|03)$/u,
      "An anonymous push must be refused with 401 or 403",
    );
    await setVisibility("private");
    let privateCloneRefusal = null;
    try {
      await runGit([
        "clone",
        "-q",
        gitUrl("koi-pond"),
        `${anonWork}/private-clone`,
      ]);
    } catch (cause) {
      privateCloneRefusal = String(cause.stderr ?? cause.message ?? "");
    }
    assert.ok(
      privateCloneRefusal,
      "A clone of a private installation must be refused",
    );
    // Same masking as the anonymous push: read the real status directly.
    const privateCloneStatus = await globalThis.fetch(
      `${gitUrl("koi-pond")}/info/refs?service=git-upload-pack`,
    );
    assert.equal(
      privateCloneStatus.status,
      401,
      "A clone of a private installation must be refused with 401",
    );
    const capture = async (phase, changeNumber) => {
      if (!browser) return;
      for (const width of [1440, 390])
        for (const theme of ["latte", "mocha"]) {
          const page = await browser.newPage({
            viewport: { width, height: 1000 },
            colorScheme: theme === "latte" ? "light" : "dark",
          });
          const failures = [];
          page.on("pageerror", (cause) => failures.push(cause.message));
          await page.goto(`${origin}/login`);
          await page.getByLabel("Owner key").fill(key);
          await page.getByRole("button", { name: /sign in/i }).click();
          await page.goto(`${origin}/apps/bonsai/`);
          const app = bonsaiApp(page);
          await app
            .getByRole("link", { name: "koi-pond", exact: true })
            .first()
            .click();
          await app
            .getByRole("link", { name: "Overview", exact: true })
            .waitFor();
          await app
            .locator("html")
            .evaluate(
              (element, value) => element.setAttribute("data-theme", value),
              theme,
            );
          await app.locator('[data-tile="network"] svg[role="img"]').waitFor();
          await page.screenshot({
            path: `${shots}/${phase}-${width}-${theme}-overview.png`,
            fullPage: true,
          });
          const networkTile = app.locator('[data-tile="network"]');
          await networkTile
            .getByRole("button", { name: "Fit history", exact: true })
            .click();
          if (phase === "after") {
            const clipped = await networkTile
              .locator(".bonsai-network-lane button")
              .evaluateAll(
                (buttons) =>
                  buttons.filter((button) => {
                    const bounds = button.getBoundingClientRect();
                    return [...button.querySelectorAll("span")].some((span) => {
                      const range = globalThis.document.createRange();
                      range.selectNodeContents(span);
                      const text = range.getBoundingClientRect();
                      return (
                        text.right > bounds.right + 1 ||
                        text.bottom > bounds.bottom + 1
                      );
                    });
                  }).length,
              );
            assert.equal(
              clipped,
              0,
              "Every lane label and ahead/behind summary fits its button",
            );
          }
          await networkTile.screenshot({
            path: `${shots}/${phase}-${width}-${theme}-network-detail.png`,
          });
          await page.screenshot({
            path: `${shots}/${phase}-${width}-${theme}-network.png`,
            fullPage: true,
          });
          await app.getByRole("link", { name: /Changes/ }).click();
          if (changeNumber) {
            await app
              .getByRole("link", { name: new RegExp(`^#${changeNumber} ·`) })
              .click();
            await app
              .getByRole("heading", { name: new RegExp(`^#${changeNumber} `) })
              .waitFor();
            await expect(
              app.getByRole("button", { name: "Merge into main", exact: true }),
            ).toBeDisabled();
          } else {
            await expect(
              app.getByRole("link", { name: /Changes/ }),
            ).toHaveAttribute("aria-current", "page");
          }
          await page.screenshot({
            path: `${shots}/${phase}-${width}-${theme}-change.png`,
            fullPage: true,
          });
          assert.deepEqual(failures, []);
          await page.close();
        }
    };
    if (proof === "seed") await capture("before");
    const agentKeys = {};
    for (const name of ["morel", "chanterelle", "enoki"]) {
      const response = await globalThis.fetch(`${origin}/api/keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // Ear Tag contract (packages/oyster/src/keys.ts, origin/feat/oyster-ear-tag-keys):
        // every issued key names its own grants; this agent needs write
        // access to every installed App (git push, App methods) to fork,
        // push and open Changes as itself.
        body: JSON.stringify({
          name,
          grants: [{ capability: "apps.use", targets: { kind: "all" } }],
        }),
      });
      assert.equal(response.status, 201);
      const created = z
        .object({ plaintext: z.string().min(1) })
        .parse(await response.json());
      agentKeys[name] = created.plaintext;
    }
    if (browser) {
      await proveMcpFork({
        origin,
        agentKey: agentKeys.morel,
        ownerKey: key,
        browser,
        shots,
      });
    }
    if (proof === "mcp") {
      assert.ok(browser, "MCP App proof requires a browser");
      log(
        `PASS shipping Bonsai MCP: named Agent read, declined write unchanged, approved fork, real App UI at 1440/390. Shots: ${shots}/mcp`,
      );
      return { ok: true };
    }
    const agentKeysFile = `${work}/agent-keys.json`;
    await writeFile(agentKeysFile, JSON.stringify(agentKeys), { mode: 0o600 });
    // One owner page stays open, unreloaded, through the whole agent drip so
    // the live feed and the network's agent colours are the real poll, not a
    // fixture capture.
    let livePage = null;
    let liveApp = null;
    if (browser) {
      livePage = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await livePage.goto(`${origin}/login`);
      await livePage.getByLabel("Owner key").fill(key);
      await livePage.getByRole("button", { name: /sign in/i }).click();
      await livePage.goto(`${origin}/apps/bonsai/`);
      liveApp = bonsaiApp(livePage);
      await liveApp.locator('[data-tile="network"] svg[role="img"]').waitFor();
    }
    const proposed = await seedDemo({
      origin,
      work: options.work,
      agentKeysFile,
      phase: "agents",
    });
    assert.equal(proposed.phase, "awaiting-owner");
    assert.equal(proposed.changes.length, 3);
    assert.ok(proposed.changes.every((change) => change.state === "open"));
    const clean = proposed.changes.find((change) =>
      change.sourceRepo.endsWith("--morel"),
    );
    assert.ok(clean);
    if (liveApp) {
      // Still the same unreloaded page: the live poll must surface each
      // agent's push on its own, and colour each agent's beads consistently.
      // "Working now" (apps/bonsai/web/working-now.tsx), not the five-item
      // "Activity" feed just below it: seedDemo's agents phase also opens
      // and updates each Change right after its pushes, so by the time the
      // poll settles those Change events alone fill the Activity feed's
      // slice(0, 5) and morel's and chanterelle's push rows are already
      // crowded out. "Working now" has no such cap: it lists every agent
      // who pushed in the last 15 minutes, one row each, confirmed live.
      for (const name of ["morel", "chanterelle", "enoki"])
        await liveApp
          .locator("ul.bonsai-working li", { hasText: name })
          .first()
          .waitFor({ timeout: 20_000 });
      const networkTile = liveApp.locator('[data-tile="network"]');
      await networkTile
        .getByRole("button", { name: "Fit history", exact: true })
        .click();
      const beadFill = async (agentName) =>
        networkTile
          .locator(`g[aria-label$="by ${agentName}"] circle.bonsai-bead-core`)
          .evaluateAll((circles) =>
            circles.map((circle) => globalThis.getComputedStyle(circle).fill),
          );
      // The graph poll can still be catching up with the last agent's
      // pushes right after "Fit history"; wait for each agent's own bead
      // count to settle instead of reading a single snapshot.
      for (const name of ["morel", "enoki"])
        await expect
          .poll(async () => (await beadFill(name)).length, {
            timeout: 15_000,
          })
          .toBeGreaterThanOrEqual(3);
      const morelFills = await beadFill("morel");
      const enokiFills = await beadFill("enoki");
      assert.ok(morelFills.length >= 3, "morel must have its own beads");
      assert.ok(enokiFills.length >= 3, "enoki must have its own beads");
      assert.ok(
        morelFills.every((fill) => fill === morelFills[0]),
        "One agent's beads share one fill colour",
      );
      assert.ok(
        enokiFills.every((fill) => fill === enokiFills[0]),
        "One agent's beads share one fill colour",
      );
      assert.notEqual(
        morelFills[0],
        enokiFills[0],
        "Different agents' beads must not share a fill colour",
      );
    }
    const morelCommits = await callBonsai(
      "commits.list",
      { repo: "koi-pond--morel", ref: "main" },
      commitPage,
      key,
    );
    assert.ok(morelCommits.commits.length >= 3);
    // Most recent first: morel's own 3 commits, then the inherited base
    // history it forked from (pushed by the owner, not morel).
    for (const { commit, agent } of morelCommits.commits.slice(0, 3)) {
      assert.equal(agent, "morel", "commits.list must show the pushing agent");
      assert.equal(commit.author.name, "morel");
    }
    const calmerKoi = proposed.changes.find((change) =>
      change.sourceRepo.endsWith("--chanterelle"),
    );
    assert.ok(calmerKoi);
    if (liveApp) {
      // The live poll so far watched the installation dashboard itself; the
      // Changes tab lives inside koi-pond's own repo page.
      await liveApp
        .getByRole("link", { name: "koi-pond", exact: true })
        .first()
        .click();
      await liveApp
        .getByRole("link", { name: "Overview", exact: true })
        .waitFor();
      // Before any merge moves main, every freshly opened Change compares
      // against the exact same base: 3 ahead, 0 behind.
      await liveApp.getByRole("link", { name: /Changes/ }).click();
      // seedDemo's agents-phase receipt trims the Change record to
      // {number, sourceRepo, sourceRef, head, state, status}; calmerKoi.title
      // is undefined, so match the row by its known, present change number.
      const chanterelleRow = liveApp
        .locator("li", { hasText: `#${calmerKoi.number} ` })
        .first();
      await expect(chanterelleRow).toContainText("3 ahead");
      await expect(chanterelleRow).toContainText("0 behind");
      await liveApp
        .getByRole("link", { name: new RegExp(`^#${calmerKoi.number} ·`) })
        .click();
      await liveApp
        .getByRole("heading", { name: new RegExp(`^#${calmerKoi.number} `) })
        .waitFor();
      await expect(liveApp.getByText(/^3 ahead/)).toBeVisible();
      const filesTile = liveApp.locator('[data-tile="files"]');
      await expect(filesTile.getByText("src/fish.ts")).toBeVisible();
      await filesTile.getByText("src/fish.ts").click();
      await expect(
        liveApp.locator('[id="change-file-src/fish.ts"]'),
      ).toContainText("speed: 0.4");
    }
    await approvedOwnerMerge({
      origin,
      ownerKey: key,
      agentKey: agentKeys.morel,
      change: clean,
      workingTree: `${options.work}/morel`,
    });
    const receipt = await seedDemo(options);
    await capture("after", receipt.changes[0].number);
    const repeated = await seedDemo(options);
    assert.deepEqual(
      repeated,
      receipt,
      "Repeat seed must not add commits, keys or Changes",
    );
    assert.ok(
      provider.requests.some((path) => path.includes("git-receive-pack")),
      "Proof must use real smart HTTP pushes",
    );
    if (liveApp) {
      // Still the chanterelle Change page, still unreloaded: Approve then
      // Merge through the real buttons.
      await liveApp
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      await expect(liveApp.getByRole("status")).toHaveText(
        /^Approved [0-9a-f]{7}\.$/u,
        { timeout: 15_000 },
      );
      await liveApp
        .getByRole("button", { name: "Merge into main", exact: true })
        .click();
      // The queued merge completes in the background; give it real room to
      // settle past "Merging…" instead of racing a short UI timeout.
      await expect(liveApp.getByRole("status")).toHaveText(
        /^Merged as [0-9a-f]{7}\.$/u,
        { timeout: 30_000 },
      );
      // The enoki Change now really conflicts with the merged main: real
      // paths, no canned fixture.
      const enokiChange = proposed.changes.find((change) =>
        change.sourceRepo.endsWith("--enoki"),
      );
      assert.ok(enokiChange);
      await liveApp.getByRole("link", { name: /Changes/ }).click();
      const enokiLink = liveApp.getByRole("link", {
        name: new RegExp(`^#${enokiChange.number} ·`),
      });
      await enokiLink.click();
      // Conflict detection is lazy: nothing records a conflict until a real
      // merge attempt runs against the current main, through the same
      // queued changes.merge as a clean merge ("Merging…" settling to
      // "Conflicts in <paths>." here instead of "Merged as <hash>.").
      await liveApp
        .getByRole("button", { name: "Merge into main", exact: true })
        .click();
      await expect(liveApp.getByRole("status")).toHaveText(
        /^Conflicts in .*\.$/u,
        { timeout: 30_000 },
      );
      await expect(liveApp.getByText("src/pond.ts").first()).toBeVisible();
      // Pull main into enoki's own fork, resolve the real conflict, and push
      // with enoki's own key.
      const enokiDirectory = `${options.work}/enoki`;
      await runGit(
        ["fetch", "-q", gitUrl("koi-pond"), "main"],
        enokiDirectory,
        agentKeys.enoki,
      );
      // A real conflicting merge exits non-zero, exactly like the server found.
      const realConflict = await runGit(
        ["merge", "--no-edit", "FETCH_HEAD"],
        enokiDirectory,
      ).then(
        () => false,
        () => true,
      );
      assert.ok(
        realConflict,
        "Pulling main into enoki's fork must really conflict on src/pond.ts",
      );
      const conflicted = await readFile(
        `${enokiDirectory}/src/pond.ts`,
        "utf8",
      );
      // Keep enoki's own twilight take; discard main's incoming colour. The
      // closing marker's label is git-version-dependent (the literal
      // "FETCH_HEAD" or its resolved commit hash), so match it loosely.
      const resolved = conflicted.replace(
        /<<<<<<< HEAD\n([\s\S]*?)\n=======\n[\s\S]*?\n>>>>>>> .*\n/u,
        "$1\n",
      );
      assert.notEqual(
        resolved,
        conflicted,
        "The real conflict markers must be present to resolve",
      );
      await writeFile(`${enokiDirectory}/src/pond.ts`, resolved);
      // README.md conflicts too: both morel's and enoki's sections were
      // appended at the same spot. Unlike the colour pick, keep both --
      // they're additive documentation, not competing values.
      const conflictedReadme = await readFile(
        `${enokiDirectory}/README.md`,
        "utf8",
      );
      const resolvedReadme = conflictedReadme.replace(
        /<<<<<<< HEAD\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> .*\n/u,
        "$1\n$2\n",
      );
      assert.notEqual(
        resolvedReadme,
        conflictedReadme,
        "The real README conflict markers must be present to resolve",
      );
      await writeFile(`${enokiDirectory}/README.md`, resolvedReadme);
      await runGit(["add", "-A"], enokiDirectory);
      await runGit(
        [
          "-c",
          "user.name=enoki",
          "-c",
          "user.email=enoki@agents.bonsai",
          "commit",
          "-qm",
          "Resolve the twilight palette conflict with main",
        ],
        enokiDirectory,
      );
      await runGit(
        ["push", "-q", gitUrl(`koi-pond--enoki`), "main"],
        enokiDirectory,
        agentKeys.enoki,
      );
      await expect(liveApp.getByText(/conflicts in/iu)).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(
        liveApp.getByRole("button", { name: "Merge into main", exact: true }),
      ).toBeEnabled({ timeout: 15_000 });
      await liveApp
        .getByRole("button", { name: "Merge into main", exact: true })
        .click();
      // The queued merge completes in the background; give it real room to
      // settle past "Merging…" instead of racing a short UI timeout.
      await expect(liveApp.getByRole("status")).toHaveText(
        /^Merged as [0-9a-f]{7}\.$/u,
        { timeout: 30_000 },
      );
      // The owner pushes their own branch directly and opens a Change on it;
      // as the Team's sole member, their own Approve records as self.
      const topicDirectory = `${work}/topic`;
      await runGit(
        ["clone", "-q", gitUrl("koi-pond"), topicDirectory],
        work,
        key,
      );
      await runGit(["checkout", "-q", "-b", "topic"], topicDirectory);
      await writeFile(
        `${topicDirectory}/TOPIC.md`,
        "# Topic\n\nThe owner's own branch, merged without another reviewer.\n",
      );
      await runGit(["add", "."], topicDirectory);
      await runGit(
        [
          "-c",
          "user.name=owner",
          "-c",
          "user.email=owner@bonsai.local",
          "commit",
          "-qm",
          "Add a topic note",
        ],
        topicDirectory,
      );
      await runGit(
        ["push", "-q", gitUrl("koi-pond"), "topic"],
        topicDirectory,
        key,
      );
      // The pushed branch can briefly lag the repo's own read-copy; retry
      // until the backend actually sees "topic", instead of racing it.
      let topicChange = null;
      let topicOpenFailure = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await globalThis.fetch(
          `${origin}/apps/bonsai/methods/changes.open`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              repo: "koi-pond",
              sourceRef: "topic",
              title: "Add a topic note",
            }),
            signal: globalThis.AbortSignal.timeout(30_000),
          },
        );
        if (response.status === 200) {
          topicChange = changeRecord.parse(await response.json());
          break;
        }
        topicOpenFailure = await response.text();
        await delay(250);
      }
      assert.ok(
        topicChange,
        `changes.open for the owner's topic branch never succeeded: ${topicOpenFailure}`,
      );
      await liveApp.getByRole("link", { name: /Changes/ }).click();
      await liveApp
        .getByRole("link", { name: new RegExp(`^#${topicChange.number} ·`) })
        .click();
      await liveApp
        .getByRole("heading", {
          name: new RegExp(`^#${topicChange.number} `),
        })
        .waitFor();
      await liveApp
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      await expect(liveApp.getByRole("status")).toHaveText(
        /^Approved [0-9a-f]{7}\.$/u,
        { timeout: 15_000 },
      );
      await expect(liveApp.getByText("self-approved")).toBeVisible();
      await liveApp
        .getByRole("button", { name: "Merge into main", exact: true })
        .click();
      // The queued merge completes in the background; give it real room to
      // settle past "Merging…" instead of racing a short UI timeout.
      await expect(liveApp.getByRole("status")).toHaveText(
        /^Merged as [0-9a-f]{7}\.$/u,
        { timeout: 30_000 },
      );
      await livePage.close();
    }
    // A fresh probe repository can be deleted outright; the canonical
    // koi-pond, which still has forks, refuses.
    const probeName = `probe-${randomBytes(4).toString("hex")}`;
    const createdProbe = await callBonsai(
      "repos.create",
      { name: probeName },
      repoSummary,
      key,
    );
    assert.equal(createdProbe.name, probeName);
    const listedWithProbe = await callBonsai("repos.list", {}, repoPage, key);
    assert.ok(listedWithProbe.repos.some((repo) => repo.name === probeName));
    const deletedProbe = await callBonsai(
      "repos.delete",
      { repo: probeName },
      repositoryDeletion,
      key,
    );
    assert.equal(deletedProbe.deleted, true);
    const listedWithoutProbe = await callBonsai(
      "repos.list",
      {},
      repoPage,
      key,
    );
    assert.ok(
      !listedWithoutProbe.repos.some((repo) => repo.name === probeName),
    );
    let probeCloneRefusal = null;
    try {
      await runGit(
        ["clone", "-q", gitUrl(probeName), `${work}/probe-clone`],
        work,
        key,
      );
    } catch (cause) {
      probeCloneRefusal = String(cause.stderr ?? cause.message ?? "");
    }
    assert.ok(probeCloneRefusal, "A deleted repository must refuse a clone");
    const probeCloneStatus = await globalThis.fetch(
      `${gitUrl(probeName)}/info/refs?service=git-upload-pack`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    assert.equal(
      probeCloneStatus.status,
      404,
      "A deleted repository must refuse a clone with 404",
    );
    const koiPondDeleteResponse = await globalThis.fetch(
      `${origin}/apps/bonsai/methods/repos.delete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo: "koi-pond" }),
      },
    );
    assert.equal(
      koiPondDeleteResponse.status,
      409,
      "Deleting a repository that still has forks must be refused",
    );
    log(
      `PASS public-interface Bonsai demo: three agents, nine commits, passed check, owner merge, open Change, conflict, repeat no-op. Shots: ${shots}`,
    );
    return { ok: true };
  } catch (cause) {
    // Give the worker's own stdout/stderr pipe a moment to flush before the
    // finally block below kills it, so the captured receipt isn't missing
    // whatever it just logged about this exact failure.
    await delay(500);
    if (browser) {
      for (const context of browser.contexts())
        for (const page of context.pages()) {
          await page.screenshot({
            path: `${work}/failure.png`,
            fullPage: true,
          });
        }
    }
    // Native host output can contain its ephemeral owner key; redact before receipt.
    await writeFile(
      `${work}/worker.log`,
      output.split(key).join("[redacted]"),
      {
        mode: 0o600,
      },
    );
    error(
      `Local demo proof failed: ${cause instanceof Error ? cause.message.split(key).join("[redacted]") : "unknown failure"}. Receipt: ${work}`,
    );
    return { ok: false };
  } finally {
    await browser?.close();
    worker.kill("SIGTERM");
    await stopped;
    await provider.close();
  }
}
const result = await runProof();
if (!result.ok) process.exitCode = 1;
