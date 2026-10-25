import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BOOT_CAPABILITY_HEADER,
  issueBootCapability,
  type BootCapabilityGrant,
  type BootCapabilityStore,
} from "../../src/boot-capability.js";
import { BootGateError, bootUiSchema } from "../../src/boot-gate.js";

/**
 * The one place a boot capability lease is minted, for every host: a fresh
 * random token for the caller, only its digest in the store, and a lease
 * whose asset sizes come from the artifact bucket's own metadata.
 */

const ui = bootUiSchema.parse({
  identity: {
    appId: "app_issue",
    releaseId: "rel_issue01",
    surfaceId: "host-boot",
  },
  base: "./",
  assets: [
    {
      path: "/index.html",
      contentType: "text/html; charset=utf-8",
      artifactRef: "artifact:issue.ui-1",
      digest: `sha256:${"c".repeat(64)}`,
    },
  ],
});

function recordingStore() {
  const grants: BootCapabilityGrant[] = [];
  const capabilities: BootCapabilityStore = {
    issue: (grant) => {
      grants.push(grant);
      return Promise.resolve();
    },
    resolve: () => Promise.resolve(null),
    revoke: () => Promise.resolve(),
  };
  return { capabilities, grants };
}

const bucket = (size: number | null) => ({
  head: () => Promise.resolve(size === null ? null : { size }),
});

it("uses the boot header name redacted by the Worker tail runtime", () => {
  expect(BOOT_CAPABILITY_HEADER).toBe("x-oyster-boot-token");
});

describe("issueBootCapability", () => {
  it("returns a fresh token and stores only its digest with a lease sized from the bucket", async () => {
    const { capabilities, grants } = recordingStore();
    const issued = await issueBootCapability({
      ui,
      bucket: bucket(42),
      capabilities,
      expiresAt: 9_000,
    });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(grants).toHaveLength(1);
    const [grant] = grants;
    expect(grant?.tokenDigest).toBe(
      createHash("sha256").update(issued.token, "utf8").digest("hex"),
    );
    expect(JSON.stringify(grant)).not.toContain(issued.token);
    expect(grant?.lease).toMatchObject({
      id: issued.leaseId,
      identity: ui.identity,
      base: "./",
      expiresAt: 9_000,
      assets: [{ path: "/index.html", byteLength: 42 }],
    });
  });

  it("mints a different token every time", async () => {
    const { capabilities } = recordingStore();
    const input = { ui, bucket: bucket(1), capabilities, expiresAt: 9_000 };
    const first = await issueBootCapability(input);
    const second = await issueBootCapability(input);
    expect(first.token).not.toBe(second.token);
    expect(first.leaseId).not.toBe(second.leaseId);
  });

  it("refuses an asset the bucket does not hold, before anything is stored", async () => {
    const { capabilities, grants } = recordingStore();
    await expect(
      issueBootCapability({
        ui,
        bucket: bucket(null),
        capabilities,
        expiresAt: 9_000,
      }),
    ).rejects.toMatchObject({ code: "ui_mount_failed" });
    expect(grants).toEqual([]);
  });

  it("refuses an asset larger than the asset policy allows", async () => {
    const { capabilities, grants } = recordingStore();
    await expect(
      issueBootCapability({
        ui,
        bucket: bucket(Number.MAX_SAFE_INTEGER),
        capabilities,
        expiresAt: 9_000,
      }),
    ).rejects.toBeInstanceOf(BootGateError);
    expect(grants).toEqual([]);
  });
});
