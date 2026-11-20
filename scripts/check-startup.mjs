// Report the standalone Worker's startup CPU: the least and median of five
// `wrangler check startup` profiles of the bundle `wrangler deploy` uploads.
// It is a report to read before deploying the Worker to Cloudflare (a deploy
// over the startup limit is refused with error 10021), not a gate: CPU
// timing on a shared machine varies by tens of milliseconds between runs, so
// test/startup-graph.test.mjs pins the deterministic cause (what startup
// imports, and its eager code budget). Run it on a quiet machine, and compare
// two builds in the same session:
//   pnpm run check:startup
import console from "node:console";
import { least, median, profileStartup } from "./startup-profile.mjs";

const samples = await profileStartup();
const active = samples.map((sample) => sample.active);
console.log(
  `startup profile (${String(samples.length)} runs): active CPU least ${least(active).toFixed(1)} ms, median ${median(active).toFixed(1)} ms; window median ${median(samples.map((sample) => sample.window)).toFixed(1)} ms`,
);
