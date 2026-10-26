import { createHash } from "node:crypto";
import { Hono } from "hono";
import * as Schema from "effect/Schema";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";
import type { SeamReplayStore } from "@fungi.computer/seam";
import {
  agentMailAddressSchema,
  machineAgentOperationSchema,
  MachineLinkPostUnavailable,
  type MachineAgentOperation,
} from "@fungi.computer/seam/machine-link-protocol";
import type {
  PostDeliveryResult,
  PostEnvelope,
} from "@fungi.computer/carrier/post";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  machineLinkFenceFactSchema,
  machineLinkIdentitySchema,
  machineLinkName,
  MachineLinkRefused,
  type MachineLinkAuthority,
  type MachineLinkCaller,
  type MachineLinkFenceFact,
  type MachineLinkFenceResult,
  type MachineLinkIdentity,
} from "./authority.js";
import { MachineLinkHost } from "./host.js";

const pinKey = "machine-link:identity";

/** The Durable Object state a machine link needs from its host class. */
export type MachineLinkState = Pick<
  DurableObjectState,
  "getWebSockets" | "acceptWebSocket" | "setWebSocketAutoResponse" | "waitUntil"
> &
  Readonly<{
    storage: WatchdogSqliteOwner &
      Pick<DurableObjectStorage, "get" | "put" | "setAlarm">;
  }>;

/** The host's own storage erasure, so readback matches its other owners. */
export type MachineLinkStorageErasure<Readback> = Readonly<{
  erased(): Promise<boolean>;
  erase(): Promise<Readback>;
  read(): Promise<Readback>;
}>;

/**
 * One device's link inside its own Durable Object. The host's DO class
 * delegates every entry point here. Identity is pinned on the first live
 * answer and every act rereads the host's authority; nothing is written
 * before the host says the device is live.
 */
