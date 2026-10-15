import { mediaGeneration } from "@fungi.computer/agar/media";
import type { CapabilityDescriptor } from "./capability-descriptor.js";

/** Media slot supplied by the host; Oyster owns routing, never generation. */
export const mediaSlot = {
  id: "media.generation",
  version: mediaGeneration.version,
  base: "/media/",
  methods: {
    describe: { kind: "json", method: "GET", path: "describe" },
    generate: { kind: "json", method: "POST", path: "generate" },
    cancelAttempt: { kind: "json", method: "POST", path: "cancel-attempt" },
  },
} as const satisfies CapabilityDescriptor;
