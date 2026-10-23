import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { URL } from "node:url";
import { chromium } from "playwright";
import { createOyster } from "../dist/host.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { homePageFixture } from "./home-page.fixture.mjs";
import {
  installationObservationSignal,
  observeInstallation,
} from "../dist/installation-client.js";
import {
  installationCommandIds,
  installationOperationSchema,
} from "../dist/installation-operations.js";

async function shellPage(t, approved) {
  const app = await homePageFixture({
    approved,
    shellModule: true,
    pageScript: null,
    shellCode: `
      document.documentElement.dataset.shellImported = "yes";
      export const mountShell = async (root) => {
        document.documentElement.dataset.shellMounted = "yes";
        const marker = document.createElement("h1");
        marker.id = "shell-probe-mounted";
        marker.textContent = "Approved shell loaded";
        root.appendChild(marker);
        return () => marker.remove();
      };
    `,
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const imports = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/shell.js"))
      imports.push(request.url());
  });
  await page.route("http://localhost/**", async (route) => {
    const request = route.request();
    const response = await app.request(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: request.postDataBuffer() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return { app, page, imports };
}

async function assertShellRefused(page, imports) {
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator("#shell-probe-mounted").count(), 0);
  assert.deepEqual(imports, []);
  assert.equal(await page.locator("#oyster-app").count(), 1);
  assert.deepEqual(
    await page.evaluate(() => ({
      imported:
        globalThis.document.documentElement.dataset.shellImported ?? null,
      mounted: globalThis.document.documentElement.dataset.shellMounted ?? null,
    })),
    { imported: null, mounted: null },
  );
}

test("an empty shell grant never imports or mounts the next home page's shell", async (t) => {
  const { page, imports } = await shellPage(t, false);
  await page.goto("http://localhost/apps/desktop/");
  await assertShellRefused(page, imports);
});

test("an approved shell loads, but ordinary owner revocation refuses its next load", async (t) => {
  const { app, page, imports } = await shellPage(t, true);
  await page.goto("http://localhost/apps/desktop/");
  await page.getByRole("heading", { name: "Approved shell loaded" }).waitFor();
  assert.deepEqual(
    imports.map((url) => new URL(url).pathname),
    [
      "/ui-entry/desktop/rel_desktop/shell.js",
      "/ui/desktop/rel_desktop/shell.js",
    ],
  );
  const projectionResponse = await app.request(
    "/api/installations/desktop/grants",
    {
      headers: { Accept: "application/json" },
    },
  );
  assert.equal(projectionResponse.status, 200);
  const projection = await projectionResponse.json();
  const revoked = await app.request("/api/installations/desktop/grants", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeGeneration: "fixture-generation",
      authorityVersion: projection.permissions.authority.authorityVersion,
      artifactDigest: projection.artifactDigest,
      command: {
        kind: "change-grants",
        changes: [{ capability: "team.workbenchHost", grant: null }],
      },
    }),
  });
  assert.equal(revoked.status, 200);
  // Next-load admission is not eviction of already-running trusted-origin code.
  assert.equal(await page.locator("#shell-probe-mounted").count(), 1);
  imports.length = 0;
  await page.reload();
  await assertShellRefused(page, imports);
});

test("a tombstoned approved shell is not imported or mounted on its next load", async (t) => {
  const { app, page, imports } = await shellPage(t, true);
  await page.goto("http://localhost/apps/desktop/");
  await page.getByRole("heading", { name: "Approved shell loaded" }).waitFor();
  assert.deepEqual(
    imports.map((url) => new URL(url).pathname),
    [
      "/ui-entry/desktop/rel_desktop/shell.js",
      "/ui/desktop/rel_desktop/shell.js",
    ],
  );
  const deleted = await app.request("/api/installations/desktop", {
    method: "DELETE",
  });
  assert.equal(deleted.status, 204);
  imports.length = 0;
  const nextLoad = await page.reload();
  assert.equal(nextLoad.status(), 404);
  await page.waitForLoadState("networkidle");
  assert.deepEqual(imports, []);
  assert.equal(await page.locator("#shell-probe-mounted").count(), 0);
  assert.deepEqual(
    await page.evaluate(() => ({
      imported:
        globalThis.document.documentElement.dataset.shellImported ?? null,
      mounted: globalThis.document.documentElement.dataset.shellMounted ?? null,
    })),
    { imported: null, mounted: null },
  );
});

