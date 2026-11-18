import * as Schema from "effect/Schema";
import { base64url } from "jose";
import { boundedDiagnostic } from "@fungi.computer/bird-dog/effect";
import {
  loadPatternRedactor,
  type PatternRedactor,
} from "@fungi.computer/veil/redaction";

/** Maximum retained combined stdout/stderr bytes, split equally into head and tail. */
export const buildJobLogMaxBytes = 2 * 1024 * 1024;

/** Base64url preserves raw command bytes, including split UTF-8 and terminal control bytes. */
export const buildJobLogSchema = Schema.Struct({
  encoding: Schema.Literal("base64url"),
  output: Schema.String.check(
    Schema.isMaxLength(Math.ceil(buildJobLogMaxBytes / 3) * 4),
  ),
  truncated: Schema.NullOr(
    Schema.Struct({
      droppedBytes: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThan(0),
      ),
    }),
  ),
});
export type BuildJobLog = Schema.Schema.Type<typeof buildJobLogSchema>;

/** The artifact-upload door cannot write this host-owned job-log namespace. */
export const isBuildJobLogRef = (ref: string): boolean =>
  ref.startsWith("artifact:build-log-");

/** One bounded raw-event ring; event arrival order is the combined output order. */
function createBoundedLog() {
  const half = buildJobLogMaxBytes / 2;
  let head = new Uint8Array(0);
  let tail = new Uint8Array(0);
  let headBytes = 0;
  let tailBytes = 0;
  let tailPosition = 0;
  let total = 0;
  const capacityFor = (current: number, needed: number) =>
    Math.min(half, Math.max(needed, current === 0 ? 4096 : current * 2));
  return {
    /** Retained buffer capacity, distinct from the transient encoded result. */
    get allocatedBytes() {
      return head.byteLength + tail.byteLength;
    },
    append(bytes: Uint8Array) {
      total += bytes.byteLength;
      const prefix = Math.min(half - headBytes, bytes.byteLength);
      if (headBytes + prefix > head.byteLength) {
        const next = new Uint8Array(
          capacityFor(head.byteLength, headBytes + prefix),
        );
        next.set(head.subarray(0, headBytes));
        head = next;
      }
      head.set(bytes.subarray(0, prefix), headBytes);
      headBytes += prefix;
      const remaining = bytes.subarray(prefix);
      if (remaining.byteLength === 0) return;
      const needed = Math.min(half, tailBytes + remaining.byteLength);
      if (needed > tail.byteLength) {
        const next = new Uint8Array(capacityFor(tail.byteLength, needed));
        const start = tailBytes === tail.byteLength ? tailPosition : 0;
        const first = Math.min(tailBytes, tail.byteLength - start);
        next.set(tail.subarray(start, start + first));
        next.set(tail.subarray(0, tailBytes - first), first);
        tail = next;
        tailPosition = tailBytes;
      }
      const suffix = remaining.subarray(
        Math.max(0, remaining.byteLength - half),
      );
      if (remaining.byteLength >= half) {
        tailBytes = 0;
        tailPosition = 0;
      }
      const first = Math.min(suffix.byteLength, tail.byteLength - tailPosition);
      tail.set(suffix.subarray(0, first), tailPosition);
      tail.set(suffix.subarray(first), 0);
      tailPosition = (tailPosition + suffix.byteLength) % tail.byteLength;
      tailBytes = Math.min(half, tailBytes + remaining.byteLength);
    },
    finish(): BuildJobLog {
      const bytes = new Uint8Array(headBytes + tailBytes);
      bytes.set(head.subarray(0, headBytes));
      const start = tailBytes === tail.byteLength ? tailPosition : 0;
      const first = Math.min(tailBytes, tail.byteLength - start);
      bytes.set(tail.subarray(start, start + first), headBytes);
      bytes.set(tail.subarray(0, tailBytes - first), headBytes + first);
      const droppedBytes = total - bytes.byteLength;
      return {
        encoding: "base64url",
        output: base64url.encode(bytes),
        truncated: droppedBytes === 0 ? null : { droppedBytes },
      };
    },
  };
}

