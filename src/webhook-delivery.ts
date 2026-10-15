import { webhookHeaders } from "./git.js";

/** HTTP refusals and transport failures both remain eligible for owner retries. */
export async function attemptWebhook(
  target: Readonly<{ url: string; secret: string }>,
  delivery: Readonly<{ id: string; type: string; body: string }>,
): Promise<
  | Readonly<{ kind: "response"; status: number }>
  | Readonly<{ kind: "transport-error" }>
> {
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: await webhookHeaders(
        target.secret,
        delivery.id,
        delivery.type,
        Math.floor(Date.now() / 1000),
        delivery.body,
      ),
      body: delivery.body,
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return { kind: "response", status: response.status };
  } catch {
    return { kind: "transport-error" };
  }
}
