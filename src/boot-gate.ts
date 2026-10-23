import { z } from "zod";
import stripAnsi from "strip-ansi";
import {
  parseArtifactRef,
  parseReleaseId,
  parseSha256Digest,
  type Release,
} from "@fungi.computer/puffball";
import {
  defaultAssetPolicy,
  verifyRelease,
  type ArtifactStore,
} from "./release.js";

/** Only the host can produce these outcomes; they are not an App build input. */
export const bootFailureSchema = z.enum([
  "backend_load_failed",
  "backend_construction_failed",
  "ui_mount_failed",
  "boot_runner_unavailable",
  "boot_browser_binding_missing",
  "boot_clone_unavailable",
  "boot_timeout",
  "boot_cleanup_failed",
]);
export type BootFailure = z.output<typeof bootFailureSchema>;

export const BOOT_MOUNT_DIAGNOSTIC_LIMITS = Object.freeze({
  maxEntriesPerKind: 20,
  maxEntriesTotal: 48,
  maxTextChars: 300,
  maxPathChars: 2048,
  maxDroppedCount: 1024,
});

const bootMountDiagnosticTextSchema = z
  .string()
  .transform((value) => {
    const withoutTerminalControls = stripAnsi(value.slice(0, 4096)).replace(
      /[\p{Cc}\p{Cf}]/gu,
      "",
    );
    return withoutTerminalControls
      .replace(/\b(?:authorization|cookie)\s*:\s*[^\r\n]*/giu, "[redacted]")
      .replace(
        /\b(?:access[_-]?token|token|password|secret)\b\s*[:=]\s*["']?[^,\s;"']+/giu,
        "[redacted]",
      )
      .replace(/\bBearer\s+\S+/giu, "[redacted]")
      .replace(/\S*(?:[a-z][a-z\d+.-]*:\/\/|\?)[^\s]*/giu, "[redacted]")
      .trim()
      .slice(0, BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxTextChars);
  })
  .pipe(z.string().max(BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxTextChars));

const bootMountDiagnosticPathSchema = z
  .string()
  .min(1)
  .max(BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxPathChars)
  .refine(
    (path) =>
      path === "out-of-scope" ||
      (path.startsWith("/") && !path.includes("?") && !path.includes("#")),
  );

export const bootMountFailurePredicateSchema = z.enum([
  "unexpected_candidate_request",
  "response_status",
  "request_failed",
  "page_error",
  "candidate_not_mounted",
]);
export type BootMountFailurePredicate = z.output<
  typeof bootMountFailurePredicateSchema
>;

/** Closed, safe names for exceptions used in host-side mount diagnostics. */
export const bootMountDiagnosticErrorNameSchema = z.enum([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "Other",
]);
export type BootMountDiagnosticErrorName = z.output<
  typeof bootMountDiagnosticErrorNameSchema
>;

const bootMountRequestFailureKindSchema = z.enum([
  "unexpected_candidate_request",
  "response_status",
  "request_failed",
]);
export type BootMountRequestFailureKind = z.output<
  typeof bootMountRequestFailureKindSchema
>;

const bootMountFailedRequestSchema = z
  .strictObject({
    path: bootMountDiagnosticPathSchema,
    status: z.number().int().min(100).max(599).optional(),
    failureKind: bootMountRequestFailureKindSchema.optional(),
  })
  .refine(
    (request) =>
      request.status !== undefined || request.failureKind !== undefined,
  );

/** Bounded, URL-redacted observations from one failed candidate mount. */
export const bootMountDiagnosticsSchema = z
  .strictObject({
    failedPredicate: bootMountFailurePredicateSchema,
    errorName: bootMountDiagnosticErrorNameSchema.optional(),
    finalUrlPath: bootMountDiagnosticPathSchema,
    consoleErrors: z
      .array(bootMountDiagnosticTextSchema)
      .max(BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxEntriesPerKind),
    pageErrors: z
      .array(bootMountDiagnosticTextSchema)
      .max(BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxEntriesPerKind),
    failedRequests: z
      .array(bootMountFailedRequestSchema)
      .max(BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxEntriesPerKind),
    droppedCount: z
      .number()
      .int()
      .min(0)
      .max(BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxDroppedCount),
  })
  .superRefine((diagnostics, context) => {
    if (
      diagnostics.consoleErrors.length +
        diagnostics.pageErrors.length +
        diagnostics.failedRequests.length >
      BOOT_MOUNT_DIAGNOSTIC_LIMITS.maxEntriesTotal
    )
      context.addIssue({
        code: "custom",
        message: "Mount observations exceed the total bound",
      });
  });
export type BootMountDiagnostics = z.output<typeof bootMountDiagnosticsSchema>;

const reasons = {
  backend_load_failed: "Candidate backend module could not load",
  backend_construction_failed:
    "Candidate backend could not construct on App storage",
  ui_mount_failed: "Candidate UI entry did not mount",
  boot_runner_unavailable:
    "Host boot runner is unavailable; the old version remains selected",
  boot_browser_binding_missing:
    "Cloudflare Browser Rendering binding BROWSER is missing; configure the browser binding before installing an App with a UI",
  boot_clone_unavailable:
    "Host facet clone is unavailable; copy-seeded construction refused",
  boot_timeout: "Candidate boot exceeded the host time limit",
  boot_cleanup_failed:
    "Host could not confirm candidate cleanup; activation refused",
} satisfies Record<BootFailure, string>;

/** Safe host-authored reason; never reflects guest logs, exceptions or credentials. */
export class BootGateError extends Error {
  override readonly name = "BootGateError";
  readonly diagnostics?: BootMountDiagnostics;
  constructor(
    readonly code: BootFailure,
    options?: ErrorOptions & { diagnostics?: BootMountDiagnostics },
  ) {
    super(reasons[code], options);
    if (options?.diagnostics !== undefined) {
      if (code !== "ui_mount_failed")
        throw new TypeError("Mount diagnostics require ui_mount_failed");
      this.diagnostics = bootMountDiagnosticsSchema.parse(options.diagnostics);
    }
  }
}

/** A finite host policy, not a candidate-configurable health check. */
export const BOOT_DEADLINE_MS = 10_000;
/** The original outer-request allowance, reserved for transport and cleanup. */
export const BOOT_TRANSPORT_GRACE_MS = 2_000;

/** Immutable artifact references only; bytes use the private native data plane. */
export const bootUiSchema = z.strictObject({
  identity: z.strictObject({
    appId: z.string().min(1).max(256),
    releaseId: z.string().transform(parseReleaseId),
    surfaceId: z.literal("host-boot"),
  }),
  base: z.string().min(1).max(2048),
  assets: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        contentType: z.string().min(1).max(256),
        artifactRef: z.string().transform(parseArtifactRef),
        digest: z.string().transform(parseSha256Digest),
      }),
    )
    .max(defaultAssetPolicy.maxObjects),
});
export type BootUi = z.output<typeof bootUiSchema>;
/** Captures the same no-grant UI representation as a private candidate preview. */
export async function readBootUi(
  store: ArtifactStore,
  release: Release,
): Promise<BootUi | null> {
  const verified = await verifyRelease(
    store,
    release,
    defaultAssetPolicy,
    false,
  );
  if (verified.ui === null) return null;
  const identity: BootUi["identity"] = {
    appId: release.appId,
    releaseId: release.releaseId,
    surfaceId: "host-boot",
  };
  if (verified.ui.kind === "html") {
    return {
      identity,
      base: "./",
      assets: [
        {
          path: "/index.html",
          contentType: "text/html; charset=utf-8",
          artifactRef: verified.ui.artifactRef,
          digest: verified.ui.digest,
        },
      ],
    };
  }
  const assets: BootUi["assets"] = [];
  for (const asset of verified.ui.build.assets)
    assets.push({
      path: asset.path,
      contentType: asset.contentType,
      artifactRef: asset.artifactRef,
      digest: asset.digest,
    });
  return {
    identity,
    // Preserve the build producer's relative base. A relative Vite base keeps
    // every asset beneath the host-selected boot URL without rewriting HTML.
    base: verified.ui.build.base,
    assets,
  };
}

