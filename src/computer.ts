import {
  computerPorts,
  computerProcesses,
  computerTerminal,
} from "@fungi.computer/agar/computer";
import type { CapabilityDescriptor } from "./capability-descriptor.js";

export {
  ComputerTerminalHost,
  type ComputerTerminalAccess,
  type ComputerTerminalConnect,
  type ComputerTerminalHostOptions,
  type ComputerTerminalSelection,
} from "./computer-terminal.js";

/** Computer routes supplied by the host; execution stays in the Computer runtime. */
export const computerSlots = {
  ports: {
    id: computerPorts.id,
    version: computerPorts.version,
    base: "/computer/",
    methods: {
      list: { kind: "json", method: "GET", path: "ports" },
      expose: { kind: "json", method: "POST", path: "ports/expose" },
      unexpose: { kind: "json", method: "POST", path: "ports/unexpose" },
    },
  },
  processes: {
    id: computerProcesses.id,
    version: computerProcesses.version,
    base: "/computer/",
    methods: {
      start: { kind: "json", method: "POST", path: "processes/start" },
      list: { kind: "json", method: "GET", path: "processes" },
      kill: { kind: "json", method: "POST", path: "processes/kill" },
    },
  },
  terminal: {
    id: computerTerminal.id,
    version: computerTerminal.version,
    base: "/computer/",
    methods: {
      open: { kind: "transport", method: "GET", path: "terminal" },
    },
  },
} as const satisfies Readonly<Record<string, CapabilityDescriptor>>;
