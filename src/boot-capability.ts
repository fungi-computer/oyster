import { defineIdFamily } from "@fungi.computer/cairn/id";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
} from "@fungi.computer/puffball";
import {
  BOOT_DEADLINE_MS,
  BOOT_TRANSPORT_GRACE_MS,
  BootGateError,
  bootMountDiagnosticsSchema,
  type BootUi,
  type UiBootCheckOutcome,
} from "./boot-gate.js";
import type { BootPageResult, BootPageTarget } from "./browser/boot.js";
import { defaultAssetPolicy } from "./release.js";

export const BOOT_CAPABILITY_HEADER = "x-oyster-boot-token";

const bootCapabilityAssetSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  contentType: z.string().min(1).max(256),
  artifactRef: z.string().min(1).max(512).transform(parseArtifactRef),
  digest: z.string().min(1).max(80).transform(parseSha256Digest),
  byteLength: z
    .number()
    .int()
    .nonnegative()
    .max(defaultAssetPolicy.maxObjectBytes),
});

export const bootCapabilityLeaseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  identity: z.strictObject({
    appId: z.string().min(1).max(256),
    releaseId: z.string().transform(parseReleaseId),
    surfaceId: z.literal("host-boot"),
  }),
  base: z.string().min(1).max(2048),
  expiresAt: z.number().int().positive(),
  assets: z.array(bootCapabilityAssetSchema).max(defaultAssetPolicy.maxObjects),
});

export const bootCapabilityGrantSchema = z.strictObject({
  lease: bootCapabilityLeaseSchema,
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type BootCapabilityAsset = z.output<typeof bootCapabilityAssetSchema>;
export type BootCapabilityLease = z.output<typeof bootCapabilityLeaseSchema>;
export type BootCapabilityGrant = z.output<typeof bootCapabilityGrantSchema>;

/** Host-owned bounded Durable Object port. No raw token crosses this seam. */
export type BootCapabilityStore = Readonly<{
  issue(grant: BootCapabilityGrant): Promise<void>;
  resolve(
    tokenDigest: string,
    now: number,
  ): Promise<BootCapabilityLease | null>;
  revoke(id: string): Promise<void>;
}>;

/** Build metadata retained by the lease must exactly match the verified boot UI. */
export function capabilityAssets(
  assets: BootUi["assets"],
  byteLengths: readonly number[],
): BootCapabilityAsset[] {
  if (assets.length !== byteLengths.length)
    throw new Error("Boot capability asset metadata is incomplete");
  return assets.map((asset, index) => {
    const byteLength = byteLengths[index];
    if (byteLength === undefined)
      throw new Error("Boot capability asset metadata is incomplete");
    return { ...asset, byteLength };
  });
}

export function validateCapabilityAssetSet(lease: BootCapabilityLease): void {
  const total = lease.assets.reduce((sum, asset) => sum + asset.byteLength, 0);
  if (
    total > defaultAssetPolicy.maxTotalBytes ||
    new Set(lease.assets.map((asset) => asset.path)).size !==
      lease.assets.length
  )
    throw new Error("Boot capability asset set is invalid");
}

const bootCapabilityIds = defineIdFamily({
  family: "oyster-boot-capability",
  version: 1,
  kinds: { lease: { prefix: "bcap" } },
});

/** The artifact bucket's metadata read; asset bytes are never read here. */
export type BootCapabilityBucket = Readonly<{
  head(key: string): Promise<Readonly<{ size: number }> | null>;
}>;

/**
 * Mint one boot capability for every host: a fresh 256-bit token for the
 * caller's request header, only its SHA-256 digest in the store, and a lease
 * whose asset sizes come from the bucket's own metadata. An asset the bucket
 * does not hold, or one beyond the asset policy, refuses before anything is
 * stored.
 */
export async function issueBootCapability(
  input: Readonly<{
    ui: BootUi;
    bucket: BootCapabilityBucket;
    capabilities: BootCapabilityStore;
    now: () => number;
  }>,
): Promise<Readonly<{ token: string; leaseId: string; deadlineAt: number }>> {
  const byteLengths: number[] = [];
  let totalBytes = 0;
  for (const asset of input.ui.assets) {
    const head = await input.bucket.head(asset.artifactRef);
    if (head === null || head.size > defaultAssetPolicy.maxObjectBytes)
      throw new BootGateError("ui_mount_failed");
    totalBytes += head.size;
    if (totalBytes > defaultAssetPolicy.maxTotalBytes)
      throw new BootGateError("ui_mount_failed");
    byteLengths.push(head.size);
  }
  // Metadata may take longer than the page budget; start the lease only once
  // every asset has been verified, immediately before issuing it.
  const deadlineAt = input.now() + BOOT_DEADLINE_MS;
  const lease: BootCapabilityLease = {
    id: bootCapabilityIds.lease.generate(),
    identity: input.ui.identity,
    base: input.ui.base,
    expiresAt: deadlineAt + BOOT_TRANSPORT_GRACE_MS,
    assets: capabilityAssets(input.ui.assets, byteLengths),
  };
  validateCapabilityAssetSet(lease);
  const token = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const tokenDigest = createHash("sha256").update(token, "utf8").digest("hex");
  await input.capabilities.issue({ lease, tokenDigest });
  return { token, leaseId: lease.id, deadlineAt };
}

/** What one boot page report needs from its host. */
export type BootPageReportInput = Readonly<{
  /** The host's configured origin for its `/_boot/` route, or null when unset. */
  origin: string | null;
  /** `checkBootPage` over the host's browser, or null without one. */
  check: ((target: BootPageTarget) => Promise<BootPageResult>) | null;
  /** The Release's UI as artifact references, or null when it has no UI. */
  readUi: () => Promise<BootUi | null>;
  bucket: BootCapabilityBucket;
  capabilities: BootCapabilityStore;
  now: () => number;
}>;

/**
 * One UI page check for a Release, for every host, reading no UI bytes:
 * issue a capability, open the pinned boot page, revoke the capability, and
 * report in the boot gate's vocabulary. A page that did not mount fails,
 * with diagnostics sanitized by the gate's schema; a timeout, unconfirmed
 * cleanup, an unavailable runner, or no browser or origin is not checked.
 */
export async function reportBootPage(
  input: BootPageReportInput,
): Promise<UiBootCheckOutcome> {
  const ui = await input.readUi();
  if (ui === null) return { kind: "passed" };
  if (input.check === null || input.origin === null)
    return { kind: "not_checked", code: "boot_browser_binding_missing" };
  let issued: Readonly<{
    token: string;
    leaseId: string;
    deadlineAt: number;
  }>;
  try {
    issued = await issueBootCapability({
      ui,
      bucket: input.bucket,
      capabilities: input.capabilities,
      now: input.now,
    });
  } catch (cause) {
    if (cause instanceof BootGateError && cause.code === "ui_mount_failed")
      return { kind: "failed", code: "ui_mount_failed" };
    throw cause;
  }
  let result: BootPageResult;
  try {
    result = await input.check({
      origin: input.origin,
      releaseId: ui.identity.releaseId,
      capability: { header: BOOT_CAPABILITY_HEADER, token: issued.token },
      deadlineAt: issued.deadlineAt,
    });
  } finally {
    await input.capabilities.revoke(issued.leaseId);
  }
  if (result.kind === "mounted") return { kind: "passed" };
  if (result.code === "ui_mount_failed")
    return {
      kind: "failed",
      code: "ui_mount_failed",
      diagnostics: bootMountDiagnosticsSchema.parse(result.diagnostics),
    };
  return { kind: "not_checked", code: result.code };
}
