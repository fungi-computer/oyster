import { z } from "zod";
import type { AppFailureReason } from "@fungi.computer/agar/backend";
import type { FrameBindingMethod } from "./cloudflare.js";

/**
 * Why one invocation failed on the host's side, written by the frame owner and
 * read by the same invocation when its guest call rejects. Only host-known
 * names and a field path: a failure that crossed the guest facet is never
 * trusted for text.
 */
export type FrameFailure = Readonly<{
  reason: Extract<AppFailureReason, "binding_reply_invalid">;
  binding: string;
  method: string;
  path: string;
}>;

/** One slot per invocation; the first host failure wins. */
export type FrameFailureSlot = Readonly<{
  /** Keep this failure unless the frame already holds one. */
  record(failure: FrameFailure): void;
  /** The first recorded failure, if any. */
  read(): FrameFailure | undefined;
}>;

/** A fresh, empty failure slot for one invocation. */
export function createFrameFailureSlot(): FrameFailureSlot {
  let held: FrameFailure | undefined;
  return {
    record(failure) {
      held ??= failure;
    },
    read: () => held,
  };
}

/** The field a reply decoder rejected: the deepest path among its (nested union) issues. */
export function rejectedFieldPath(cause: Error): string {
  if (!(cause instanceof z.ZodError)) return "";
  const paths: string[][] = [];
  const collect = (issues: readonly z.core.$ZodIssue[], prefix: string[]) => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path.map(String)];
      if (issue.code === "invalid_union") {
        for (const branch of issue.errors) collect(branch, path);
      } else paths.push(path);
    }
  };
  collect(cause.issues, []);
  const deepest = paths.reduce<string[]>(
    (best, path) => (path.length > best.length ? path : best),
    [],
  );
  return deepest.join(".").slice(0, 256);
}

/**
 * Decode one connection reply with its method's descriptor: the only place a
 * reply is decoded, where it first arrives and the frame that asked is in
 * hand. A reply the descriptor rejects is our bug, not the App's: it is
 * recorded on the frame (and named in the log, never its values) before the
 * exception reaches the guest, which cannot be trusted to say why. `logged`
 * names the frame and invocation in that log line.
 */
export function decodeBindingReply<Result>(
  descriptor: Pick<FrameBindingMethod<Result>, "decodeResult">,
  call: Readonly<{ binding: string; method: string }>,
  reply: Parameters<FrameBindingMethod<Result>["decodeResult"]>[0],
  failure: FrameFailureSlot,
  logged: Readonly<Record<string, string | null>>,
): Result {
  try {
    return descriptor.decodeResult(reply);
  } catch (cause) {
    const path = cause instanceof Error ? rejectedFieldPath(cause) : "";
    failure.record({
      reason: "binding_reply_invalid",
      binding: call.binding,
      method: call.method,
      path,
    });
    console.error("App binding reply invalid", {
      binding: call.binding,
      method: call.method,
      path,
      ...logged,
    });
    throw cause;
  }
}

/**
 * The host failed this invocation for a reason it recorded on the frame. It is
 * built by the frame owner after the guest call rejects, so its reason is the
 * host's own and never text that crossed the guest facet.
 */
export class FrameFailureError extends Error {
  readonly failure: FrameFailure;
  readonly ref: string;
  constructor(failure: FrameFailure, ref: string, options: ErrorOptions) {
    super(
      `App connection reply invalid: ${failure.binding}.${failure.method}`,
      options,
    );
    this.name = "FrameFailureError";
    this.failure = failure;
    this.ref = ref;
  }
}