export const bootCheckResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("passed") }),
  z.strictObject({
    kind: z.literal("not_checked"),
    code: z.enum([
      "boot_runner_unavailable",
      "boot_browser_binding_missing",
      "boot_timeout",
      "boot_clone_unavailable",
      "boot_cleanup_failed",
    ]),
  }),
  z
    .strictObject({
      kind: z.literal("refused"),
      code: bootFailureSchema,
      diagnostics: bootMountDiagnosticsSchema.optional(),
    })
    .refine(
      (result) =>
        result.diagnostics === undefined || result.code === "ui_mount_failed",
    ),
]);
export type BootCheckResult = z.output<typeof bootCheckResultSchema>;

/** A UI check recorded on an installation operation, never installation authority. */
export const uiBootCheckOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("passed") }),
  z.strictObject({
    kind: z.literal("failed"),
    code: z.literal("ui_mount_failed"),
    diagnostics: bootMountDiagnosticsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("not_checked"),
    code: z.enum([
      // Team hosts deliberately skip this check in their own isolate.
      "ui_check_not_run_on_host",
      "boot_runner_unavailable",
      "boot_browser_binding_missing",
      "boot_timeout",
      "boot_clone_unavailable",
      "boot_cleanup_failed",
    ]),
  }),
]);
/**
 * A UI check result recorded on an installation operation, never installation authority.
 *
 * @inline
 */
export type UiBootCheckOutcome = z.output<typeof uiBootCheckOutcomeSchema>;

/** Owner-facing 422 body; diagnostics are never copied into other failures. */
export const bootRefusalSchema = z
  .strictObject({
    error: bootFailureSchema,
    message: z.string().min(1).max(256),
    diagnostics: bootMountDiagnosticsSchema.optional(),
  })
  .refine(
    (refusal) =>
      refusal.diagnostics === undefined || refusal.error === "ui_mount_failed",
  );
