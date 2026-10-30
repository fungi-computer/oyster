import * as Schema from "effect/Schema";
import { base64url } from "jose";
import { boundedDiagnostic } from "@fungi.computer/bird-dog/effect";

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

/** One bounded raw-event sink; event arrival order is the combined output order. */
export function createBuildJobLog() {
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

/** The job read door, not an artifact-serving URL. */
const buildJobLogReference = (jobId: string) =>
  `/api/builds/${encodeURIComponent(jobId)}?log`;

/** Preserve BirdDog's redacted 200-character status/mail budget and name the full log. */
export function buildJobDiagnostic(jobId: string, detail: string): string {
  const reference = `Log: ${buildJobLogReference(jobId)}`;
  const diagnostic = boundedDiagnostic(detail) ?? "Build finished";
  return `${reference}\n${diagnostic.slice(0, 200 - reference.length - 1)}`;
}
