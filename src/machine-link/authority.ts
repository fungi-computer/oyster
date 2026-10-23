import { z } from "zod";
import type {
  PostDeliveryResult,
  PostEnvelope,
} from "@fungi.computer/carrier/post";
import type { MachineAgentHome } from "./home.js";

const id = z.string().min(1).max(256);
export const machineLinkIdentitySchema = z.strictObject({
  teamId: id,
  deviceId: id,
});
export type MachineLinkIdentity = z.infer<typeof machineLinkIdentitySchema>;

/** One canonical device owner, not a Team's socket collection. */
export function machineLinkName(identity: MachineLinkIdentity): string {
  return JSON.stringify(
    machineLinkIdentitySchema.parse({
      teamId: identity.teamId,
      deviceId: identity.deviceId,
    }),
  );
}

/** One device's live authority, as the host answers it for one act. */
export type MachineLinkDeviceFacts =
  | Readonly<{ live: false }>
  | Readonly<
      MachineLinkIdentity & {
        live: true;
        memberId: string;
        publicKey: string;
        fenceEpoch: number;
      }
    >;

/** Retained authority, including a revoked device's last committed fence. */
export type MachineLinkFenceFact = Readonly<
  MachineLinkIdentity & {
    live: boolean;
    fenceEpoch: number;
  }
>;

export const machineLinkFenceResultSchema = z.strictObject({
  kind: z.enum(["confirmed", "unconfirmed"]),
  fenceEpoch: z.int().nonnegative(),
});
export type MachineLinkFenceResult = z.infer<
  typeof machineLinkFenceResultSchema
>;

/** Device identity comes from the forwarding link's pin, never the mail body. */
export const machineLinkCallerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hosted"), agentId: id }),
  z.strictObject({ kind: z.literal("device"), deviceId: id, agentId: id }),
]);
export type MachineLinkCaller = z.infer<typeof machineLinkCallerSchema>;

export const machineLinkFenceFactSchema = z.strictObject({
  teamId: id,
  deviceId: id,
  live: z.boolean(),
  fenceEpoch: z.int().nonnegative(),
});

/** The host's current facts for one addressed operation or mail. */
export type MachineLinkTargetFacts = Readonly<{
  teamId: string;
  callerAgentId: string;
  targetAgentId: string;
  /** The Agent the target acts for: the settlement requester, or the caller. */
  actorAgentId: string;
  /** The caller's own home; the link checks it against the caller it saw. */
  callerHome: MachineAgentHome;
  targetHome: MachineAgentHome;
}>;

/**
 * Everything a machine link asks its host. Every method is a fresh live read
 * for one dial, frame, delivery or operation; the link never caches an answer.
 * The Hub answers through its Team control boundary, a standalone Oyster
 * through its owner's key and grants.
 */
export type MachineLinkAuthority = Readonly<{
  /** Device present and unrevoked, owner/member live, current key and epoch. */
  admitDevice(id: MachineLinkIdentity): Promise<MachineLinkDeviceFacts>;
  /** Retained fence facts, including a revoked device; null for an unknown one. */
  currentFence(id: MachineLinkIdentity): Promise<MachineLinkFenceFact | null>;
  /** Public Agent entries this device may see. */
  directory(
    id: MachineLinkIdentity,
  ): Promise<readonly { agentId: string; name: string }[]>;
  /** Sender, actor and the target's actual home, rechecked for this act. */
  resolveTarget(
    id: MachineLinkIdentity,
    caller: MachineLinkCaller,
    agentId: string,
    requesterAgentId: string | null,
  ): Promise<MachineLinkTargetFacts>;
  /** Carry mail received from this device to its target's actual home. */
  deliverHome(
    id: MachineLinkIdentity,
    caller: MachineLinkCaller,
    target: MachineLinkTargetFacts,
    envelope: PostEnvelope,
  ): Promise<PostDeliveryResult>;
  /** Whether this link's replay ledger may be erased now. */
  canErase(id: MachineLinkIdentity): Promise<boolean>;
  /** Push one committed fence fact to the device's link (C2 promptness). */
  deliverControlFact(
    fact: MachineLinkFenceFact,
  ): Promise<MachineLinkFenceResult>;
}>;

/** A link refusal, decoded by the host into its own error vocabulary. */
export class MachineLinkRefused extends Error {
  constructor(readonly reason: "actor_not_allowed" | "unavailable") {
    super(`machine-link:${reason}`);
    this.name = "MachineLinkRefused";
  }
}