test("owner consent submits explicit Release-bound approvals through the installation gate", async () => {
  const browser = await chromium.launch({ headless: true });
  const output = new globalThis.URL(
    "file:///home/levi/Botanical-cto/lanes/video/app-permissions-01/",
  );
  await mkdir(output, { recursive: true });
  const links = [];
  try {
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const host = await computerHost(
          {
            actor: { kind: "member", memberId: "fixture-owner" },
            role: "owner",
          },
          null,
          {
            displayName: "Bonsai",
            capabilities: [
              "computer.execute",
              "app.events.emit",
              "agent.manage",
            ],
          },
        );
        const installed = await host.installations.get("context-probe");
        let current = {
          ...installed,
          authority: {
            ...installed.authority,
            approvedGrants: installed.authority.approvedGrants.filter(
              (grant) => grant.capability !== "app.events.emit",
            ),
          },
        };
        const requests = [];
        const app = createOyster({
          ...host,
          installations: {
            generation: async () => "fixture-generation",
            list: async () => [current],
            get: async (id) => (id === current.installationId ? current : null),
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
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        await page.route("http://oyster.test/**", async (route) => {
          const request = route.request();
          if (request.method() === "PUT")
            requests.push(JSON.parse(request.postData()));
          const response = await app.request(request.url(), {
            method: request.method(),
            headers: request.headers(),
            body: request.postDataBuffer() ?? undefined,
          });
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        await page.goto("http://oyster.test/");
        const link = page.getByRole("link", { name: "App access" });
        links.push(await link.count());
        await link.click();
        await page
          .getByRole("heading", { name: "Bonsai permissions" })
          .waitFor();
        const send = page.getByRole("checkbox", { name: "Send events" });
        assert.equal(await send.isChecked(), false);
        await page.screenshot({
          path: new globalThis.URL(
            `permissions-before-save-${width}-${theme}.png`,
            output,
          ).pathname,
          fullPage: true,
        });
        await send.check();
        await page.getByRole("button", { name: "Save permissions" }).click();
        await page
          .getByRole("status")
          .filter({ hasText: "Permissions saved" })
          .waitFor();
        assert.equal(requests.length, 1);
        assert.equal(
          requests[0].authorityVersion,
          installed.authority.authorityVersion,
        );
        assert.equal(
          requests[0].artifactDigest,
          installed.release.artifact.artifactDigest,
        );
        assert.equal(
          current.authority.authorityVersion,
          installed.authority.authorityVersion + 1,
        );
        assert.deepEqual(current.release, installed.release);
        assert.equal(
          current.authority.approvedGrants.find(
            (grant) => grant.capability === "app.events.emit",
          )?.capabilityApproved,
          true,
        );
        assert.equal(
          await page.evaluate(
            () =>
              globalThis.document.documentElement.scrollWidth >
              globalThis.innerWidth,
          ),
          false,
        );
        await page.reload();
        assert.equal(
          await page.getByRole("checkbox", { name: "Send events" }).isChecked(),
          true,
        );
        assert.equal(requests.length, 1);
        await page.screenshot({
          path: new globalThis.URL(
            `permissions-reloaded-${width}-${theme}.png`,
            output,
          ).pathname,
          fullPage: true,
        });
        await page.close();
      }
    assert.deepEqual(links, [1, 1, 1, 1]);
  } finally {
    await browser.close();
  }
});

test("a Permissions tab open across delete and reinstall cannot save onto the new installation", async (t) => {
  const app = await homePageFixture({ approved: false });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("http://localhost/**", async (route) => {
    const request = route.request();
    const response = await app.request(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: request.postDataBuffer() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  const open = async (installationId) => {
    const page = await context.newPage();
    await page.goto(
      `http://localhost/api/installations/${installationId}/grants`,
    );
    await page
      .getByRole("heading", { name: `${installationId} permissions` })
      .waitFor();
    return page;
  };
  const record = async (installationId) =>
    (await (await app.request("/api/installations")).json()).find(
      (row) => row.installationId === installationId,
    );
  const json = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const stale = await open("desktop");
  const original = await record("desktop");
  const deleted = await app.request("/api/installations/desktop", {
    method: "DELETE",
  });
  assert.equal(deleted.status, 204);
  // The deleted id is retired: nothing installs under it again.
  const reuse = await app.request("/api/installations/desktop/release", {
    ...json("PUT", original.release),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": installationCommandIds.request.generate(),
    },
  });
  assert.deepEqual(
    { status: reuse.status, body: await reuse.json() },
    { status: 409, body: { error: "unavailable" } },
  );
  // A reinstall mints a new installation id with fresh grants.
  const requestId = installationCommandIds.request.generate();
  const admitted = await app.request("/api/installations", {
    ...json("POST", { installationId: "desktop", release: original.release }),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
  });
  assert.equal(admitted.status, 202);
  const initial = installationOperationSchema.parse(await admitted.json());
  assert.equal(initial.requestId, requestId);
  const reinstalled = await observeInstallation({
    requestId,
    initial,
    signal: installationObservationSignal({}),
    read: async () => {
      const response = await app.request(
        `/api/installations/desktop/status?requestId=${encodeURIComponent(requestId)}`,
      );
      assert.equal(response.status, 200);
      const operation = installationOperationSchema.parse(
        await response.json(),
      );
      assert.equal(operation.requestId, requestId);
      return operation;
    },
  });
  assert.equal(reinstalled.state, "succeeded");
  assert.equal(reinstalled.creation, "reminted");
  const fresh = reinstalled.installation;
  assert.notEqual(fresh.installationId, "desktop");
  assert.ok(
    !fresh.authority.approvedGrants.some(
      (grant) => grant.capability === "team.workbenchHost",
    ),
  );

  // The tab still shows the deleted installation; it tries to approve the shell.
  await stale.getByRole("checkbox", { name: "Arrange the workbench" }).check();
  await stale.getByRole("button", { name: "Save permissions" }).click();
  await stale.waitForFunction(
    () =>
      (globalThis.document.querySelector('[role="status"]')?.textContent ??
        "") !== "",
  );
  assert.deepEqual(
    {
      status: await stale.getByRole("status").textContent(),
      retired: (await record("desktop")).status,
      fresh: (await record(fresh.installationId)).authority,
    },
    {
      status: "This App is no longer available. Reload before trying again.",
      retired: "deleted",
      fresh: fresh.authority,
    },
  );

  const page = await open(fresh.installationId);
  const shell = page.getByRole("checkbox", { name: "Arrange the workbench" });
  assert.equal(await shell.isChecked(), false);
  await shell.check();
  await page.getByRole("button", { name: "Save permissions" }).click();
  await page.getByText("Permissions saved").waitFor();
  const saved = await record(fresh.installationId);
  assert.equal(
    saved.authority.authorityVersion,
    fresh.authority.authorityVersion + 1,
  );
  assert.ok(
    saved.authority.approvedGrants.some(
      (grant) => grant.capability === "team.workbenchHost",
    ),
  );
});
