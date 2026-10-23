import { z } from "zod";
import { createHash } from "node:crypto";
import type { RateLimit } from "@cloudflare/workers-types";

// The maintained edge rate-limit contract bounds keys to 256 characters.
// Hash the full scoped tuple, rather than truncating identities or depending
// on a provider to accept an oversized concatenation.
const rateKey = (parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const webhookConcurrencySchema = z.strictObject({
  hostConcurrency: z.number().int().positive(),
  bindingConcurrency: z.number().int().positive(),
});

/** Native rate bindings own quotas; this adapter never implements a rate clock. */
export function workflowWebhookAbuse(options: {
  scope: Readonly<{ host: string; tenant: string }>;
  hostRate: Pick<RateLimit, "limit">;
  bindingRate: Pick<RateLimit, "limit">;
  concurrency: z.input<typeof webhookConcurrencySchema>;
}) {
  const scope = z
    .strictObject({
      host: z.string().min(1).max(256),
      tenant: z.string().min(1).max(256),
    })
    .parse(options.scope);
  const concurrency = webhookConcurrencySchema.parse(options.concurrency);
  const prefix = ["workflow-webhooks", scope.host, scope.tenant];
  let active = 0;
  return {
    concurrency,
    /** Per-instance streaming bound; durable run concurrency belongs to Braid. */
    async hostLease(): Promise<null | (() => void)> {
      if (active >= concurrency.hostConcurrency) return null;
      const { success } = await options.hostRate.limit({
        key: rateKey(["workflow-webhooks", scope.host, "host"]),
      });
      // Native admission awaits I/O; simultaneous successful replies still
      // cannot overbook the local streaming ceiling.
      if (!success || active >= concurrency.hostConcurrency) return null;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
    async bindingAdmission(bindingId: string): Promise<boolean> {
      const id = z.string().min(1).max(256).safeParse(bindingId);
      if (!id.success) return false;
      const { success } = await options.bindingRate.limit({
        key: rateKey([...prefix, "binding", id.data]),
      });
      return success;
    },
  };
}
