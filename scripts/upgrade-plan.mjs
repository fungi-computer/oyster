import { z } from "zod";

const oldReleases = new Set([
  "0.0.1",
  "0.1.0",
  "0.2.0",
  "0.3.0",
  "0.3.1",
  "0.3.2",
  "0.4.0",
  "0.4.1",
]);
const marker = z.strictObject({ version: z.string() });

function stop(cause) {
  console.error(
    "Old Worker version unknown — STOP. No archive or setup was started.",
    ...(cause === undefined ? [] : [cause]),
  );
  process.exitCode = 2;
}

// Read-only preflight. An unmarked old Worker needs independent identity proof;
// never infer its version from a 404, a 409, or an operator-supplied number.
const [oldOrigin, ...rest] = process.argv.slice(2);
if (oldOrigin === undefined || rest.length > 0) {
  console.error("Usage: node scripts/upgrade-plan.mjs <old-worker-origin>");
  process.exitCode = 2;
} else {
  try {
    const origin = new URL(oldOrigin);
    if (origin.protocol !== "https:" && origin.protocol !== "http:")
      throw new Error("Only HTTP(S) Worker origins are supported");
    const response = await fetch(new URL("/version", origin), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) {
      stop();
    } else {
      const parsed = marker.safeParse(await response.json());
      if (!parsed.success || !oldReleases.has(parsed.data.version)) {
        stop();
      } else {
        console.log(
          `Oyster ${parsed.data.version} marker observed. Planning only: no archive, setup or deployment was performed.`,
        );
      }
    }
  } catch (cause) {
    stop(cause);
  }
}