/**
 * Latin-1 maps every byte to one code unit, so redaction sees the text and
 * every byte it does not mask (split UTF-8, terminal controls) comes back exact.
 */
function bytesToText(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.byteLength; start += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  return parts.join("");
}

function textToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++)
    bytes[index] = text.charCodeAt(index);
  return bytes;
}

/**
 * Pattern rules match complete text, so output is scanned in windows and the
 * last window stays unemitted: a secret split across events or windows is
 * still seen whole, and a stored byte is never an unscanned one.
 */
const scanWindow = 16 * 1024;
const maxPendingText = 1024 * 1024;

/** What a host writes where it cannot redact: the ADR's form, never raw output. */
export const redactionWithheld = "[output withheld: redaction unavailable]";

/**
 * The redactor, or undefined when its rules cannot load: callers then write
 * {@link redactionWithheld} and never the unredacted text.
 */
async function loadRedactorOrWithhold(): Promise<{
  redactor: PatternRedactor | undefined;
}> {
  try {
    return { redactor: await loadPatternRedactor() };
  } catch (cause) {
    console.error(
      "redaction rules failed to load",
      cause instanceof Error ? cause.name : "unknown",
    );
    return { redactor: undefined };
  }
}

/**
 * One bounded sink for a build's combined output. Veil's pattern redactor
 * (S3's gitleaks rules) runs before a byte is retained, so the stored log and
 * every `?log` read of it are already scrubbed.
 */
export async function createBuildJobLog() {
  const ring = createBoundedLog();
  // A rule table that cannot load stores the withheld notice, never the output.
  const { redactor } = await loadRedactorOrWithhold();
  let pending = "";
  let scannedLength = 0;
  const scan = (final: boolean) => {
    if (redactor === undefined) {
      pending = "";
      scannedLength = 0;
      if (final) ring.append(textToBytes(redactionWithheld));
      return;
    }
    const text = redactor.redact(pending).text;
    if (final) {
      ring.append(textToBytes(text));
      pending = "";
      scannedLength = 0;
      return;
    }
    // Text past the last replacement is unchanged; a match near the end could
    // still grow with later output, so only an unchanged window leaves pending.
    let unchanged = 0;
    while (
      unchanged < text.length &&
      unchanged < pending.length &&
      text[text.length - 1 - unchanged] ===
        pending[pending.length - 1 - unchanged]
    )
      unchanged++;
    if (
      text.length > scanWindow &&
      (unchanged >= scanWindow || text.length > maxPendingText)
    ) {
      ring.append(textToBytes(text.slice(0, text.length - scanWindow)));
      pending = text.slice(text.length - scanWindow);
    }
    scannedLength = pending.length;
  };
  return {
    /** Retained buffer capacity, distinct from the transient encoded result. */
    get allocatedBytes() {
      return ring.allocatedBytes;
    },
    append(bytes: Uint8Array) {
      pending += bytesToText(bytes);
      if (
        pending.length >= Math.max(2 * scanWindow, scannedLength + scanWindow)
      )
        scan(false);
    },
    finish(): BuildJobLog {
      scan(true);
      return ring.finish();
    },
  };
}

/** The job read door, not an artifact-serving URL. */
const buildJobLogReference = (jobId: string) =>
  `/api/builds/${encodeURIComponent(jobId)}?log`;

/** Preserve BirdDog's redacted 200-character status/mail budget and name the full log. */
export async function buildJobDiagnostic(
  jobId: string,
  detail: string,
): Promise<string> {
  const reference = `Log: ${buildJobLogReference(jobId)}`;
  const { redactor } = await loadRedactorOrWithhold();
  const diagnostic =
    boundedDiagnostic(
      redactor === undefined ? redactionWithheld : redactor.redact(detail).text,
    ) ?? "Build finished";
  return `${reference}\n${diagnostic.slice(0, 200 - reference.length - 1)}`;
}
