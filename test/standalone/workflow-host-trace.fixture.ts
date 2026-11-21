export type WorkflowHostOperation =
  | "list-runs-request"
  | "app-list-runs"
  | "runs-binding"
  | "workflow-runs"
  | "workflow-alarm";

// Fixture-only timing: never log request URLs, headers, inputs or errors.
// A request's existing load-scaled limit is at most 120 seconds. Stop its
// heartbeat there even if native dispatch never settles; do not keep it alive.
export function createWorkflowHostTrace(
  write: (
    event: Readonly<{
      proof: "workflow-host-trace";
      id: number;
      operation: WorkflowHostOperation;
      phase: "enter" | "heartbeat" | "observation-ended" | "return" | "throw";
      at: number;
      elapsedMs: number;
      lateByMs: number;
    }>,
  ) => void,
) {
  let sequence = 0;
  return async <T>(
    operation: WorkflowHostOperation,
    body: () => Promise<T>,
  ): Promise<T> => {
    const id = ++sequence;
    const started = Date.now();
    let previous = started;
    const record = (
      phase: "enter" | "heartbeat" | "observation-ended" | "return" | "throw",
    ) => {
      const at = Date.now();
      write({
        proof: "workflow-host-trace",
        id,
        operation,
        phase,
        at,
        elapsedMs: at - started,
        lateByMs: phase === "heartbeat" ? Math.max(0, at - previous - 1000) : 0,
      });
      previous = at;
    };
    record("enter");
    const timer = setInterval(() => {
      record("heartbeat");
      if (Date.now() - started >= 120_000) {
        clearInterval(timer);
        record("observation-ended");
      }
    }, 1000);
    let phase: "return" | "throw" = "throw";
    try {
      const result = await body();
      phase = "return";
      return result;
    } finally {
      clearInterval(timer);
      record(phase);
    }
  };
}
