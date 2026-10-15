import { RpcTarget } from "@fungi.computer/capnweb";
import * as Schema from "effect/Schema";
import type { CapabilityContract } from "@fungi.computer/agar";
import {
  computerPortExposureSchema,
  computerPortRemovalSchema,
  computerPortsResultSchema,
  computerProcessKillSchema,
  computerProcessSchema,
  computerProcessesSchema,
  type ComputerProcessStart,
  type computerPorts,
  type computerProcesses,
} from "@fungi.computer/agar/computer";
import type { CapabilityJsonCaller } from "./capabilities.js";

/** The App-facing handle a capability contract describes. */
export type HandleOf<Contract> =
  Contract extends CapabilityContract<infer Handle> ? Handle : never;

/**
 * Agar's `computer.ports` handle over the host's wire. The App passes a bare
 * port; Hub's routes and the Computer owner take `{ port }` as the body, so
 * this handle is the one place that maps between the two.
 */
export class ComputerPortsHandle
  extends RpcTarget
  implements HandleOf<typeof computerPorts>
{
  readonly #call: CapabilityJsonCaller;

  constructor(call: CapabilityJsonCaller) {
    super();
    this.#call = call;
  }

  async list() {
    return Schema.decodeUnknownSync(computerPortsResultSchema)(
      await this.#call("list"),
    );
  }

  async expose(port: number) {
    return Schema.decodeUnknownSync(computerPortExposureSchema)(
      await this.#call("expose", { port }),
    );
  }

  async unexpose(port: number) {
    return Schema.decodeUnknownSync(computerPortRemovalSchema)(
      await this.#call("unexpose", { port }),
    );
  }
}

/**
 * Agar's `computer.processes` handle over the host's wire. The App passes a
 * bare process ID to `kill`; the host route takes `{ id }` as the body.
 */
export class ComputerProcessesHandle
  extends RpcTarget
  implements HandleOf<typeof computerProcesses>
{
  readonly #call: CapabilityJsonCaller;

  constructor(call: CapabilityJsonCaller) {
    super();
    this.#call = call;
  }

  async start(input: ComputerProcessStart) {
    return Schema.decodeUnknownSync(computerProcessSchema)(
      await this.#call("start", input),
    );
  }

  async list() {
    return Schema.decodeUnknownSync(computerProcessesSchema)(
      await this.#call("list"),
    );
  }

  async kill(id: string) {
    return Schema.decodeUnknownSync(computerProcessKillSchema)(
      await this.#call("kill", { id }),
    );
  }
}
