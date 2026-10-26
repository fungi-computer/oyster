import standalone, {
  ComputerDO as NativeComputerDO,
  type StandaloneEnv,
} from "../../src/standalone/worker.js";

export * from "../../src/standalone/worker.js";

// Workerd fixture has no container binding. The real registry, owner
// admission, fleet inventory and MCP owner run unchanged; only boot I/O
// returns a connected state instead of launching a container.
export class ComputerDO extends NativeComputerDO {
  override async startHostedComputer(
    authority: Parameters<NativeComputerDO["startHostedComputer"]>[0],
  ) {
    await this.readHostedComputerState(authority);
    return { state: "running" as const };
  }
}

export default {
  async fetch(
    request: Parameters<NonNullable<typeof standalone.fetch>>[0],
    env: StandaloneEnv,
    context: Parameters<NonNullable<typeof standalone.fetch>>[2],
  ) {
    if (new URL(request.url).pathname === "/health")
      return new Response("ready");
    try {
      return await standalone.fetch(request, env, context);
    } catch (error) {
      console.error("Fleet proof Worker error", error);
      throw error;
    }
  },
} satisfies ExportedHandler<StandaloneEnv>;
