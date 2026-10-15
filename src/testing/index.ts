/**
 * Test kit for Oyster hosts and Apps: fixture installations, a capability
 * host, a digest-verifying release catalog and the frame binding wire.
 * The `cloudflare:workers` stand-in lives at `./testing/workers-runtime`.
 */
export { approvedInstallation } from "./installation.js";
export {
  capabilityFixture,
  type CapabilityFixtureOptions,
} from "./capabilities.js";
export { createFixtureCatalog, seedFixtureCatalog } from "./catalog.js";
export {
  createFrameBindingWire,
  type FrameBindingReply,
  type FrameBindingWire,
} from "../frame-binding-wire.js";
export {
  startNativeWorker,
  type NativeWorker,
  type NativeWorkerOptions,
} from "./native-worker.js";
