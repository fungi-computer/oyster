// The standalone Worker's own exports, as `ctx.exports` loopbacks: the
// ComputerDO reaches its egress gateway, and the gateway this Worker's own
// default export, without a configured service binding.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.js");
  }
}
