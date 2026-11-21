import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as console from "node:console";
import process from "node:process";
import { parseArgs } from "node:util";
import { URL } from "node:url";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { build } from "esbuild";
import { z } from "zod";
import { chromium } from "playwright";
import { serveHost } from "../../src/authorization.ts";
import { ownerKeyAuth } from "../../src/auth.ts";
import { memoryOwnerSessions } from "../memory-owner-sessions.mjs";
import {
  candidatePreviewFixture,
  previewSecret,
} from "./candidate-preview.fixture.ts";
import { launchIsolatedChromium } from "../../../../tooling/proof-runner/isolated-chromium.mjs";
import { scaledBudgetMs } from "../../../../tooling/repository/scripts/proof-budget.mjs";

const { Request, Response } = globalThis;

const work = new URL("../../.botanical/candidate-preview/", import.meta.url);
await mkdir(work, { recursive: true });

const { values: proofOptions } = parseArgs({
  options: { access: { type: "boolean" }, shots: { type: "string" } },
});

if (proofOptions.access) {
  // An unset operator fixture is an explicit skip, never Access qualification.
  const entry = process.env.OYSTER_CANDIDATE_PREVIEW_ACCESS_ENTRY;
  const storageState =
    process.env.OYSTER_CANDIDATE_PREVIEW_ACCESS_STORAGE_STATE;
  const skipReason =
    !entry || !storageState
      ? "OYSTER_CANDIDATE_PREVIEW_ACCESS_NOT_CONFIGURED: ingress and private browser auth state are required; only self-host without Access is qualified"
      : false;
  await rm(new URL("access-report.json", work), { force: true });
  if (skipReason)
    await writeFile(
      new URL("access-report.json", work),
      JSON.stringify({
        kind: "access-fronted",
        status: "skipped",
        reason: skipReason,
      }),
    );
  await test(
    "Access-fronted candidate UI browser isolation",
    { skip: skipReason },
    async () => {
      let target;
      try {
        target = new URL(entry);
      } catch {
        throw new Error("Access proof needs a valid owner-entry URL");
      }
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.search ||
        !/^\/builds\/[^/]+\/preview$/u.test(target.pathname)
      )
        throw new Error(
          "Access proof needs an HTTPS owner entry without credentials or query parameters",
        );
      const browser = await chromium.launch();
      try {
        const anonymous = await browser.newContext();
        const visitor = await anonymous.newPage();
        await visitor.goto(entry);
        assert.match(
          new URL(visitor.url()).hostname,
          /\.cloudflareaccess\.com$/u,
          "Unauthenticated ingress must actually reach Cloudflare Access",
        );
        await anonymous.close();
        const context = await browser.newContext({ storageState });
        const candidateDocuments = [];
        context.on("response", (response) => {
          if (
            response.request().resourceType() === "document" &&
            response.url().includes("/candidate/index.html")
          )
            candidateDocuments.push(response);
        });
        const launcher = await context.newPage();
        await launcher.setContent(
          '<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>',
        );
        await launcher
          .frameLocator("iframe")
          .locator("body")
          .evaluate((body, href) => {
            const link = globalThis.document.createElement("a");
            link.href = href;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = "Preview";
            body.append(link);
          }, entry);
        const opened = context.waitForEvent("page");
        await launcher
          .frameLocator("iframe")
          .getByRole("link", { name: "Preview" })
          .click();
        const page = await opened;
        page.setDefaultTimeout(scaledBudgetMs(20_000));
        await page.waitForLoadState();
        await page
          .getByRole("button", { name: "Open preview", exact: true })
          .click();
        await page.locator("#candidate").waitFor();
        const jobId = decodeURIComponent(target.pathname.split("/")[2]);
        const status = await context.request.get(
          new URL(`/api/builds/${encodeURIComponent(jobId)}`, target.origin)
            .href,
        );
        assert.equal(status.status(), 200);
        const { releaseId } = z
          .object({ releaseId: z.string().min(1) })
          .parse(await status.json());
        await assertIsolatedCandidate(page, releaseId);
        assert.ok(candidateDocuments[0]);
        assert.match(
          await candidateDocuments[0].headerValue("content-security-policy"),
          /(?:^|; )sandbox allow-scripts;/u,
        );
        assert.equal(
          new URL(candidateDocuments[0].url()).origin,
          target.origin,
        );
        await assertDirectCandidate(context, candidateDocuments[0]);
        await context.close();
        await writeFile(
          new URL("access-report.json", work),
          JSON.stringify({
            kind: "access-fronted",
            status: "passed",
            origin: target.origin,
          }),
        );
        console.log(
          "PASS: real Access-fronted arrival and candidate isolation",
        );
      } catch {
        // A real candidate URL contains a bearer. Do not print Playwright's URL-bearing errors.
        throw new Error(
          "Real Access-fronted candidate proof failed; no qualification recorded",
        );
      } finally {
        await browser.close();
      }
    },
  );
} else {
  await selfHostedProof();
}

