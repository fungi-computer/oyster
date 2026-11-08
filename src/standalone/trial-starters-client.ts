import * as z from "zod";
import type { InstallingApp } from "@fungi.computer/nacre/workbench-directory";
import { trialStartersBodySchema } from "./trial-starters.js";

const retriesSchema = z.strictObject({
  retries: z.array(z.string().min(1).max(64)).max(16),
});

/** The owner-key request `oyster try` makes to the Oyster it started. */
export type TrialRequest = Readonly<{
  url: string;
  key: string;
  signal?: AbortSignal;
}>;

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  Accept: "application/json",
});

/** Tell the running Oyster which starter Apps are installing, failed or need a runtime. */
export async function reportTrialStarters(
  input: TrialRequest & { installing: readonly InstallingApp[] },
): Promise<void> {
  const body = trialStartersBodySchema.parse({ installing: input.installing });
  const init: RequestInit = {
    method: "PUT",
    headers: { ...headers(input.key), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (input.signal) init.signal = input.signal;
  const response = await fetch(new URL("/api/trial/starters", input.url), init);
  if (response.status !== 204)
    throw new Error(
      `Starter state was not accepted (HTTP ${String(response.status)}).`,
    );
}

/** Take the Apps the desktop asked to retry; each ask is handed out once. */
export async function takeTrialRetries(
  input: TrialRequest,
): Promise<readonly string[]> {
  const init: RequestInit = { method: "POST", headers: headers(input.key) };
  if (input.signal) init.signal = input.signal;
  const response = await fetch(
    new URL("/api/trial/starters/retries", input.url),
    init,
  );
  if (!response.ok)
    throw new Error(
      `Retry asks were not readable (HTTP ${String(response.status)}).`,
    );
  return retriesSchema.parse(await response.json()).retries;
}