export function createMachineLink<Readback>(
  state: MachineLinkState,
  options: Readonly<{
    authority: Omit<MachineLinkAuthority, "deliverControlFact">;
    /** Whether this DO is the canonical owner for the identity. */
    addressed: (identity: MachineLinkIdentity) => boolean;
    erasure: MachineLinkStorageErasure<Readback>;
    report: (operation: string, cause: unknown) => void;
  }>,
) {
  const { authority } = options;
  let host: MachineLinkHost | undefined;
  let replayStore: Promise<SeamReplayStore> | undefined;

  const openReplayStore = (): Promise<SeamReplayStore> => {
    replayStore ??= import("@fungi.computer/computer").then(
      ({ createLocalBackendReplayStore }) =>
        createLocalBackendReplayStore(state.storage),
    );
    return replayStore;
  };

  const match = (identity: MachineLinkIdentity) => {
    if (!options.addressed(identity))
      throw new MachineLinkRefused("actor_not_allowed");
  };

  const savedIdentity = async () => {
    const raw = await state.storage.get(pinKey);
    return raw === undefined ? null : machineLinkIdentitySchema.parse(raw);
  };

  const current = async (input: MachineLinkIdentity) => {
    const proposed = machineLinkIdentitySchema.parse(input);
    const saved = await savedIdentity();
    if (saved !== null && machineLinkName(saved) !== machineLinkName(proposed))
      throw new MachineLinkRefused("actor_not_allowed");
    const identity = saved ?? proposed;
    match(identity);
    if (await options.erasure.erased())
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    // Pinned address only. Neither a forwarding header nor caller-provided key
    // can lend authority to this link.
    const facts = await authority.admitDevice(identity);
    if (!facts.live) throw new MachineLinkPostUnavailable({ reason: "closed" });
    match(facts);
    if (
      facts.teamId !== identity.teamId ||
      facts.deviceId !== identity.deviceId
    )
      throw new MachineLinkRefused("actor_not_allowed");
    // First product write is after the host's independent live decision.
    if (saved === null) await state.storage.put(pinKey, identity);
    return facts;
  };

  const mail = (envelope: PostEnvelope) => {
    const address = Schema.decodeUnknownSync(agentMailAddressSchema, {
      onExcessProperty: "error",
    })(envelope.address);
    const body = Schema.decodeUnknownSync(BirdDogMailSchema, {
      onExcessProperty: "error",
    })(envelope.event);
    return { address, mail: body };
  };

  /**
   * The link's own sender check, whatever the host answered: the facts must
   * name the caller and actor it saw, a hosted caller must be hosted, and a
   * device caller must be an Agent homed on that live device, same member.
   */
  const checkedTarget = async (
    identity: MachineLinkIdentity,
    caller: MachineLinkCaller,
    agentId: string,
    requesterAgentId: string | null,
  ) => {
    const facts = await authority.resolveTarget(
      identity,
      caller,
      agentId,
      requesterAgentId,
    );
    if (
      facts.teamId !== identity.teamId ||
      facts.callerAgentId !== caller.agentId ||
      facts.targetAgentId !== agentId ||
      facts.actorAgentId !== (requesterAgentId ?? caller.agentId)
    )
      throw new MachineLinkRefused("actor_not_allowed");
    if (caller.kind === "hosted") {
      if (facts.callerHome.kind !== "hosted")
        throw new MachineLinkRefused("actor_not_allowed");
      return facts;
    }
    const source = await authority.admitDevice({
      teamId: identity.teamId,
      deviceId: caller.deviceId,
    });
    if (
      !source.live ||
      source.teamId !== identity.teamId ||
      source.deviceId !== caller.deviceId ||
      facts.callerHome.kind !== "machine" ||
      facts.callerHome.deviceId !== source.deviceId
    )
      throw new MachineLinkRefused("actor_not_allowed");
    return facts;
  };

  const receive = async (
    identity: MachineLinkIdentity,
    envelope: PostEnvelope,
  ): Promise<PostDeliveryResult> => {
    await current(identity);
    if (envelope.kind !== "agentMail") return "refused";
    const { address, mail: body } = mail(envelope);
    const caller: MachineLinkCaller = {
      kind: "device",
      deviceId: identity.deviceId,
      agentId: body.from.agentId,
    };
    const target = await checkedTarget(identity, caller, address.agentId, null);
    if (
      envelope.key !== body.key ||
      address.scopeId !== target.teamId ||
      address.agentId !== body.to.agentId
    )
      return "refused";
    return await authority.deliverHome(identity, caller, target, envelope);
  };

  const hostFor = (input: MachineLinkIdentity) => {
    const identity = { teamId: input.teamId, deviceId: input.deviceId };
    return (host ??= new MachineLinkHost(state, state.storage, {
      teamId: identity.teamId,
      authorize: async (deviceId) => {
        if (deviceId !== identity.deviceId)
          throw new MachineLinkRefused("actor_not_allowed");
        return await current(identity);
      },
      replay: openReplayStore,
      directory: () => authority.directory(identity),
      receive: (_device, envelope) => receive(identity, envelope),
      scheduleWake: (at) => state.storage.setAlarm(at),
      report: options.report,
    }));
  };

  const routes = new Hono().get(
    "/api/teams/:teamId/local/mesh/:deviceId/connect",
    async (context) => {
      const identity = machineLinkIdentitySchema.parse(context.req.param());
      try {
        await current(identity);
        return await hostFor(identity).fetch(context.req.raw);
      } catch {
        return context.body(null, 403);
      }
    },
  );

  const preflightErasure = async (teamId: string, deviceId: string) => {
    const identity = machineLinkIdentitySchema.parse({ teamId, deviceId });
    match(identity);
    if (await options.erasure.erased()) return;
    if (!(await authority.canErase(identity)))
      throw new MachineLinkRefused("actor_not_allowed");
  };

  return {
    fetch: (request: Request): Promise<Response> =>
      Promise.resolve(routes.fetch(request)),

    /** Mail addressed to this device's Agent, rechecked against its home. */
    async deliver(
      input: MachineLinkIdentity,
      caller: MachineLinkCaller,
      agentId: string,
      envelope: PostEnvelope,
    ): Promise<PostDeliveryResult> {
      const device = await current(input);
      if (envelope.kind !== "agentMail") return "refused";
      const { address, mail: body } = mail(envelope);
      const facts = await checkedTarget(device, caller, agentId, null);
      if (
        facts.targetHome.kind !== "machine" ||
        facts.targetHome.deviceId !== device.deviceId ||
        envelope.key !== body.key ||
        address.scopeId !== facts.teamId ||
        address.agentId !== facts.targetAgentId ||
        body.to.agentId !== facts.targetAgentId ||
        body.from.agentId !== facts.callerAgentId
      )
        return "refused";
      return await hostFor(device).deliver(device.deviceId, envelope);
    },

    /** One finite Agent operation on this device, returning its receipt. */
    async operation(
      input: MachineLinkIdentity,
      caller: MachineLinkCaller,
      agentId: string,
      raw: MachineAgentOperation,
    ) {
      const device = await current(input);
      const operation = Schema.decodeUnknownSync(machineAgentOperationSchema, {
        onExcessProperty: "error",
      })(raw);
      const facts = await checkedTarget(
        device,
        caller,
        agentId,
        operation.type === "settlement" ? operation.requesterAgentId : null,
      );
      if (
        facts.targetHome.kind !== "machine" ||
        facts.targetHome.deviceId !== device.deviceId
      )
        throw new MachineLinkRefused("actor_not_allowed");
      const key = createHash("sha256")
        .update(
          JSON.stringify([facts.callerAgentId, facts.targetAgentId, operation]),
        )
        .digest("hex");
      const result = await hostFor(device).deliver(device.deviceId, {
        key,
        kind: "machineAgent",
        address: { scopeId: facts.teamId, agentId: facts.targetAgentId },
        event: { actorAgentId: facts.actorAgentId, operation },
      });
      if (
        result === "accepted" ||
        result === "duplicate" ||
        result === "refused" ||
        !("receipt" in result) ||
        result.status === "refused"
      )
        throw new MachineLinkRefused("unavailable");
      return result.receipt;
    },

    /**
     * Apply one committed fence fact pushed by the host's producer. The fact
     * is the push; the link does not read authority back here. Sockets at an
     * older epoch close, and a not-live fact closes the current one too. The
     * per-frame live read remains the guarantee.
     */
    applyFence(raw: MachineLinkFenceFact): MachineLinkFenceResult {
      const fact = machineLinkFenceFactSchema.parse(raw);
      match(fact);
      hostFor(fact).fence(fact.fenceEpoch, fact.live);
      return { kind: "confirmed", fenceEpoch: fact.fenceEpoch };
    },

    preflightErasure,

    async eraseForTeam(teamId: string, deviceId: string) {
      await preflightErasure(teamId, deviceId);
      hostFor({ teamId, deviceId }).retireForErasure();
      return await options.erasure.erase();
    },

    readErasure: () => options.erasure.read(),

    /** Carrier terminal rows, including expired custody, remain observable for S9. */
    async deadLetters(input: MachineLinkIdentity, afterKey?: string) {
      const device = await current(input);
      return await hostFor(device).deadLetters(afterKey);
    },

    /** Reconcile durable Carrier custody after a DO alarm or physical restart. */
    async alarm() {
      const identity = await savedIdentity();
      if (identity !== null) await hostFor(identity).alarm();
    },

    async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
      const identity = await savedIdentity();
      if (identity === null) {
        socket.close(4003, "identity unavailable");
        return;
      }
      await hostFor(identity).message(socket, message);
    },

    webSocketClose(socket: WebSocket, code: number, reason: string) {
      host?.close(socket);
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    },

    webSocketError(socket: WebSocket) {
      host?.close(socket);
      socket.close(1011, "machine link error");
    },
  };
}

export type MachineLink = ReturnType<typeof createMachineLink>;
