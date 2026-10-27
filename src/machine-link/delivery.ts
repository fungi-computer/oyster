import * as Schema from "effect/Schema";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";
import {
  PostEnvelopeSchema,
  PostDeliveryResultSchema,
  type PostEnvelope,
  type PostDeliveryResult,
  type PostRoute,
} from "@fungi.computer/carrier/post";
import { agentMailAddressSchema } from "@fungi.computer/seam/machine-link-protocol";
import { decodeMachineAgentHome, type MachineAgentHome } from "./home.js";
import type { MachineLinkIdentity } from "./authority.js";
import type { MachineLinkDispositionMail } from "./disposition.js";

/**
 * Home selection only, as the namespace under the host's disclosure-owning
 * Agent mail route. Carrier retains retries; the receiving Agent admits work.
 */
export function createHomeAwareAgentMailNamespace(options: {
  sender: Readonly<{ teamId: string; agentId: string }>;
  home: (agentId: string) => Promise<MachineAgentHome | null>;
  hosted: PostRoute<never, never>["namespace"];
  machine: (
    deviceId: string,
    envelope: PostEnvelope,
  ) => Promise<PostDeliveryResult>;
  /** Host's Agent grammar: validates Accepted or Held without conflating them. */
  accepted: (receipt: Schema.Json) => void;
}): PostRoute<never, never>["namespace"] {
  return {
    getByName: (agentId) => ({
      deliver: async (raw) => {
        if (
          new TextEncoder().encode(JSON.stringify(raw)).byteLength >
          512 * 1024
        )
          return "refused";
        const envelope = Schema.decodeUnknownSync(PostEnvelopeSchema, {
          onExcessProperty: "error",
        })(raw);
        const address = Schema.decodeUnknownSync(agentMailAddressSchema, {
          onExcessProperty: "error",
        })(envelope.address);
        const mail = Schema.decodeUnknownSync(BirdDogMailSchema, {
          onExcessProperty: "error",
        })(envelope.event);
        const senderMatches =
          mail.from.kind === "agent" &&
          mail.from.agentId === options.sender.agentId;
        const systemOfflineDisposition =
          mail.from.kind === "system" &&
          mail.reply?.outcome === "undeliverable" &&
          mail.reply.reason === "recipient_offline";
        if (
          envelope.kind !== "agentMail" ||
          envelope.key !== mail.key ||
          address.scopeId !== options.sender.teamId ||
          address.agentId !== agentId ||
          mail.to.agentId !== agentId ||
          (!senderMatches && !systemOfflineDisposition)
        )
          return "refused";
        const projected = await options.home(agentId);
        if (projected === null) return "refused";
        const home = decodeMachineAgentHome(projected);
        // Unavailable machine transport must throw for Carrier retry, never
        // fall back to a hosted Agent or manufacture a custody/command receipt.
        const result = Schema.decodeUnknownSync(PostDeliveryResultSchema)(
          await (home.kind === "hosted"
            ? options.hosted.getByName(agentId).deliver(envelope)
            : options.machine(home.deviceId, envelope)),
        );
        if (result === "refused") return result;
        if (
          result === "accepted" ||
          result === "duplicate" ||
          !("receipt" in result)
        )
          throw new Error(
            "Agent mail acknowledgment lacks a valid acceptance or Held receipt",
          );
        if (result.status !== "refused") options.accepted(result.receipt);
        return result;
      },
    }),
  };
}

/** Route one checked expiry reply through the same home-aware mail owner. */
export function deliverUndeliverableMail(options: {
  identity: MachineLinkIdentity;
  original: MachineLinkDispositionMail;
  reply: MachineLinkDispositionMail;
  senderHome: MachineAgentHome;
  hosted: PostRoute<never, never>["namespace"];
  machine: (
    deviceId: string,
    envelope: PostEnvelope,
  ) => Promise<PostDeliveryResult>;
  accepted: (receipt: Schema.Json) => void;
}): Promise<PostDeliveryResult> {
  const sent = options.original.event;
  if (sent.from.kind !== "agent") return Promise.resolve("refused");
  const senderAgentId = sent.from.agentId;
  return createHomeAwareAgentMailNamespace({
    sender: { teamId: options.identity.teamId, agentId: sent.to.agentId },
    home: (agentId) =>
      Promise.resolve(agentId === senderAgentId ? options.senderHome : null),
    hosted: options.hosted,
    machine: options.machine,
    accepted: options.accepted,
  })
    .getByName(senderAgentId)
    .deliver(options.reply);
}
