import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { error } from "node:console";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createOyster } from "../src/host.js";
import { computerHost } from "./computer-host.fixture.mjs";

const repository = fileURLToPath(
  new globalThis.URL("../../../", import.meta.url),
);
const output = `${repository}.botanical/standalone-allow`;
const shots = `${output}/screenshots`;
await mkdir(output, { recursive: true });
await mkdir(shots, { recursive: true });
const fixtureComputer = "fixture-computer";
const fileSets = new Map();
for (const computerId of [fixtureComputer, null]) {
  const bundle = await build({
    stdin: {
      contents: `
      import { mountPlatformControls } from "./apps/tourtois/src/oyster-platform-controls.tsx";
      import { keyWire } from "./packages/ear-tag/src/keys.ts";
      import { oysterKeyVocabulary } from "./packages/oyster/src/keys.ts";
      import { createShellAppAccess } from "./packages/oyster/src/page/app-access.ts";
      import { workbenchDirectorySchema } from "./packages/nacre/src/workbench-directory.ts";
      const mounted = await mountPlatformControls(document.getElementById("controls"), {
        teamId: "fixture",
        keysWire: keyWire(oysterKeyVocabulary),
        requestAppAccess: createShellAppAccess(async () =>
          workbenchDirectorySchema.parse(await (await fetch("/api/workbench/directory")).json())),
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.getElementById("request").onclick = async () => {
        document.getElementById("outcome").textContent = await mounted.controls.requestAppAccess(
          { surfaceId: "installation:context-probe", title: "Permission probe", computerId: ${JSON.stringify(computerId)} },
          { computers: ["computer.execute"] },
        );
      };
      document.getElementById("request").disabled = false;
    `,
      resolveDir: repository,
      loader: "js",
    },
    bundle: true,
    format: "esm",
    write: false,
    outdir: output,
    loader: {
      ".woff2": "file",
      ".woff": "file",
      ".svg": "file",
      ".png": "file",
    },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  fileSets.set(
    computerId,
    new Map(
      bundle.outputFiles.map((file) => [
        file.path.slice(output.length),
        file.contents,
      ]),
    ),
  );
}

for (const width of [1440, 390]) {
  for (const commit of ["saved", "stale", "refused", "missing-window"]) {
    test(`standalone Allow ${commit} at ${width}px`, async () => {
      const files = fileSets.get(
        commit === "missing-window" ? null : fixtureComputer,
      );
      assert.ok(files);
      const host = await computerHost(
        { actor: { kind: "member", memberId: "fixture-owner" }, role: "owner" },
        fixtureComputer,
        { displayName: "Permission probe", capabilities: ["computer.execute"] },
        [],
        ["computer.execute"],
      );
      const installed = await host.installations.get("context-probe");
      let current = {
        ...installed,
        authority: {
          ...installed.authority,
          approvedGrants: [],
        },
      };
      const app = createOyster({
        ...host,
        auth: {
          ...host.auth,
          authenticate: async (request) => {
            if (commit === "refused" && request.method === "PUT")
              return {
                kind: "admitted",
                principal: {
                  actor: { kind: "member", memberId: "fixture-owner" },
                  role: "member",
                },
              };
            return host.auth.authenticate(request);
          },
        },
        workbench: {
          directory: async () => ({
            roles: {},
            apps: [
              {
                address: {
                  kind: "installation",
                  installationId: "context-probe",
                },
                installationId: "context-probe",
                surfaceId: "installation:context-probe",
                appId: current.appId,
                displayName: "Permission probe",
                releaseId: current.release.releaseId,
                authorityVersion: current.authority.authorityVersion,
                enforcement: null,
                handlers: [],
                roles: [],
                commands: [],
                gills: [],
                declaredCapabilities: ["computer.execute"],
                availability: "available",
                surface: { stableRoute: "/apps/context-probe/" },
                surfacePath: "/apps/context-probe/",
              },
            ],
          }),
        },
        installations: {
          generation: async () => "fixture-generation",
          list: async () => [current],
          get: async (id) => (id === "context-probe" ? current : null),
          compareAndPut: async (next, expected, expectedGeneration) => {
            if (expectedGeneration !== "fixture-generation")
              return { ok: false, code: "stale_authority" };
            if (expected !== current.authority.authorityVersion)
              return { ok: false, code: "stale_authority" };
            current = next;
            return { ok: true };
          },
        },
      });
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        const commits = [];
        page.on("pageerror", error);
        await page.route("http://oyster.test/**", async (route) => {
          const request = route.request();
          const path = new globalThis.URL(request.url()).pathname;
          if (path === "/fixture") {
            await route.fulfill({
              contentType: "text/html",
              body: '<link rel="stylesheet" href="/stdin.css"><button disabled id="request">Request permission</button><output id="outcome"></output><div id="controls"></div><script type="module" src="/stdin.js"></script>',
            });
            return;
          }
          const file = files.get(path);
          if (file !== undefined) {
            await route.fulfill({
              body: Buffer.from(file),
              contentType: path.endsWith(".css")
                ? "text/css"
                : "text/javascript",
            });
            return;
          }
          if (commit === "stale" && request.method() === "PUT") {
            current = {
              ...current,
              authority: {
                ...current.authority,
                authorityVersion: current.authority.authorityVersion + 1,
              },
            };
          }
          const response = await app.request(request.url(), {
            method: request.method(),
            headers: request.headers(),
            body: request.postDataBuffer() ?? undefined,
          });
          if (request.method() === "PUT") commits.push(response.status);
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        await page.goto("http://oyster.test/fixture");
        await page.screenshot({
          path: `${shots}/fixture-${commit}-${width}.png`,
          fullPage: true,
        });
        await page.getByRole("button", { name: "Request permission" }).click();
        await page
          .getByRole("button", { name: "Allow", exact: true })
          .waitFor();
        await page.screenshot({
          path: `${shots}/allow-${commit}-dialog-${width}.png`,
          fullPage: true,
        });
        if (commit === "missing-window") {
          assert.equal(
            await page
              .getByRole("button", { name: "Allow", exact: true })
              .isDisabled(),
            true,
          );
          await page
            .getByText(
              "Allow for this window is unavailable on this Oyster. No access was changed. Use Customize to review Computer permissions explicitly.",
              { exact: true },
            )
            .waitFor();
          await page
            .getByRole("button", { name: "Not now", exact: true })
            .click();
        } else {
          await page
            .getByRole("button", { name: "Allow", exact: true })
            .click();
        }
        if (commit !== "saved") {
          await page
            .locator("#outcome")
            .filter({ hasText: "declined" })
            .waitFor();
          assert.deepEqual(
            commits,
            commit === "missing-window" ? [] : [commit === "stale" ? 409 : 403],
          );
          assert.equal(
            await page.locator("#outcome").textContent(),
            "declined",
          );
          await page.screenshot({
            path: `${shots}/allow-${commit}-failure-${width}.png`,
            fullPage: true,
          });
          assert.equal(
            await page
              .getByRole("button", { name: "Allow", exact: true })
              .count(),
            0,
          );
          const stored = await app.request(
            "http://oyster.test/api/installations/context-probe/grants",
            { headers: { Accept: "application/json" } },
          );
          assert.equal(stored.status, 200);
          assert.deepEqual(
            (await stored.json()).permissions.authority.approvedGrants,
            [],
          );
          const call = await app.request(
            "http://oyster.test/apps/context-probe/methods/context",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            },
          );
          assert.equal(call.status, 403);
          return;
        }
        await page.locator("#outcome").filter({ hasText: "granted" }).waitFor();
        assert.deepEqual(commits, [200]);
        const stored = await app.request(
          "http://oyster.test/api/installations/context-probe/grants",
          { headers: { Accept: "application/json" } },
        );
        assert.equal(stored.status, 200);
        assert.equal(
          (await stored.json()).permissions.authority.approvedGrants.some(
            (grant) => grant.capability === "computer.execute",
          ),
          true,
        );
        assert.equal(
          current.authority.approvedGrants.some(
            (grant) => grant.capability === "computer.execute",
          ),
          true,
        );
        const call = await app.request(
          "http://oyster.test/apps/context-probe/methods/context",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        assert.equal(call.status, 200);
        await page.reload();
        await page.getByRole("button", { name: "Request permission" }).click();
        await page.locator("#outcome").filter({ hasText: "granted" }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Allow", exact: true })
            .count(),
          0,
        );
        await page.goto(
          "http://oyster.test/api/installations/context-probe/grants",
        );
        await page
          .getByRole("heading", { name: "Permission probe permissions" })
          .waitFor();
        assert.equal(
          await page
            .getByRole("checkbox", { name: "Run commands", exact: true })
            .isChecked(),
          true,
        );
        await page.reload();
        assert.equal(
          await page
            .getByRole("checkbox", { name: "Run commands", exact: true })
            .isChecked(),
          true,
        );
        await page.screenshot({
          path: `${shots}/allow-saved-reloaded-${width}.png`,
          fullPage: true,
        });
      } finally {
        await browser.close();
      }
    });
  }
}
