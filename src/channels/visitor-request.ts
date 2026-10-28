import { z } from "zod";
import { FungiMessageMetaSchema } from "@fungi.computer/agar/agents";
import { channelIds } from "./ids.js";

/** The original caller key, carried separately from channel and owner identities. */
export const visitorRequestSchema = z.strictObject({
  requestId: FungiMessageMetaSchema.shape.sourceRequestId.unwrap(),
});

/** Native hashing keeps the existing channel identity; it is never an inverse correlation. */
export async function visitorMessageId(requestId: string): Promise<string> {
  const input = visitorRequestSchema.parse({ requestId });
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input.requestId),
  );
  const suffix = BigInt(
    `0x${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  )
    .toString(36)
    .padStart(21, "0")
    .slice(0, 21);
  return channelIds.message.schema.parse(`msg_${suffix}`);
}
