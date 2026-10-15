/**
 * Git and events for Apps: the GIT and EVENTS bindings a host grants an App
 * backend, the git door that lets people and agents push to an App's
 * repositories with ordinary git, and Standard Webhooks signing for events the
 * host delivers. Credentials, remotes and webhook secrets stay in the host;
 * the App sees repository names, git objects and its own events.
 */
import { readPacketLines, pktLine } from "@fungi.computer/agar/git-wire";
import type { GitBinding } from "@fungi.computer/agar/git";
import * as Schema from "effect/Schema";
/** The EVENTS binding: an App emits typed events the host routes. */
export type EventSink = Readonly<{
  /**
   * Emit one event. `payload` is the Standard Webhooks body
   * (type, timestamp, data); `eventId` is stable so redelivery is a no-op.
   */
  emit(
    type: string,
    payload: StandardWebhookPayload,
    eventId: string,
  ): Promise<void>;
}>;

/** The Standard Webhooks payload shape. */
export type StandardWebhookPayload = Readonly<{
  type: string;
  timestamp: string;
  data: Schema.Json;
}>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** The protocol-v2 ls-refs request body. */
export function lsRefsRequest(): Uint8Array {
  return encoder.encode(
    `${pktLine("command=ls-refs\n")}0001${pktLine("ref-prefix refs/\n")}0000`,
  );
}

/** Parse an ls-refs response into refs. */
export function parseLsRefs(
  response: Uint8Array,
): Awaited<ReturnType<GitBinding["refs"]>> {
  const refs: Awaited<ReturnType<GitBinding["refs"]>> = [];
  for (const raw of readPacketLines(response, true)) {
    const [hash = "", name = ""] = decoder
      .decode(raw)
      .replace(/\n$/u, "")
      .split(" ");
    if (/^[0-9a-f]{40}$/u.test(hash) && name.startsWith("refs/"))
      refs.push({ name, hash });
  }
  return refs;
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(message)),
  );
}

/** A `whsec_` secret is base64 key bytes; any other secret is its own UTF-8. */
function secretBytes(secret: string): Uint8Array {
  if (!secret.startsWith("whsec_")) return encoder.encode(secret);
  return Uint8Array.from(atob(secret.slice(6)), (char) => char.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Standard Webhooks `webhook-signature` value for one delivery. */
export async function signStandardWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const signature = await hmac(
    secretBytes(secret),
    `${id}.${String(timestamp)}.${body}`,
  );
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}

/** Headers for one signed delivery: Standard Webhooks plus `X-Hub-Signature-256`. */
export async function webhookHeaders(
  secret: string,
  id: string,
  type: string,
  timestamp: number,
  body: string,
): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "user-agent": "Oyster-Webhooks/1",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signStandardWebhook(secret, id, timestamp, body),
    // The headers receivers built for git hosts check.
    "x-hub-signature-256": `sha256=${hex(await hmac(encoder.encode(secret), body))}`,
    "x-github-delivery": id,
    "x-github-event": type,
  };
}

export { createGitDoor, gitDoorRoute, smartHttpExchange } from "./git-door.js";
export type { GitDoorHost, GitDoorTarget } from "./git-door.js";
export { workflowGitPassPrefix } from "./git-auth.js";
export {
  createAdmittedGit,
  createInstallationGitAdmission,
} from "./git-admission.js";
export type {
  AdmittedGit,
  GitStore,
  GitGrants,
  GitPolicy,
  GitJournal,
} from "./git-admission.js";

export { createGitPushJournal } from "./git-journal.js";
export type { GitPushJournalPorts } from "./git-journal.js";
