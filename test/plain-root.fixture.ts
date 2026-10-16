// Oyster's plain root alone, the layer under the standalone host: one owner, Apps installed from Releases, each App's
// backend in its own Durable Object with SQLite. Runs on Cloudflare Workers
// (`wrangler deploy`) and on celld (`celld dev`) from the same code.
import { createOysterWorker } from "@fungi.computer/oyster/workers";

// Every App binding in every invocation frame is the one `OysterBinding` entrypoint.
export {
  OysterBinding,
  OysterInstance,
  OysterRegistry,
  OysterMcp,
} from "@fungi.computer/oyster/workers";

export default createOysterWorker();
