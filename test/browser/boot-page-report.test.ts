import { describe, expect, it, vi } from "vitest";
import {
  reportBootPage,
  type BootCapabilityGrant,
  type BootCapabilityStore,
  type BootPageReportInput,
} from "../../src/boot-capability.js";
import { bootUiSchema } from "../../src/boot-gate.js";
import type { BootPageResult, BootPageTarget } from "../../src/browser/boot.js";

/**
 * One UI page check for a Release, for every host: issue a short-lived
 * capability, open the pinned boot page, revoke, and report the outcome in
 * the boot gate's vocabulary. Inconclusive runs are not_checked with their
 * code; a mount failure carries diagnostics sanitized by the gate's schema.
 */

const ui = bootUiSchema.parse({
  identity: {
    appId: "app_report",
    releaseId: "rel_report01",
    surfaceId: "host-boot",
  },
  base: "./",
  assets: [
    {
      path: "/index.html",
      contentType: "text/html; charset=utf-8",
      artifactRef: "artifact:report.ui-1",
      digest: `sha256:${"d".repeat(64)}`,
    },
  ],
});

function input(overrides: Partial<BootPageReportInput> = {}) {
  const grants: BootCapabilityGrant[] = [];
  const revoked: string[] = [];
  const capabilities: BootCapabilityStore = {
    issue: (grant) => {
      grants.push(grant);
      return Promise.resolve();
    },
    resolve: () => Promise.resolve(null),
    revoke: (id) => {
      revoked.push(id);
      return Promise.resolve();
    },
  };
  const check = vi.fn<(target: BootPageTarget) => Promise<BootPageResult>>(() =>
    Promise.resolve({ kind: "mounted" }),
  );
  const all: BootPageReportInput = {
    origin: "https://apps.example.test",
    readUi: () => Promise.resolve(ui),
    bucket: { head: () => Promise.resolve({ size: 12 }) },
    capabilities,
    check,
    now: () => 1_000,
    ...overrides,
  };
  return { all, grants, revoked, check };
}

describe("reportBootPage", () => {
  it("is not checked without a browser or an origin, and issues nothing", async () => {
    for (const missing of [{ check: null }, { origin: null }]) {
      const { all, grants } = input(missing);
      await expect(reportBootPage(all)).resolves.toEqual({
        kind: "not_checked",
        code: "boot_browser_binding_missing",
      });
      expect(grants).toEqual([]);
    }
  });

  it("passes a Release without a UI without opening a page", async () => {
    const { all, check, grants } = input({
      readUi: () => Promise.resolve(null),
    });
    await expect(reportBootPage(all)).resolves.toEqual({ kind: "passed" });
    expect(check).not.toHaveBeenCalled();
    expect(grants).toEqual([]);
  });

  it("passes a Release without a UI on a host without a browser", async () => {
    const { all } = input({ readUi: () => Promise.resolve(null), check: null });
    await expect(reportBootPage(all)).resolves.toEqual({ kind: "passed" });
  });

  it("opens the pinned page with the issued token, then revokes its lease", async () => {
    const { all, check, grants, revoked } = input();
    await expect(reportBootPage(all)).resolves.toEqual({ kind: "passed" });
    const [grant] = grants;
    // now() is 1_000: the deadline is 10 s on, the lease 2 s past it.
    expect(grant?.lease.expiresAt).toBe(13_000);
    const [target] = check.mock.calls[0] ?? [];
    expect(target).toMatchObject({
      origin: "https://apps.example.test",
      releaseId: "rel_report01",
      capability: { header: "x-oyster-boot-capability" },
      deadlineAt: 11_000,
    });
    expect(target?.capability.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(revoked).toEqual([grant?.lease.id]);
  });

  it("fails a page that did not mount, with sanitized diagnostics", async () => {
    const { all, revoked } = input({
      check: () =>
        Promise.resolve<BootPageResult>({
          kind: "refused",
          code: "ui_mount_failed",
          diagnostics: {
            failedPredicate: "page_error",
            finalUrlPath: "/_boot/rel_report01/index.html",
            consoleErrors: ["\u001b[31mCandidate token=secret-value\u001b[0m"],
            pageErrors: [],
            failedRequests: [],
            droppedCount: 0,
          },
        }),
    });
    const outcome = await reportBootPage(all);
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "ui_mount_failed",
      diagnostics: { failedPredicate: "page_error" },
    });
    expect(JSON.stringify(outcome)).not.toContain("secret-value");
    expect(JSON.stringify(outcome)).not.toContain("\u001b");
    expect(revoked).toHaveLength(1);
  });

  it.each([
    "boot_timeout",
    "boot_cleanup_failed",
    "boot_runner_unavailable",
  ] as const)(
    "reports an inconclusive %s run as not checked, and still revokes",
    async (code) => {
      const { all, revoked } = input({
        check: () => Promise.resolve<BootPageResult>({ kind: "refused", code }),
      });
      await expect(reportBootPage(all)).resolves.toEqual({
        kind: "not_checked",
        code,
      });
      expect(revoked).toHaveLength(1);
    },
  );

  it("fails a UI whose assets the bucket cannot vouch for, without a page", async () => {
    const { all, check } = input({
      bucket: { head: () => Promise.resolve(null) },
    });
    await expect(reportBootPage(all)).resolves.toEqual({
      kind: "failed",
      code: "ui_mount_failed",
    });
    expect(check).not.toHaveBeenCalled();
  });
});
