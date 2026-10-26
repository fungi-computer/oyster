import { boundedDiagnostic } from "@fungi.computer/bird-dog/effect";

/** The builder's error and at most two causes, safe for a build record. */
export function candidateFailureDiagnostic(cause: unknown): string {
  const messages: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!(current instanceof Error)) {
      if (depth === 0) messages.push("Non-error thrown");
      break;
    }
    messages.push(
      `${depth === 0 ? "" : "Caused by: "}${current.message || current.name}`,
    );
    current = current.cause;
  }
  return boundedDiagnostic(messages.join("; ")) ?? "Build failed";
}
