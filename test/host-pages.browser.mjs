/* global Request, Headers, URL, URLSearchParams, fetch, document, getComputedStyle, innerWidth */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { chromium } from "playwright";
import { z } from "zod";
import { launchIsolatedChromium } from "../../../tooling/proof-runner/isolated-chromium.mjs";
import { createOyster } from "../dist/host.js";
import { ownerKeyAuth } from "../dist/auth.js";
import { startSignInLink } from "../dist/standalone/sign-in-link.js";
import { computerHost } from "./computer-host.fixture.mjs";
import { homePageFixture } from "./home-page.fixture.mjs";

const base = "http://127.0.0.1:8787";
const key = "oooooooooooooooooooooooooooooooo";
const shots = resolve(
  process.env.OYSTER_HOST_PAGE_SHOTS ?? ".botanical/host-page-shots",
);
const cases = [
  [
    "permissions",
    "/api/installations/context-probe/grants",
    "Choose what this App can do.",
  ],
  ["root", "/", "Your Apps, all together."],
  ["empty", "/", "A little room to grow."],
  ["login", "/login", "Welcome."],
  ["login-invalid", "/login", "That key didn’t open it."],
  ["key-help", "/login/key-help", "Let’s find your key."],
  ["signing-in", null, "Opening your Oyster…"],
  ["not-found", "/missing", "Nothing growing here."],
  ["server-error", "/apps/context-probe/", "That didn’t go through."],
  ["access-denied", "/apps/context-probe/", "This App is out of reach."],
  ["desktop-missing", "/", "Your desktop needs a hand."],
];

