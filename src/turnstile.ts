import { z } from "zod";

const siteverifyUrl =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const environmentSchema = z.object({
  TURNSTILE: z.literal("off").optional(),
  TURNSTILE_SITE_KEY: z.string().trim().min(1).optional(),
  TURNSTILE_SECRET_KEY: z.string().trim().min(1).optional(),
});
const responseSchema = z.object({ success: z.boolean() });
type SiteverifyRequest = {
  secret: string;
  response: string;
  remoteip?: string;
};

/** Host-owned configuration inputs, decoded before any challenge is opened. */
export type TurnstileEnvironment = Readonly<{
  TURNSTILE?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}>;

/** Explicit opt-out, complete verification credentials, or a closed door. */
export type TurnstileConfiguration =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "enabled"; siteKey: string; secretKey: string }>
  | Readonly<{ kind: "misconfigured" }>;

/** Retain the development default; HTTPS hosts without keys fail closed. */
export function readTurnstileConfiguration(
  environment: TurnstileEnvironment,
  origin: string | undefined,
): TurnstileConfiguration {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) return { kind: "misconfigured" };
  if (parsed.data.TURNSTILE === "off") return { kind: "disabled" };
  const { TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: secretKey } =
    parsed.data;
  if (siteKey === undefined && secretKey === undefined)
    return URL.parse(origin ?? "")?.protocol === "https:"
      ? { kind: "misconfigured" }
      : { kind: "disabled" };
  if (siteKey === undefined || secretKey === undefined)
    return { kind: "misconfigured" };
  return { kind: "enabled", siteKey, secretKey };
}

/** Verify with Cloudflare; timeout policy and safe failure reporting belong to the host. */
export async function verifyTurnstileToken(
  input: {
    secretKey: string;
    token: string;
    remoteIp?: string;
  },
  options: {
    timeoutMs: number;
    onError(cause: unknown): void;
  },
): Promise<"passed" | "failed" | "unavailable"> {
  try {
    const body: SiteverifyRequest = {
      secret: input.secretKey,
      response: input.token,
    };
    if (input.remoteIp !== undefined) body.remoteip = input.remoteIp;
    const response = await fetch(siteverifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return "unavailable";
    const verdict = responseSchema.safeParse(await response.json());
    if (!verdict.success) return "unavailable";
    return verdict.data.success ? "passed" : "failed";
  } catch (cause) {
    options.onError(cause);
    return "unavailable";
  }
}
