/** Never copy a guest-controlled name, message or stack into host diagnostics. */
export function causeClass(cause: unknown) {
  if (cause instanceof TypeError) return "TypeError";
  if (cause instanceof RangeError) return "RangeError";
  if (cause instanceof SyntaxError) return "SyntaxError";
  if (cause instanceof DOMException) {
    if (cause.name === "AbortError") return "AbortError";
    if (cause.name === "TimeoutError") return "TimeoutError";
    return "Other";
  }
  return cause instanceof Error ? "Error" : "Other";
}

/** Failures that crossed the App facet boundary; their text may be guest-authored. */
const guestCrossed = new WeakSet<object>();

/** Mark a failure that came back through the App facet so host logs keep only its class. */
export function guestFailure<E extends Error>(cause: E): E {
  guestCrossed.add(cause);
  return cause;
}

const maxDiagnosticMessage = 240;
const platformFlags = [
  "remote",
  "retryable",
  "overloaded",
  "durableObjectReset",
] as const;
export type PlatformFlag = (typeof platformFlags)[number];

/** A host-owned failure diagnostic; see {@link failureDiagnostic}. */
export type FailureDiagnostic = {
  causeClass: ReturnType<typeof causeClass>;
  platform?: PlatformFlag[];
  message?: string;
};

/**
 * One host-owned failure diagnostic: the closed cause class, the workerd
 * platform flags that are `true`, and, only when no guest produced the failure,
 * its first message line bounded to {@link maxDiagnosticMessage} characters.
 */
export function failureDiagnostic(cause: unknown): FailureDiagnostic {
  const diagnostic: FailureDiagnostic = { causeClass: causeClass(cause) };
  if (!(cause instanceof Error)) return diagnostic;
  const flags = platformFlags.filter(
    (flag) => Object.getOwnPropertyDescriptor(cause, flag)?.value === true,
  );
  if (flags.length > 0) diagnostic.platform = flags;
  if (!guestCrossed.has(cause)) {
    const [line = ""] = cause.message.split("\n", 1);
    // Control characters become spaces so one failure stays one log line.
    const message = line
      .replace(/\p{Cc}/gu, " ")
      .slice(0, maxDiagnosticMessage);
    if (message.length > 0) diagnostic.message = message;
  }
  return diagnostic;
}
