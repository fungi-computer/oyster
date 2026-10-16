// Local qualification: build every maintained App from one immutable revision,
// serve its actual output, and prove emitted styles reach the browser.
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath, URL } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";
import { parseReleaseId, parseSourceRevision } from "@fungi.computer/puffball";
import {
  createAppCandidatePreparer,
  createLocalCommitSourceCapture,
  createLocalBuildExecutor,
} from "../dist/build.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const revision = parseSourceRevision(
  `git:${execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()}`,
);
const store = execFileSync("pnpm", ["store", "path"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
// Each App declares its build policy in its own manifest; Oyster derives
// the steps from the captured package graph.
const appEntries = [
  "apps/bonsai/web/index.html",
  "packages/oyster/examples/notes-app/ui/index.html",
  "apps/prints/index.html",
  "apps/inkcap/index.html",
  "apps/tourtois/index.html",
  "apps/grove/index.html",
  "apps/shed/index.html",
  "apps/trellis/index.html",
];
const selected =
  process.argv[2] === undefined
    ? appEntries
    : [Schema.decodeUnknownSync(Schema.Literals(appEntries))(process.argv[2])];
const backends = {
  "apps/bonsai/web/index.html": ["apps/bonsai/backend/index.ts", "BonsaiApp"],
  "apps/grove/index.html": ["apps/grove/backend/index.ts", "Grove"],
  "apps/prints/index.html": ["apps/prints/backend/index.ts", "Prints"],
  "apps/inkcap/index.html": ["apps/inkcap/backend/index.ts", "Inkcap"],
  "apps/trellis/index.html": ["apps/trellis/backend/index.ts", "Trellis"],
  "packages/oyster/examples/notes-app/ui/index.html": [
    "packages/oyster/examples/notes-app/backend/index.ts",
    "Notes",
  ],
};
const assets = {
  maxManifestBytes: 1048576,
  maxObjects: 1024,
  maxObjectBytes: 16777216,
  maxTotalBytes: 67108864,
};
const browser = await chromium.launch({ headless: true });
try {
  for (const entry of selected) {
    const backend = backends[entry];
    const prepared = await Effect.runPromise(
      Effect.scoped(
        createAppCandidatePreparer({
          config: {
            appId: "app_styles",
            recipe: {
              entry,
              assets,
              assetBase: "./",
              maxOutputBytes: assets.maxTotalBytes,
              backend:
                backend === undefined
                  ? null
                  : {
                      entry: backend[0],
                      exportName: backend[1],
                      compatibilityDate: "2026-09-04",
                      runtime: { kind: "durable-facet", stateSchema: 1 },
                    },
            },
          },
          sourceCapture: createLocalCommitSourceCapture(repository, revision),
          buildExecutor: createLocalBuildExecutor({
            packageStoreDirectory: store,
          }),
        }).prepareCandidate(parseReleaseId("rel_styles")),
      ),
    );
    assert.notEqual(prepared.output.kind, "backend");
    const ui = prepared.output.ui.content;
    const files =
      ui.kind === "html"
        ? new Map([["/index.html", ui.bytes]])
        : new Map(ui.assets.map((asset) => [asset.path, asset.bytes]));
    const server = createServer((request, response) => {
      const path = new URL(request.url, "http://localhost").pathname;
      const bytes = files.get(path === "/" ? "/index.html" : path);
      response.writeHead(bytes === undefined ? 404 : 200, {
        "content-type": path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".woff2")
              ? "font/woff2"
              : "text/html",
      });
      response.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const cssResponses = [];
      page.on("response", (response) => {
        if (new URL(response.url()).pathname.endsWith(".css"))
          cssResponses.push(response);
      });
      await page.goto(origin, { waitUntil: "networkidle" });
      // Notes intentionally has semantic HTML and no authored stylesheet.
      if (entry.includes("notes-app")) {
        assert.equal(await page.locator("textarea#note").count(), 1);
        console.log(`PASS ${entry}: authored plain HTML (no stylesheet input)`);
        continue;
      }
      const sheetCount = await page
        .locator('link[rel="stylesheet"],style')
        .count();
      assert.ok(
        sheetCount > 0,
        `${entry}: built page links or inlines its stylesheet`,
      );
      for (const css of await page.locator("style").allTextContents()) {
        assert.doesNotMatch(
          css,
          /@(?:source|theme|utility|plugin|apply)\b/,
          `${entry}: inline stylesheet must be compiled`,
        );
      }
      for (const response of cssResponses) {
        assert.equal(response.status(), 200, `${entry}: stylesheet served`);
        assert.match(response.headers()["content-type"], /text\/css/);
        assert.doesNotMatch(
          await response.text(),
          /@(?:source|theme|utility|plugin|apply)\b/,
          `${entry}: stylesheet must be compiled`,
        );
      }
      assert.ok(
        ui.kind === "html" || cssResponses.length > 0,
        `${entry}: linked asset loaded`,
      );
      const display = await page.evaluate(() => {
        const probe = globalThis.document.createElement("div");
        probe.className = "flex";
        globalThis.document.body.append(probe);
        return globalThis.getComputedStyle(probe).display;
      });
      assert.equal(
        display,
        "flex",
        `${entry}: loaded stylesheet supplies layout utilities`,
      );
      console.log(
        `PASS ${entry}: compiled stylesheet linked/inlined, served, layout applies; ${prepared.provenance.buildRecipeDigest}`,
      );
    } finally {
      await context.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }
} finally {
  await browser.close();
}
