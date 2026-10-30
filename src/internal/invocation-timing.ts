/** Stage timing for slow App invocations, logged by the Instance that ran them. */
/** Invocations slower than this log their stages; faster ones log nothing. */
const slowInvocationMs = 200;

/**
 * Name where a slow App invocation waited, as the Instance saw it: verifying
 * its backend, waiting for the frame permit, running the guest, and the guest's
 * binding packets inside that run. Durable Object wall time otherwise hides
 * which of these a caller's seconds went to.
 */
export function reportSlowInvocation(
  name: string,
  host: Readonly<{ bindingWaits: { count: number; ms: number } }>,
  at: Readonly<{ entered: number; verified: number; admitted: number }>,
  now: () => number = Date.now,
): void {
  const finished = now();
  if (finished - at.entered < slowInvocationMs) return;
  console.log("Slow App invocation", {
    name,
    totalMs: finished - at.entered,
    verifyMs: at.verified - at.entered,
    permitMs: at.admitted - at.verified,
    runMs: finished - at.admitted,
    bindingCalls: host.bindingWaits.count,
    bindingMs: host.bindingWaits.ms,
  });
}
