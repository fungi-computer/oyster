import {
  ComputerTerminalHost,
  type ComputerTerminalConnect,
  type ComputerTerminalHostOptions,
} from "../computer-terminal.js";

/** Bind the shared terminal protocol to Oyster's admitted transport factory. */
export class TerminalCapability extends ComputerTerminalHost {
  constructor(
    connect: (input: Parameters<ComputerTerminalConnect>[1]) => WebSocket,
    options: Omit<ComputerTerminalHostOptions, "connect">,
  ) {
    super({ ...options, connect: (_url, input) => connect(input) });
  }
}
