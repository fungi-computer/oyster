// Mycelium's execute admission caps the live invocation at fifteen minutes.
const maximumCallMs = 900_000;

/** Pin a finite deadline before RPC so delayed delivery cannot renew a call. */
export function oysterApprovalDeadlineAt(deadlineAt: number | null): number {
  const maximum = Date.now() + maximumCallMs;
  return Math.min(deadlineAt ?? maximum, maximum);
}
