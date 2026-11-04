import { z } from "zod";
import type { AuthenticatedChannelVisitor } from "../channels/visitor-channel.js";
import type { EdgeVerifiedVisitor } from "../channels/visitor-edge.js";

/** An internal, short-lived assertion, not the visitor's bearer. The Worker
 * and its Agent owner receive the same host secret; no public route reads it.
 * This is required because a TypeScript brand disappears over DO RPC. */
const proofSchema = z.strictObject({
  visitorId: z.string().min(1).max(160),
  addressHash: z.string().min(1).max(160),
  bindingId: z.string().min(1).max(160),
  expiresAt: z.number().int().nonnegative(),
  signature: z.base64url().length(43),
});
export type ProvenVisitor = AuthenticatedChannelVisitor &
  Readonly<{ edgeProof: z.infer<typeof proofSchema> }>;

const encoder = new TextEncoder();
const maxAge = 30_000;
const input = (proof: Omit<z.infer<typeof proofSchema>, "signature">) =>
  JSON.stringify([
    "oyster:website-visitor:v1",
    proof.bindingId,
    proof.visitorId,
    proof.addressHash,
    proof.expiresAt,
  ]);

async function keyFor(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).length < 32)
    throw new Error("Website channel proof key is unavailable");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The edge calls this only after the central visitor owner authenticated
 * this request. Neither bearer nor proof key crosses to the public client. */
export async function proveVisitor(
  bindingId: string,
  visitor: EdgeVerifiedVisitor<AuthenticatedChannelVisitor>,
  secret: string,
  now = Date.now(),
): Promise<ProvenVisitor> {
  const fields = {
    bindingId,
    visitorId: visitor.visitorId,
    addressHash: visitor.addressHash,
    expiresAt: now + maxAge,
  };
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await keyFor(secret),
      encoder.encode(input(fields)),
    ),
  );
  const signature = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return { ...visitor, edgeProof: { ...fields, signature } };
}

/** Every public Agent RPC must verify before accessing a conversation or
 * running a model. A forged or stale identity cannot cross the DO boundary. */
export async function verifyVisitor(
  bindingId: string,
  value: unknown,
  secret: string | null,
  now = Date.now(),
): Promise<ProvenVisitor> {
  const visitor = z
    .strictObject({
      visitorId: z.string().min(1).max(160),
      addressHash: z.string().min(1).max(160),
      expiresAt: z.number().int().nonnegative(),
      edgeProof: proofSchema,
    })
    .safeParse(value);
  if (
    !visitor.success ||
    secret === null ||
    visitor.data.edgeProof.bindingId !== bindingId ||
    visitor.data.edgeProof.visitorId !== visitor.data.visitorId ||
    visitor.data.edgeProof.addressHash !== visitor.data.addressHash ||
    visitor.data.expiresAt < now ||
    visitor.data.edgeProof.expiresAt < now ||
    visitor.data.edgeProof.expiresAt > now + maxAge
  )
    throw new Error("Website channel identity is unauthorized");
  const { signature, ...fields } = visitor.data.edgeProof;
  const bytes = Uint8Array.from(
    atob(signature.replaceAll("-", "+").replaceAll("_", "/") + "="),
    (char) => char.charCodeAt(0),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await keyFor(secret),
      bytes,
      encoder.encode(input(fields)),
    ))
  )
    throw new Error("Website channel identity is unauthorized");
  return visitor.data;
}