test(
  "host pages: real document routes, desktop and 390px, plus degraded and sign-in journeys",
  { timeout: 120_000 },
  async (t) => {
    await mkdir(shots, { recursive: true });
    const browser = await launchIsolatedChromium(chromium, [], {
      headless: true,
    });
    const ownerHost = await computerHost(
      { actor: { kind: "member", memberId: "fixture" }, role: "owner" },
      null,
      { displayName: "Hello" },
    );
    const authHost = { ...ownerHost, auth: ownerKeyAuth(key) };
    const restrictedHost = await computerHost(
      { actor: { kind: "team-key", keyId: "ungranted" } },
      null,
    );
    const receipt = [];

    async function visit(
      state,
      path,
      { width = 1280, javascript = true, fail = null, scheme = "dark" } = {},
    ) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: scheme,
        reducedMotion: "reduce",
        javaScriptEnabled: javascript,
      });
      const host =
        state === "access-denied"
          ? restrictedHost
          : state === "empty"
            ? {
                ...ownerHost,
                installations: {
                  ...ownerHost.installations,
                  list: async () => [],
                },
              }
            : state === "desktop-missing"
              ? { ...ownerHost, homeInstallationId: "missing" }
              : state === "server-error"
                ? {
                    ...ownerHost,
                    installations: {
                      ...ownerHost.installations,
                      get: () => {
                        throw new Error("fixture-private-build-diagnostic");
                      },
                    },
                  }
                : ["login", "login-invalid", "key-help", "signing-in"].includes(
                      state,
                    )
                  ? authHost
                  : ownerHost;
      const app =
        state === "shell-permissions"
          ? await homePageFixture({ approved: false })
          : createOyster(host);
      let helper;
      if (path === null) {
        helper = await startSignInLink({ oysterUrl: base, key });
      }
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (fail === "css" && url.pathname.endsWith(".css"))
          return route.abort();
        if (fail === "art" && /\.(json|avif)$/u.test(url.pathname))
          return route.abort();
        if (fail === "trace" && url.pathname.endsWith(".json"))
          return route.abort();
        let response;
        if (helper && url.origin === new URL(helper.url).origin)
          response = await fetch(request.url());
        else if (url.origin === base) {
          const headers = await request.allHeaders();
          // Exercise the invalid form's actual auth door, not a synthetic page.
          response =
            state === "login-invalid" &&
            url.pathname === "/login" &&
            request.isNavigationRequest()
              ? await app.request("/login", {
                  method: "POST",
                  headers: { Accept: "text/html" },
                  body: new URLSearchParams({ key: "wrong" }),
                })
              : await app.fetch(
                  new Request(request.url(), {
                    method: request.method(),
                    headers,
                    body: request.postDataBuffer(),
                  }),
                );
        } else return route.abort();
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      const page = await context.newPage();
      await page.goto(helper?.url ?? `${base}${path}`, {
        waitUntil: "networkidle",
      });
      await page.evaluate(() => document.fonts.ready);
      return {
        context,
        page,
        app,
        helper,
        close: async () => {
          await helper?.close();
          await context.close();
        },
      };
    }

    try {
      for (const [state, path, heading] of cases)
        for (const width of [1280, 390]) {
          await t.test(`${state} at ${width}px`, async () => {
            // The real single-use form's manual fallback is captured without JS;
            // automatic submission is proved separately below.
            const session = await visit(state, path, {
              width,
              javascript: state !== "signing-in",
            });
            try {
              const { page } = session;
              assert.equal(await page.locator("h1").innerText(), heading);
              assert.ok(await page.locator(".caps-trading-card").isVisible());
              const card = await page
                .locator(".caps-trading-card")
                .boundingBox();
              assert.ok(
                Math.abs(card.width / card.height - 5 / 7) < 0.01,
                "the full card keeps its 5:7 ratio",
              );
              assert.equal(await page.locator(".ability-steps li").count(), 3);
              assert.ok(
                await page
                  .locator(
                    state === "permissions"
                      ? "#oyster-consent a"
                      : ".actions a, .actions button",
                  )
                  .first()
                  .isVisible(),
              );
              if (state !== "signing-in")
                await page.locator(".ink-art[data-ready]").waitFor();
              else
                assert.ok(
                  await page
                    .locator(".ink-fallback")
                    .evaluate((img) => img.complete && img.naturalWidth > 0),
                );
              const metrics = await page.evaluate(() => ({
                headingFont: getComputedStyle(document.querySelector("h1"))
                  .fontFamily,
                monoFont: getComputedStyle(document.querySelector(".eyebrow"))
                  .fontFamily,
                background: getComputedStyle(document.body).backgroundColor,
                overflow: document.documentElement.scrollWidth > innerWidth,
              }));
              assert.match(metrics.headingFont, /Nunito/u);
              assert.match(metrics.monoFont, /Maple Mono/u);
              assert.notEqual(metrics.background, "rgba(0, 0, 0, 0)");
              assert.equal(metrics.overflow, false);
              const file = `${state}-${width === 390 ? "mobile" : "desktop"}.png`;
              const bytes = await page.screenshot({
                path: join(shots, file),
                fullPage: true,
                animations: "disabled",
              });
              receipt.push({
                state,
                width,
                file,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                javascript: state !== "signing-in",
                ...metrics,
              });
            } finally {
              await session.close();
            }
          });
        }

      for (const scheme of ["dark", "light"])
        await t.test(
          `Shell privilege stays explicit without JS in ${scheme}`,
          async () => {
            const session = await visit(
              "shell-permissions",
              "/api/installations/desktop/grants",
              {
                width: 390,
                javascript: false,
                scheme,
              },
            );
            try {
              const { page } = session;
              assert.ok(
                await page
                  .getByText("Full access to your Team and every App", {
                    exact: true,
                  })
                  .isVisible(),
              );
              assert.ok(
                await page
                  .getByText("Only pick a shell you trust.", { exact: true })
                  .isVisible(),
              );
              assert.ok(
                await page
                  .getByText("Shell · Needs review", { exact: true })
                  .isVisible(),
              );
              assert.ok(
                await page
                  .getByRole("link", { name: "Back to Apps", exact: true })
                  .isVisible(),
              );
              await page.screenshot({
                path: join(shots, `shell-permissions-no-js-${scheme}.png`),
                fullPage: true,
              });
            } finally {
              await session.close();
            }
          },
        );

      for (const mode of ["normal", "no-js", "css", "art"])
        await t.test(
          `permissions keep a keyboard exit and no grant mutation with ${mode}`,
          async () => {
            const path = "/api/installations/context-probe/grants";
            const session = await visit("permissions", path, {
              width: 390,
              javascript: mode !== "no-js",
              fail: mode,
            });
            try {
              const { page, app } = session;
              const before = await (
                await app.request(path, {
                  headers: { Accept: "application/json" },
                })
              ).json();
              const leave = page.getByRole("link", {
                name: "Back to Apps",
                exact: true,
              });
              await leave.waitFor();
              let focused = false;
              for (let tabs = 0; tabs < 80; tabs++) {
                await page.keyboard.press("Tab");
                focused = await leave.evaluate(
                  (element) => element === document.activeElement,
                );
                if (focused) break;
              }
              assert.ok(focused, "the exit is reachable by keyboard");
              await page.screenshot({
                path: join(shots, `permissions-${mode}.png`),
                fullPage: true,
              });
              await page.keyboard.press("Enter");
              await page.waitForURL(base + "/");
              const after = await (
                await app.request(path, {
                  headers: { Accept: "application/json" },
                })
              ).json();
              assert.deepEqual(
                after.permissions.authority,
                before.permissions.authority,
              );
            } finally {
              await session.close();
            }
          },
        );

      for (const mode of ["no-js", "css", "art"])
        await t.test(`login remains operable with ${mode}`, async () => {
          const session = await visit("login", "/login", {
            width: 390,
            javascript: mode !== "no-js",
            fail: mode,
          });
          try {
            const { page } = session;
            await page
              .getByLabel("Owner key", { exact: true })
              .fill("wrong-key");
            await page
              .getByRole("button", { name: "Sign in", exact: true })
              .click();
            await page.getByRole("alert").waitFor();
            assert.equal(
              await page.getByLabel("Owner key", { exact: true }).inputValue(),
              "",
            );
            await page.screenshot({
              path: join(shots, `login-invalid-${mode}.png`),
              fullPage: true,
            });
          } finally {
            await session.close();
          }
        });

      for (const state of ["key-help", "desktop-missing", "not-found"])
        for (const scheme of ["dark", "light"])
          await t.test(
            `${state} keeps its ${scheme} plate without JS`,
            async () => {
              const entry = cases.find((item) => item[0] === state);
              const session = await visit(state, entry[1], {
                width: 390,
                javascript: false,
                scheme,
              });
              try {
                assert.equal(
                  await session.page.locator("h1").innerText(),
                  entry[2],
                );
                const image = session.page.locator(".ink-fallback");
                assert.ok(
                  await image.evaluate(
                    (img) => img.complete && img.naturalWidth > 0,
                  ),
                );
                assert.match(
                  await image.evaluate((img) => img.currentSrc),
                  new RegExp(`-${scheme}\\.avif$`, "u"),
                );
                await session.page.screenshot({
                  path: join(shots, `${state}-no-js-${scheme}.png`),
                  fullPage: true,
                });
              } finally {
                await session.close();
              }
            },
          );

      await t.test(
        "failed trace loading retains the static plate through a theme change",
        async () => {
          const session = await visit("key-help", "/login/key-help", {
            width: 390,
            fail: "trace",
          });
          try {
            assert.ok(await session.page.locator(".ink-fallback").isVisible());
            await session.page.evaluate(() => {
              document.documentElement.dataset.theme = "latte";
            });
            await session.page.waitForFunction(() =>
              document
                .querySelector(".ink-fallback")
                .currentSrc.endsWith("-light.avif"),
            );
            await session.page.screenshot({
              path: join(shots, "key-help-trace-failed-light.png"),
              fullPage: true,
            });
          } finally {
            await session.close();
          }
        },
      );

      for (const javascript of [true, false])
        await t.test(
          `the one-time helper signs in over HTTP with JS ${javascript ? "on" : "off"}`,
          async () => {
            const app = createOyster(authHost);
            const server = createServer(async (request, response) => {
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              const headers = new Headers();
              for (const [name, value] of Object.entries(request.headers))
                if (value !== undefined)
                  headers.set(
                    name,
                    Array.isArray(value) ? value.join(", ") : value,
                  );
              const body = chunks.length ? Buffer.concat(chunks) : null;
              const result = await app.fetch(
                new Request(`http://${request.headers.host}${request.url}`, {
                  method: request.method,
                  headers,
                  body,
                }),
              );
              response.writeHead(
                result.status,
                Object.fromEntries(result.headers),
              );
              response.end(Buffer.from(await result.arrayBuffer()));
            });
            await new Promise((done) => server.listen(0, "127.0.0.1", done));
            const { port } = z
              .object({ port: z.number() })
              .parse(server.address());
            const origin = `http://127.0.0.1:${port}`;
            const helper = await startSignInLink({ oysterUrl: origin, key });
            const realBrowser = await launchIsolatedChromium(
              chromium,
              [port, Number(new URL(helper.url).port)],
              { headless: true },
            );
            try {
              const context = await realBrowser.newContext({
                javaScriptEnabled: javascript,
              });
              const page = await context.newPage();
              await page.goto(helper.url);
              if (!javascript)
                await page
                  .getByRole("button", { name: "Continue to Oyster" })
                  .click();
              await page
                .getByRole("heading", { name: "Your Apps, all together." })
                .waitFor();
              assert.equal(new URL(page.url()).pathname, "/");
              const cookie = (await context.cookies()).find(
                (item) => item.name === "oyster_session",
              );
              assert.ok(cookie?.httpOnly);
              assert.equal(cookie.value.includes(key), false);
            } finally {
              await helper.close();
              await realBrowser.close();
              server.closeAllConnections();
              await new Promise((done) => server.close(done));
            }
          },
        );
      await writeFile(
        join(shots, "checks.json"),
        `${JSON.stringify({ browser: browser.version(), captures: receipt }, null, 2)}\n`,
      );
    } finally {
      await browser.close();
    }
  },
);
