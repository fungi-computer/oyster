import * as Schema from "effect/Schema";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";
import type { BirdDogMail } from "@fungi.computer/bird-dog";
import { agentMailAddressSchema } from "@fungi.computer/seam/machine-link-protocol";
import type { PostEnvelope } from "@fungi.computer/carrier/post";
import type { MachineLinkIdentity } from "./authority.js";

export type MachineLinkDispositionMail = Readonly<{
  key: string;
  kind: "agentMail";
  address: Schema.Schema.Type<typeof agentMailAddressSchema>;
  event: BirdDogMail;
}>;

const machineMailEnvelope = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literal("agentMail"),
  address: agentMailAddressSchema,
  event: BirdDogMailSchema,
});

type CheckedDisposition = Readonly<{
  original: Schema.Schema.Type<typeof machineMailEnvelope>;
  reply: Schema.Schema.Type<typeof machineMailEnvelope>;
}>;

function originalMatchesLink(
  identity: MachineLinkIdentity,
  original: CheckedDisposition["original"],
): boolean {
  const sentFrom = original.event.from;
  if (sentFrom.kind !== "agent") return false;
  return (
    original.key === original.event.key &&
    original.address.scopeId === identity.teamId &&
    original.address.agentId === original.event.to.agentId &&
    original.event.reply === undefined
  );
}

function reverseIdentityMatches(
  original: CheckedDisposition["original"],
  reply: CheckedDisposition["reply"],
): boolean {
  const sentFrom = original.event.from;
  if (sentFrom.kind !== "agent") return false;
  return (
    reply.event.from.kind === "system" &&
    reply.event.to.agentId === sentFrom.agentId &&
    reply.event.to.sessionId === sentFrom.sessionId
  );
}

function replyMatchesDisposition(
  identity: MachineLinkIdentity,
  original: CheckedDisposition["original"],
  reply: CheckedDisposition["reply"],
): boolean {
  const sent = original.event;
  const returned = reply.event;
  if (sent.from.kind !== "agent") return false;
  const senderAgentId = sent.from.agentId;
  const expectedKey = `${original.key}:reply:0`;
  return [
    reply.key === expectedKey,
    returned.key === reply.key,
    reply.address.scopeId === identity.teamId,
    reply.address.agentId === senderAgentId,
    returned.replyTo.length === 0,
    returned.reply?.outcome === "undeliverable",
    returned.reply?.outcome === "undeliverable" &&
      returned.reply.reason === "recipient_offline",
    reverseIdentityMatches(original, reply),
  ].every((valid) => valid);
}

/** Parse and authenticate the only terminal reply a device relay may author. */
export function machineLinkDisposition(
  identity: MachineLinkIdentity,
  rawOriginal: PostEnvelope,
  rawReply: PostEnvelope,
):
  | Readonly<{
      original: MachineLinkDispositionMail;
      reply: MachineLinkDispositionMail;
    }>
  | undefined {
  let original: CheckedDisposition["original"];
  let reply: CheckedDisposition["reply"];
  try {
    original = Schema.decodeUnknownSync(machineMailEnvelope, {
      onExcessProperty: "error",
    })(rawOriginal);
    reply = Schema.decodeUnknownSync(machineMailEnvelope, {
      onExcessProperty: "error",
    })(rawReply);
  } catch {
    return undefined;
  }
  if (
    !originalMatchesLink(identity, original) ||
    !replyMatchesDisposition(identity, original, reply)
  )
    return undefined;
  return { original, reply };
}
