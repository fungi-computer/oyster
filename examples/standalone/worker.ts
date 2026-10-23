// The whole Oyster: Apps installed from Releases, each with its own Durable
// Object and SQLite; git through Artifacts; a Computer in a Cloudflare
// Container that builds App sources and runs terminals and files; Agents on
// Workers AI; Workflows; media; and Browser Rendering for UI boot checks.
// wrangler.jsonc supplies BROWSER; Worker builds never fall back to localhost.
// Runs on Cloudflare Workers
// (`wrangler deploy`) and on celld from the same code.
export * from "@fungi.computer/oyster/standalone";
export { default } from "@fungi.computer/oyster/standalone";
