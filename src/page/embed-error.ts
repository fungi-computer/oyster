type SafeCause = {
  kind: "error" | "non-error";
  cause?: SafeCause;
};

function describeCause(cause: unknown, depth = 0): SafeCause {
  if (!(cause instanceof Error)) return { kind: "non-error" };
  const description: SafeCause = { kind: "error" };
  if (cause.cause !== undefined && depth < 3)
    description.cause = describeCause(cause.cause, depth + 1);
  return description;
}

/** Report a widget failure without writing exception messages or visitor data. */
export function reportEmbedCatchFailure(
  operation: string,
  cause: unknown,
): void {
  console.error(
    JSON.stringify({
      event: "hub_catch_failure",
      operation,
      cause: describeCause(cause),
    }),
  );
}
