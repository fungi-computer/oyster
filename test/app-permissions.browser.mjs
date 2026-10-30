import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import tourtoisManifest from "../../../apps/tourtois/package.json" with { type: "json" };
import { homePageFixture } from "./home-page.fixture.mjs";

// Minimal shell chrome; Settings itself is the actual Tourtois Release module.
// Oyster still imports and admits this module through its real home-page path.
async function settingsShell() {
  const settings = new globalThis.URL(
    "../../../apps/tourtois/src/oyster-platform-controls.tsx",
    import.meta.url,
  ).pathname;
  const result = await build({
    stdin: {
      contents: `
        import { mountPlatformControls as mountSettings } from ${JSON.stringify(settings)};
        let settings;
        export const mountPlatformControls = async (root, input) => {
          settings = await mountSettings(root, input);
          return settings;
        };
        export const mountShell = async (root) => {
          const button = document.createElement("button");
          button.textContent = "System Settings";
          button.onclick = () => settings.controls.openSettings({ category: "home" }, { restoreFocus: false });
          root.append(button);
          return () => button.remove();
        };
      `,
      resolveDir: new globalThis.URL("../", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    outdir: new globalThis.URL(
      "../../../.botanical/permissions/browser",
      import.meta.url,
    ).pathname,
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl" },
    logLevel: "warning",
  });
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
  assert.ok(script, "Tourtois Settings browser bundle exists");
  return `
    const styles = document.createElement("style");
    styles.textContent = ${JSON.stringify(css?.text ?? "")};
    document.head.append(styles);
    ${script.text}
  `;
}

async function appPermissionsProof(t, control = {}) {
  const shellCode = await settingsShell();
  const output =
    process.env.OYSTER_PERMISSIONS_SCREENSHOT_DIR ??
    new globalThis.URL(
      "../../../.botanical/permissions/screenshots/",
      import.meta.url,
    ).pathname;
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1400, 390]) {
    for (const theme of ["mocha", "latte"]) {
      let app;
      let directoryReads = 0;
      app = await homePageFixture({
        approved: true,
        shellModule: true,
        pageScript: null,
        shellCode,
        // This is the host's metadata port, not grant or admission authority.
        rootDirectory: async () => {
          directoryReads++;
          const installations = await (
            await app.request("/api/installations")
          ).json();
          return {
            apps: installations
              .filter((row) => row.status === "enabled")
              .map((row) => ({
                address: {
                  kind: "installation",
                  installationId: row.installationId,
                },
                installationId: row.installationId,
                surfaceId: `installation:${row.installationId}`,
                appId: row.appId,
                displayName: tourtoisManifest.fungi.app.displayName,
                icon: tourtoisManifest.fungi.app.icon,
                releaseId: row.release.releaseId,
                authorityVersion: row.authority.authorityVersion,
                enforcement: null,
                handlers: [],
                roles: [],
                declaredCapabilities: ["team.workbenchHost"],
                commands: [],
                gills: [],
                availability: "available",
                surface: { stableRoute: `/apps/${row.installationId}/` },
                surfacePath: `/apps/${row.installationId}/`,
              })),
            roles: {},
          };
        },
      });
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: theme === "mocha" ? "dark" : "light",
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      const errors = [];
      let writes = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      if (control.blockFrame)
        page.on("console", (message) =>
          control.cspViolations.push(message.text()),
        );
      if (control.dropMessages)
        await page.addInitScript(() => {
          // Falsify only the transport; do not replace either real editor.
          if (globalThis.window === globalThis.window.top)
            globalThis.window.postMessage = () => undefined;
        });
      await page.route("http://localhost/**", async (route) => {
        const request = route.request();
        if (
          request.method() === "PUT" &&
          new globalThis.URL(request.url()).pathname ===
            "/api/installations/desktop/grants"
        )
          writes++;
        const response = await app.request(request.url(), {
          method: request.method(),
          headers: request.headers(),
          body: request.postDataBuffer() ?? undefined,
        });
        const headers = Object.fromEntries(response.headers);
        if (
          control.blockFrame &&
          request.isNavigationRequest() &&
          new globalThis.URL(request.url()).pathname ===
            "/api/installations/desktop/grants"
        )
          headers["content-security-policy"] = "frame-ancestors 'none'";
        await route.fulfill({
          status: response.status,
          headers,
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.goto("http://localhost/apps/desktop/");
      await page
        .getByRole("button", { name: "System Settings", exact: true })
        .click();
      if (width === 390) {
        await page
          .getByRole("combobox", { name: "Settings category" })
          .selectOption({ label: "Tourtois" });
      } else {
        await page
          .getByRole("button", { name: "App permissions", exact: true })
          .first()
          .click();
        await page
          .getByRole("button", { name: "Tourtois", exact: false })
          .last()
          .click();
      }
      const heading = page.locator(".tourtois-settings-app-heading").filter({
        hasText: "Tourtois",
      });
      await heading.waitFor();
      assert.equal(await heading.locator('[data-sigil="tourtois"]').count(), 1);
      const nav = page.getByRole("navigation", {
        name: "Settings categories",
        includeHidden: true,
      });
      assert.equal(
        await nav
          .getByRole("button", {
            name: "Tourtois",
            exact: true,
            includeHidden: true,
          })
          .locator('[data-sigil="tourtois"]')
          .count(),
        1,
      );
      assert.equal(await page.locator(".caps-monogram").count(), 0);
      const permissions = page.frameLocator('iframe[title="App permissions"]');
      const shell = permissions.getByLabel("Shell permissions", {
        exact: true,
      });
      await shell
        .getByRole("button", { name: "Revoke", exact: true })
        .waitFor({ timeout: 5000 })
        .catch((cause) => {
          throw new Error("Oyster grants iframe must load", { cause });
        });
      assert.equal(await shell.getByLabel("Shell allowed").count(), 1);
      assert.equal(await shell.locator("[data-sigil]").count(), 1);
      assert.equal(await shell.getByRole("checkbox").count(), 0);
      assert.equal(
        await permissions
          .getByText("Shell (full access)", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await permissions
          .getByRole("heading", { name: "shell", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await permissions
          .getByRole("button", { name: "Save permissions", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("tab", { name: "Permissions", exact: true })
          .getAttribute("aria-selected"),
        "true",
      );
      assert.ok(
        await permissions
          .getByText("Only pick a shell you trust.", { exact: false })
          .count(),
      );
      const revoke = shell.getByRole("button", { name: "Revoke", exact: true });
      assert.ok((await revoke.getAttribute("class")).includes("btn-xs"));
      const row = await shell.getByRole("listitem").boundingBox();
      assert.equal(
        await shell.getByText("Shell", { exact: true }).evaluate((element) => {
          const text = globalThis.document.createRange();
          text.selectNodeContents(element);
          return text.getClientRects().length;
        }),
        1,
        "Shell label stays on one line",
      );
      await page.evaluate(() => globalThis.document.fonts.ready);
      assert.equal(
        await page.evaluate(() =>
          [...globalThis.document.fonts].some(
            (font) => font.family === "Nunito" && font.status === "loaded",
          ),
        ),
        true,
        "Settings screenshots use the loaded Nunito face",
      );
      assert.equal(await page.evaluate(() => globalThis.devicePixelRatio), 2);
      await permissions
        .locator("html")
        .evaluate((element) => element.ownerDocument.fonts.ready);
      assert.equal(
        await permissions
          .locator("html")
          .evaluate((element) =>
            [...element.ownerDocument.fonts].some(
              (font) => font.family === "Nunito" && font.status === "loaded",
            ),
          ),
        true,
        "Framed permissions use the loaded Nunito face",
      );
      assert.equal(
        await permissions.locator("html").getAttribute("data-theme"),
        theme,
      );
      assert.equal(
        await permissions.locator(".caps-centered-card-stage").count(),
        0,
        "Settings owns the page chrome; framed permissions have no standalone card",
      );
      const assertNativeFrame = async () => {
        await page.waitForFunction(() => {
          const frame = globalThis.document.querySelector(
            'iframe[title="App permissions"]',
          );
          const document = frame?.contentDocument;
          return (
            document &&
            Math.abs(
              frame.clientHeight - document.body.getBoundingClientRect().height,
            ) <= 1 &&
            document.documentElement.scrollHeight <= frame.clientHeight + 1
          );
        });
        const frame = await page
          .locator('iframe[title="App permissions"]')
          .boundingBox();
        const form = await permissions.locator("form").boundingBox();
        const header = await page
          .locator(".tourtois-settings-app-header")
          .boundingBox();
        assert.ok(frame && form && header);
        assert.ok(
          Math.abs(frame.x - header.x) <= 1 &&
            Math.abs(form.x - frame.x) <= 1 &&
            Math.abs(form.y - frame.y) <= 1,
          `Frame shares Settings padding without an inner page inset: ${JSON.stringify({ frame, form, header })}`,
        );
        assert.equal(
          await page
            .locator('iframe[title="App permissions"]')
            .evaluate(
              (element) => globalThis.getComputedStyle(element).borderWidth,
            ),
          "0px",
        );
      };
      await assertNativeFrame();
      assert.equal(
        await permissions
          .locator("html")
          .evaluate(
            (element) =>
              element.scrollWidth >
              element.ownerDocument.defaultView.innerWidth,
          ),
        false,
      );
      assert.equal(
        await permissions.getByRole("link", { name: "Back to Apps" }).count(),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.dataset.theme,
        ),
        theme,
      );
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollWidth >
            globalThis.innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: join(output, `permissions-${theme}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      assert.ok(
        row && row.height <= 44,
        `Shell stays a one-line settings row: ${JSON.stringify({ width, theme, row })}`,
      );
      await revoke.click();
      await shell.getByText("Revoke Shell access?", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Close System Settings", exact: true })
        .click();
      await page
        .getByText("Discard unsaved changes?", { exact: true })
        .waitFor({ timeout: 5000 })
        .catch((cause) => {
          throw new Error("Tourtois must consume framed dirty-state messages", {
            cause,
          });
        });
      await page
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await assertNativeFrame();
      assert.equal(writes, 0, "Opening inline confirmation does not write");
      await shell.getByRole("button", { name: "Cancel", exact: true }).click();
      await assertNativeFrame();
      assert.equal(writes, 0, "Cancelling keeps the saved Shell approval");
      await revoke.click();
      const readsBeforeSave = directoryReads;
      const refreshed = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new globalThis.URL(response.url()).pathname ===
            "/api/workbench/directory",
        { timeout: 5000 },
      );
      await shell
        .getByRole("button", { name: "Confirm revoke", exact: true })
        .click();
      assert.equal((await refreshed).status(), 200);
      assert.equal(
        directoryReads,
        readsBeforeSave + 1,
        "Tourtois consumes accepted from its actual frame and refreshes Settings",
      );
      await permissions
        .getByRole("status")
        .filter({ hasText: "Permissions saved." })
        .waitFor();
      assert.equal(writes, 1, "Confirmation commits one permission change");
      await shell
        .getByLabel("Shell not allowed")
        .waitFor({ state: "attached" });
      await assertNativeFrame();
      if (width === 1400 && theme === "latte")
        await page.screenshot({
          path: join(output, "permissions-latte-1400-after-save.png"),
          fullPage: true,
          animations: "disabled",
        });
      // A constrained Settings section, not its child document, owns overflow.
      await page.setViewportSize({ width, height: 260 });
      await assertNativeFrame();
      assert.equal(
        await page
          .locator(".tourtois-settings-content")
          .evaluate(
            (element) =>
              element.scrollHeight > element.clientHeight &&
              globalThis.getComputedStyle(element).overflowY === "auto",
          ),
        true,
        "Short windows scroll Settings, never an inner permission document",
      );
      await page.setViewportSize({ width, height: 900 });
      await assertNativeFrame();
      // The trusted-origin code already loaded is not evicted. Its next load
      // must be refused, and the owner must retain the shell-less consent link.
      await page.goto("http://localhost/");
      await page.getByRole("link", { name: "App access" }).click();
      const consent = page.getByLabel("Shell permissions", { exact: true });
      await consent
        .getByLabel("Shell not allowed")
        .waitFor({ state: "attached" });
      await consent.getByRole("button", { name: "Allow", exact: true }).click();
      await consent
        .getByRole("button", { name: "Confirm allow", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Permissions saved." })
        .waitFor();
      assert.equal(writes, 2);
      await page.reload();
      await consent.getByLabel("Shell allowed").waitFor({ state: "attached" });
      assert.equal(await page.locator(".caps-centered-card-stage").count(), 1);
      assert.equal(
        await page.getByRole("link", { name: "Back to Apps" }).count(),
        1,
        "Standalone recovery keeps its own page chrome and Back link",
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
}

test(
  "Oyster Settings and standalone consent share saved, revocable Shell permissions in both themes and widths",
  appPermissionsProof,
);

test("the Settings claim proof fails when CSP blocks the Oyster grants frame", async (t) => {
  const cspViolations = [];
  await assert.rejects(
    () => appPermissionsProof(t, { blockFrame: true, cspViolations }),
    { message: "Oyster grants iframe must load" },
  );
  assert.ok(
    cspViolations.some((message) => message.includes("frame-ancestors 'none'")),
    "Chromium actually enforced the falsifying frame-ancestors policy",
  );
});

test("the Settings claim proof fails when framed postMessage state cannot reach Tourtois", async (t) => {
  await assert.rejects(() => appPermissionsProof(t, { dropMessages: true }), {
    message: "Tourtois must consume framed dirty-state messages",
  });
});
