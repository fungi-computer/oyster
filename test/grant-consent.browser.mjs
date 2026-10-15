import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createOyster } from "../dist/host.js";
import { computerHost } from "./computer-host.fixture.mjs";

test("owner consent submits explicit Release-bound approvals through the installation gate", async () => {
  const browser = await chromium.launch({ headless: true });
  const output = new globalThis.URL(
    "../../../.botanical/grant-consent-shots/",
    import.meta.url,
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
          approvedGrants: installed.approvedGrants.filter(
            (grant) => grant.capability !== "app.events.emit",
          ),
        };
        const requests = [];
        const app = createOyster({
          ...host,
          installations: {
            list: async () => [current],
            get: async (id) => (id === current.installationId ? current : null),
            put: async (next) => {
              current = next;
            },
            compareAndPut: async (next, expected) => {
              if (expected !== current.authorityVersion)
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
        if (process.env.GRANT_CONSENT_BEFORE === "1") {
          await page.screenshot({
            path: new globalThis.URL(`before-${width}-${theme}.png`, output)
              .pathname,
            fullPage: true,
          });
          await page.close();
          continue;
        }
        await link.click();
        await page
          .getByRole("heading", { name: "Bonsai permissions" })
          .waitFor();
        const send = page.getByRole("checkbox", { name: "Send events" });
        assert.equal(await send.isChecked(), false);
        await page.screenshot({
          path: new globalThis.URL(`after-${width}-${theme}.png`, output)
            .pathname,
          fullPage: true,
        });
        await send.check();
        await page.getByRole("button", { name: "Save permissions" }).click();
        await page
          .getByRole("status")
          .filter({ hasText: "Permissions saved" })
          .waitFor();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].authorityVersion, installed.authorityVersion);
        assert.equal(
          requests[0].artifactDigest,
          installed.release.artifact.artifactDigest,
        );
        assert.equal(current.authorityVersion, installed.authorityVersion + 1);
        assert.deepEqual(current.release, installed.release);
        assert.equal(
          current.approvedGrants.find(
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
        await page.close();
      }
    assert.deepEqual(links, [1, 1, 1, 1]);
  } finally {
    await browser.close();
  }
});
