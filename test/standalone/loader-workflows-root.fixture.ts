import { WorkerEntrypoint } from "cloudflare:workers";
import root from "./workflows-root.fixture.js";
import { StandaloneWorkflowRuns as WorkflowRuns } from "./workflows-root.fixture.js";
export * from "./workflows-root.fixture.js";

/** Real wall time here: the larger schedule fixture deliberately fast-forwards. */
export class StandaloneWorkflowRuns extends WorkflowRuns {
  private receivingWebhook = false;

  constructor(
    ctx: ConstructorParameters<typeof WorkflowRuns>[0],
    env: ConstructorParameters<typeof WorkflowRuns>[1],
  ) {
    super(ctx, {
      ...env,
      WORKFLOW_WEBHOOK_POLICY: {
        limits: {
          bodyBytes: 64 * 1024,
          headerBytes: 16 * 1024,
          headerCount: 64,
          readMilliseconds: 5000,
        },
        concurrency: { hostConcurrency: 20, bindingConcurrency: 4 },
      },
    });
    const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
    let loseWakeAcknowledgement = true;
    ctx.storage.setAlarm = async (...args: Parameters<typeof setAlarm>) => {
      await setAlarm(...args);
      // Lose only intake's acknowledgement, after the real native alarm write.
      if (loseWakeAcknowledgement && this.receivingWebhook) {
        loseWakeAcknowledgement = false;
        throw new Error("private native wake acknowledgement lost");
      }
    };
  }
  override async fetch(request: Request): Promise<Response> {
    this.receivingWebhook = new URL(request.url).pathname.startsWith(
      "/webhooks/",
    );
    try {
      return await super.fetch(request);
    } finally {
      this.receivingWebhook = false;
    }
  }
  protected override readonly scheduleClock = {
    now: () => Date.now(),
    alarmAt: (due: number) => due,
  };
}

export type CanonicalEnv = Parameters<typeof root.fetch>[1] & {
  CANONICAL_ROOT: Fetcher;
};

/** The unchanged root receives the request as ordinary incoming traffic. */
export class CanonicalRoot extends WorkerEntrypoint<CanonicalEnv> {
  override fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
  ): Promise<Response> {
    return root.fetch(request, this.env, this.ctx);
  }
}

// The local CLI listens on loopback HTTP. Present the configured canonical
// HTTPS origin at the fixture transport boundary, before the unchanged root
// performs tenant resolution, authentication, and App admission.
export default {
  fetch(request, env) {
    const incoming = new URL(request.url);
    const canonical = new URL(
      incoming.pathname + incoming.search,
      env.OYSTER_ORIGIN,
    );
    return env.CANONICAL_ROOT.fetch(new Request(canonical, request));
  },
} satisfies ExportedHandler<CanonicalEnv>;