async function assertIsolatedCandidate(page, releaseId = "rel_preview") {
  assert.equal(
    await page.locator("#candidate").getAttribute("sandbox"),
    "allow-scripts",
  );
  const frame = await page
    .locator("#candidate")
    .elementHandle()
    .then((element) => element.contentFrame());
  assert.ok(frame);
  await frame.locator("#status").filter({ hasText: "connected" }).waitFor();
  const result = await frame.evaluate(() => globalThis.__candidatePreviewProof);
  assert.deepEqual(result.grants, [false, false, false, false, false]);
  assert.equal(result.computerId, null);
  assert.equal(result.surfaceId, `preview:${releaseId}`);
  assert.equal(result.parentReadable, false);
  assert.equal(result.popupOpened, false);
  assert.equal(result.storageReadable, false);
  assert.equal(result.ownerFetch, false);
  assert.equal(result.payload, "scoped JSON");
  assert.equal(
    await frame
      .locator("#status")
      .evaluate((element) => globalThis.getComputedStyle(element).color),
    "rgb(13, 42, 81)",
  );
  return frame;
}

async function selfHostedProof() {
  const key = new URL("local.key", work);
  const cert = new URL("local.crt", work);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=oyster.test",
      "-keyout",
      key.pathname,
      "-out",
      cert.pathname,
    ],
    { stdio: "ignore" },
  );
  const bundle = await build({
    stdin: {
      contents: `
import { connectApp } from "@fungi.computer/agar";
import { computerReadFile, computerTerminal } from "@fungi.computer/agar/computer";
import { appBackend, appRegion } from "@fungi.computer/agar/backend";
import { appStorage } from "@fungi.computer/agar/storage";
const root = await connectApp({ host: "parent" });
let parentReadable = false, storageReadable = false;
try { parentReadable = Boolean(parent.document.body); } catch {}
try { storageReadable = Boolean(globalThis.localStorage.length >= 0); } catch {}
const form = document.createElement("form");
form.action = "/owner-probe"; form.method = "POST"; form.target = "_blank";
document.body.append(form); form.requestSubmit();
const popupOpened = window.open("/owner-probe", "_blank") !== null;
let ownerFetch = false;
try { ownerFetch = (await fetch("/owner-probe")).ok; } catch {}
const payload = await (await fetch(new URL("./payload.json", import.meta.url))).json();
globalThis.__candidatePreviewProof = {
  grants: [computerReadFile, computerTerminal, appBackend, appRegion, appStorage].map((contract) => root.capabilities.has(contract)),
  computerId: root.context.get().computerId, surfaceId: root.identity.surfaceId,
  parentReadable, storageReadable, popupOpened, ownerFetch, payload: payload.message,
};
document.getElementById("status").textContent = "connected";
`,
      resolveDir: new URL("../../", import.meta.url).pathname,
      sourcefile: "candidate-preview-proof.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
  });
  const entryModule = bundle.outputFiles[0].text;
  const events = [];
  let handler;
  let ownerProbe = 0;
  let origin;
  let launcherOrigin;
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url, `https://${incoming.headers.host}`);
        const init = { method: incoming.method, headers: incoming.headers };
        if (incoming.method !== "GET" && incoming.method !== "HEAD") {
          init.body = Readable.toWeb(incoming);
          init.duplex = "half";
        }
        const request = new Request(url, init);
        let response;
        if (url.origin === launcherOrigin) {
          response = new Response(
            `<!doctype html><iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc='<a href="${origin}/builds/job-fixture/preview" target="_blank" rel="noreferrer">Preview</a>'></iframe>`,
            { headers: { "content-type": "text/html" } },
          );
        } else if (url.pathname === "/login" && request.method === "GET") {
          response = new Response(
            '<!doctype html><form method="post"><input name="key"><button>Sign in</button></form>',
            { headers: { "content-type": "text/html" } },
          );
        } else if (url.pathname === "/login") {
          response = await auth.login(request);
        } else if (url.pathname === "/") {
          response = new Response("Owner home");
        } else if (url.pathname === "/owner-probe") {
          ownerProbe++;
          response = new Response("Owner resource");
        } else {
          if (url.pathname === "/builds/job-fixture/preview")
            events.push({
              method: request.method,
              authenticated:
                (await auth.authenticate(request)).kind === "admitted",
              originSame: request.headers.get("origin") === origin,
              site: request.headers.get("sec-fetch-site"),
            });
          response = await handler.fetch(request);
        }
        if (url.pathname === "/builds/job-fixture/preview")
          events.push({ method: request.method, status: response.status });
        const outgoingHeaders = Object.fromEntries(
          [...response.headers].filter(([name]) => name !== "set-cookie"),
        );
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) outgoingHeaders["set-cookie"] = cookies;
        outgoing.writeHead(response.status, outgoingHeaders);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (cause) {
        console.error("Candidate preview fixture failed", cause?.name);
        return outgoing.writeHead(500).end("Fixture failed");
      }
    },
  );
  const auth = ownerKeyAuth(previewSecret, "owner", memoryOwnerSessions());
  let browser;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());
    origin = `https://oyster.test:${address.port}`;
    launcherOrigin = `https://launcher.example:${address.port}`;
    const fixture = await candidatePreviewFixture({
      files: [
        {
          path: "/index.html",
          contentType: "text/html",
          text: '<!doctype html><link rel="stylesheet" href="./style.css"><p id="status">loading</p><script type="module" src="./main.js"></script>',
        },
        { path: "/main.js", contentType: "text/javascript", text: entryModule },
        {
          path: "/style.css",
          contentType: "text/css",
          text: "#status { color: rgb(13,42,81) }",
        },
        {
          path: "/payload.json",
          contentType: "application/json",
          text: '{"message":"scoped JSON"}',
        },
      ],
      origin,
      appName: "Garden Planner — shared planting calendar",
    });
    handler = serveHost(fixture.preview.routes, auth.authenticate, {
      liveKey: () => Promise.resolve(null),
      appToolPolicy: () => null,
    });
    browser = await launchIsolatedChromium(chromium, [address.port], {
      trustCertificates: [cert.pathname],
      args: [
        `--host-resolver-rules=MAP oyster.test 127.0.0.1,MAP launcher.example 127.0.0.1`,
        "--no-proxy-server",
      ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    context.setDefaultTimeout(scaledBudgetMs(20_000));
    const login = await context.newPage();
    await login.goto(`${origin}/login`);
    await login.locator("input").fill(previewSecret);
    await Promise.all([
      login.waitForURL(`${origin}/`),
      login.locator("button").click(),
    ]);
    const candidateResponses = [];
    context.on("response", (response) => {
      if (
        response.request().resourceType() === "document" &&
        response.url().includes("/candidate/index.html")
      )
        candidateResponses.push(response);
    });
    const launcher = await context.newPage();
    await launcher.goto(launcherOrigin);
    const opened = context.waitForEvent("page");
    await launcher
      .frameLocator("iframe")
      .getByRole("link", { name: "Preview" })
      .click();
    const page = await opened;
    await page.waitForLoadState();
    await page
      .getByRole("button", { name: "Open preview", exact: true })
      .click();
    try {
      await assertIsolatedCandidate(page);
    } catch (cause) {
      console.error("Candidate preview arrival failed", JSON.stringify(events));
      throw cause;
    }
    assert.ok(
      events.some((event) => event.method === "GET" && !event.authenticated),
      "Opaque-frame arrival must not rely on the Strict owner cookie",
    );
    assert.ok(
      events.some(
        (event) =>
          event.method === "POST" &&
          event.authenticated &&
          event.site === "same-origin",
      ),
    );
    const document = candidateResponses[0];
    assert.ok(document);
    const csp = await document.headerValue("content-security-policy");
    assert.equal(
      /(?:^|; )sandbox allow-scripts;/u.test(csp ?? ""),
      true,
      "Candidate response must use the scripts-only sandbox",
    );
    assert.equal(
      /allow-popups|allow-forms|allow-same-origin/u.test(csp ?? ""),
      false,
      "Candidate response must not permit sandbox escapes",
    );
    assert.equal(
      await document.headerValue("cache-control"),
      "private, no-store",
    );
    await assertDirectCandidate(context, document);
    assert.equal(ownerProbe, 0);
    assert.equal(fixture.build().installation, null);
    const layouts = await assertPreviewLayout(
      context,
      origin,
      proofOptions.shots,
    );
    await context.close();
    await writeFile(
      new URL("self-host-report.json", work),
      JSON.stringify({
        kind: "self-host-without-access",
        passed: true,
        scriptsOnlyIframe: true,
        scriptsOnlyResponse: true,
        moduleCssJson: true,
        zeroGrants: true,
        opaqueArrival: true,
        directNavigationOpaque: true,
        noActivation: true,
        layouts,
      }),
    );
    console.log(
      "PASS: self-host without Access; opaque owner arrival, HTML/module/CSS/JSON, iframe + response sandbox, zero grants, direct navigation, no activation",
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function assertDirectCandidate(context, response) {
  const direct = await context.newPage();
  await direct.goto(response.url());
  assert.deepEqual(
    await direct.evaluate(() => {
      let storage;
      try {
        storage = Boolean(globalThis.localStorage.length >= 0);
      } catch (cause) {
        if (
          !(cause instanceof globalThis.DOMException) ||
          cause.name !== "SecurityError"
        )
          throw cause;
        storage = false;
      }
      return {
        storage,
        popup: globalThis.open("/owner-probe", "_blank") !== null,
      };
    }),
    { storage: false, popup: false },
  );

  await direct.close();
}

async function assertPreviewLayout(context, origin, shots) {
  const layouts = [];
  if (shots) await mkdir(shots, { recursive: true });
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.goto(`${origin}/builds/job-fixture/preview`);
    const open = page.getByRole("button", {
      name: "Open preview",
      exact: true,
    });
    await open.waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    assert.equal(
      (await open.evaluate((el) => el.getBoundingClientRect().height)) <= 32,
      true,
    );
    assert.equal(
      await open.evaluate((el) => el.classList.contains("caps-button")),
      true,
    );
    if (shots)
      await page.screenshot({ path: `${shots}/landing-${viewport.width}.png` });
    await open.click();
    await assertIsolatedCandidate(page);
    await page.evaluate(() => globalThis.document.fonts.ready);
    const bar = page.locator("[data-preview-bar]");
    const geometry = await bar.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      width: el.clientWidth,
      scroll: el.scrollWidth,
      text: el.innerText,
    }));
    assert.ok(geometry.height <= 32);
    assert.ok(geometry.scroll <= geometry.width);
    assert.ok(geometry.text.includes("build aaaaaaa"));
    assert.ok(
      !geometry.text.includes("snapshot") &&
        !geometry.text.includes("grant") &&
        !geometry.text.includes("promoted"),
    );
    if (viewport.width === 390)
      assert.equal(
        await page
          .locator(".preview-app")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
        true,
      );
    const build = await page.locator(".preview-build").boundingBox();
    assert.ok(build && build.x >= 0 && build.x + build.width <= viewport.width);
    if (shots)
      await page.screenshot({ path: `${shots}/preview-${viewport.width}.png` });
    await page.getByText("Details", { exact: true }).click();
    await page
      .getByText("This build was not checked against the latest proposal.", {
        exact: true,
      })
      .waitFor();
    assert.ok((await bar.boundingBox()).height <= 32);
    layouts.push({
      viewport,
      barHeight: geometry.height,
      barWidth: geometry.width,
      contentWidth: geometry.scroll,
      buildBounds: build,
    });
    await page.clock.fastForward(300_001);
    await page
      .getByText("This preview expired. Reload to open it again.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("#candidate").isVisible(), false);
    await page.close();
  }
  return layouts;
}
