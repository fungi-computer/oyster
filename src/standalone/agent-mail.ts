import { createPost } from "@fungi.computer/carrier/post";
import type { WatchdogTickResult } from "@fungi.computer/watchdog";
import type { CloudflareShiitakeOptions } from "@fungi.computer/shiitake/cloudflare";
import { AgentMail, agentMailRoute } from "@fungi.computer/shiitake/delegation";

/** Standalone borrows Shiitake's one Watchdog and Carrier's ordinary durable lane. */
export function agentMail(
  options: Omit<
    ConstructorParameters<typeof AgentMail>[0],
    "post" | "drain"
  > & {
    namespace: Parameters<typeof agentMailRoute>[0];
  },
) {
  const routes = {
    agentMail: agentMailRoute(options.namespace, options.replySettlement),
  };
  let post: ReturnType<typeof createPost<typeof routes>> | undefined;
  let tick: (() => Promise<WatchdogTickResult>) | undefined;
  const runtime = () => {
    if (post === undefined) throw new Error("Agent Post is not open");
    return post;
  };
  const drain = async () => {
    if (tick === undefined) throw new Error("Agent Post lane is not open");
    await tick();
  };
  const mail = new AgentMail({ ...options, post: runtime, drain });
  const host = {
    mailRoom: mail.mailRoom(),
    hostJobs: {
      lane: "post",
      open: (owner) => {
        post = createPost({
          routes,
          owner: options.storage,
          transactional: owner.transactional,
          now: Date.now,
          scheduleWake: options.wake,
        });
        tick = owner.tickConcurrent;
        return {
          retryPolicy: (job) => runtime().retryPolicy(job),
          execute: async (job, signal, attempt) => {
            const decision = await runtime().execute(job, attempt, signal);
            await mail.stageUndeliverableReplies();
            return decision;
          },
        };
      },
    },
  } satisfies Required<
    Pick<CloudflareShiitakeOptions, "mailRoom" | "hostJobs">
  >;
  return {
    host,
    deliver: (value: Parameters<AgentMail["send"]>[0]) => {
      return mail.send(value);
    },
  };
}
