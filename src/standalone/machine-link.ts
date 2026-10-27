import {
  machineAgentCodecs,
  machineAgentReservations,
} from "@fungi.computer/shiitake/delegation";
import {
  createMachineEnrollment,
  MachineEnrollmentRefused,
  MachineLinkRefused,
  type MachineEnrollment,
  type MachineLinkDeviceFacts,
  type MachineLinkIdentity,
  type MachineLinkFenceFact,
  type MachineLinkCaller,
  type MachineLinkTargetFacts,
  type MachineAgentHome,
} from "../machine-link/index.js";
import {
  keyAllowsMachineEnroll,
  type LiveOysterKey,
  type OysterKeyStore,
} from "../keys.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  agentIds,
  createAgentDirectory,
  type AgentGrant,
} from "@fungi.computer/shiitake/fleet";
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import {
  machineEnrollmentSchema,
  machineLinkName,
  type MachineLinkAuthority,
  type MachineLinkFenceResult,
} from "../machine-link/index.js";
import { createMachineLink } from "../machine-link/workers.js";
import { deliverUndeliverableMail } from "../machine-link/delivery.js";
import type {
  PostEnvelope,
  PostDeliveryResult,
} from "@fungi.computer/carrier/post";
import type { MachineAgentOperation } from "@fungi.computer/seam/machine-link-protocol";
import { defaultTenant, tenantScope, type TenantScope } from "../tenant.js";
import { presentedGitKey } from "../git-auth.js";
import { standaloneTenancy, type StandaloneTenancyEnv } from "./tenancy.js";
import type { StandaloneAgentsEnv, AgentDirectory } from "./agents.js";

/** Standalone's fresh directory projection for the shared hosted client. */
export function standaloneMachineAgentHome(options: {
  identity(): Readonly<{ teamId: string; agentId: string }> | null;
  directory: {
    getByName(
      name: string,
    ): Pick<AgentDirectory, "agentHome" | "machineTarget">;
  };
}) {
  return async (agentId: string): Promise<MachineAgentHome> => {
    const actor = options.identity();
    if (actor === null) throw new MachineLinkRefused("actor_not_allowed");
    const directory = options.directory.getByName(actor.teamId);
    const home = await directory.agentHome(agentId);
    if (home === null) throw new MachineLinkRefused("actor_not_allowed");
    if (home.kind === "hosted") return home;
    // Admit the source and live device before the client addresses its link.
    return (
      await directory.machineTarget(
        { kind: "hosted", agentId: actor.agentId },
        agentId,
        null,
      )
    ).targetHome;
  };
}

export type StandaloneMachineLinkBindings = Readonly<{
  MACHINE_LINK: DurableObjectNamespace<MachineLinkDO>;
}>;
/** Everything the standalone machine link reads from its Worker. */
export type StandaloneMachineLinkEnv = StandaloneTenancyEnv &
  Pick<StandaloneAgentsEnv, "AGENTS" | "AGENT_DIRECTORY"> &
  StandaloneMachineLinkBindings;

export type StandaloneMachineJoinResult =
  | Readonly<{
      kind: "refused";
      error:
        "not_allowed" | "request_conflict" | "capacity" | "invalid_enrollment";
    }>
  | Readonly<{
      kind: "enrolled";
      value: Awaited<
        ReturnType<ReturnType<typeof createMachineEnrollment>["enroll"]>
      >;
    }>;

/** Machine-link teamId is the existing owner's Agent directory scope. */
const scopeFor = (env: Pick<StandaloneMachineLinkEnv, "OYSTER_ORIGIN">) =>
  tenantScope(defaultTenant, env.OYSTER_ORIGIN);

async function liveOwner(env: StandaloneMachineLinkEnv) {
  const tenant = await env.TENANTS.getByName("registry").get(defaultTenant);
  // A mesh request cannot provision a missing owner scope or cold-start
  // tenancy's seed path while that scope is held inactive.
  if (tenant?.status !== "active") return null;
  return (await standaloneTenancy(env)).owner();
}

/** Fresh host authority; no answer is retained by the adapter or the link. */
export function standaloneMachineLinkAuthority(
  env: StandaloneMachineLinkEnv,
): MachineLinkAuthority {
  const scope = scopeFor(env);
  const teamId = scope.durableName("agents");
  const directory = () => env.AGENT_DIRECTORY.getByName(teamId);
  const authority: MachineLinkAuthority = {
    admitDevice: async (id) => {
      if (id.teamId !== teamId || (await liveOwner(env)) === null)
        return { live: false };
      return directory().machineDevice(id);
    },
    currentFence: async (id) =>
      id.teamId !== teamId ? null : directory().machineFence(id),
    agentHome: async (id, agentId) =>
      id.teamId !== teamId ? null : directory().agentHome(agentId),
    directory: async (id) => {
      if (!(await authority.admitDevice(id)).live)
        throw new MachineLinkRefused("actor_not_allowed");
      return directory().machineDirectory(id);
    },
    resolveTarget: async (id, caller, agentId, requester) => {
      if (!(await authority.admitDevice(id)).live)
        throw new MachineLinkRefused("actor_not_allowed");
      return directory().machineTarget(caller, agentId, requester);
    },
    deliverHome: async (id, caller, target, envelope) => {
      // The projection used to prepare this delivery lends no later authority.
      const facts = await authority.resolveTarget(
        id,
        caller,
        target.targetAgentId,
        null,
      );
      if (facts.targetHome.kind === "hosted")
        return env.AGENTS.getByName(facts.targetAgentId).deliver(envelope);
      const next = { teamId, deviceId: facts.targetHome.deviceId };
      if (!(await authority.admitDevice(next)).live)
        throw new MachineLinkRefused("actor_not_allowed");
      return env.MACHINE_LINK.getByName(machineLinkName(next)).deliver(
        next,
        caller,
        facts.targetAgentId,
        envelope,
      );
    },
    deliverUndeliverable: async (id, original, reply) => {
      if ((await authority.currentFence(id)) === null) return "refused";
      const mail = original.event;
      if (mail.from.kind !== "agent") return "refused";
      const home = await authority.agentHome(id, mail.from.agentId);
      if (home === null) throw new MachineLinkRefused("unavailable");
      return await deliverUndeliverableMail({
        identity: id,
        original,
        reply,
        senderHome: home,
        hosted: env.AGENTS,
        accepted: machineAgentCodecs.accepted,
        machine: async (deviceId, envelope) => {
          const destination = { teamId, deviceId };
          return await env.MACHINE_LINK.getByName(
            machineLinkName(destination),
          ).deliverRelayDisposition(destination, id, original, envelope);
        },
      });
    },
    verifyRelayDisposition: async (relay, original, reply) => {
      return await env.MACHINE_LINK.getByName(
        machineLinkName(relay),
      ).hasStagedDisposition(relay, original, reply);
    },
    canErase: async (id) => {
      if (id.teamId !== teamId) return false;
      const tenant = await env.TENANTS.getByName("registry").get(defaultTenant);
      // Losing a login or a failed owner read is not erasure permission.
      // Like the Hub: the owner scope is held inactive AND the device key is
      // irreversibly retired in its retained enrollment owner.
      return (
        tenant !== null &&
        tenant.origin === scope.origin &&
        (tenant.status === "suspended" || tenant.status === "deleting") &&
        (await directory().machineKeyRetired(id.deviceId))
      );
    },
    deliverControlFact: async (fact) => {
      const tenant = await env.TENANTS.getByName("registry").get(defaultTenant);
      if (
        fact.teamId !== teamId ||
        tenant?.origin !== scope.origin ||
        (await authority.currentFence(fact)) === null
      )
        throw new MachineLinkRefused("actor_not_allowed");
      return env.MACHINE_LINK.getByName(machineLinkName(fact)).applyFence(fact);
    },
  };
  return authority;
}

/** HTTP enrollment over the existing live KEYS and directory owners. */
export function standaloneMachineJoinRoutes(options: {
  scope: TenantScope;
  ownerId: () => Promise<string | null>;
  keys: () => Pick<OysterKeyStore, "verify"> & {
    live(keyId: string): Promise<LiveOysterKey | null>;
  };
  enroll(
    keyId: string,
    input: MachineEnrollment,
  ): Promise<StandaloneMachineJoinResult>;
}) {
  const { scope } = options;
  const teamId = scope.durableName("agents");
  return new Hono().post(
    "/local/mesh/join",
    bodyLimit({ maxSize: 512 * 1024 }),
    validator("json", (value, context) => {
      const parsed = machineEnrollmentSchema.safeParse(value);
      return parsed.success
        ? parsed.data
        : context.json({ error: "invalid_enrollment" }, 400);
    }),
    async (context) => {
      if (new URL(context.req.url).origin !== scope.origin)
        return context.body(null, 403);
      const ownerId = await options.ownerId();
      if (ownerId === null) return context.body(null, 403);
      const presented = presentedGitKey(context.req.raw);
      if (presented.kind !== "key") return context.body(null, 401);
      const keys = options.keys();
      const verified = await keys.verify(presented.value);
      if (verified.kind !== "ok") return context.body(null, 401);
      const live = await keys.live(verified.value.keyId);
      if (live?.owner !== ownerId || !keyAllowsMachineEnroll(live))
        return context.body(null, 403);
      const joined = await options.enroll(
        live.keyId,
        context.req.valid("json"),
      );
      // Domain refusals cross RPC as data, not an instanceof claim about a
      // platform-reconstructed Error.
      if (joined.kind === "refused") {
        if (joined.error === "request_conflict" || joined.error === "capacity")
          return context.json({ error: joined.error }, 409);
        if (joined.error === "invalid_enrollment")
          return context.json({ error: "invalid_enrollment" }, 400);
        return context.body(null, 403);
      }
      return context.json(
        { kind: "joined", scopeId: teamId, ...joined.value },
        200,
      );
    },
  );
}

/** Only join accepts an oyk credential; every subsequent dial uses Seam. */
export function standaloneMachineLinkRoutes(env: StandaloneMachineLinkEnv) {
  const scope = scopeFor(env);
  const teamId = scope.durableName("agents");
  return standaloneMachineJoinRoutes({
    scope,
    ownerId: async () => (await liveOwner(env))?.actor.memberId ?? null,
    keys: () => env.KEYS.getByName(scope.durableName("keys")),
    enroll: (keyId, input) =>
      env.AGENT_DIRECTORY.getByName(teamId).enrollMachine(keyId, input),
  }).get("/api/teams/:teamId/local/mesh/:deviceId/connect", async (context) => {
    const id = {
      teamId: context.req.param("teamId"),
      deviceId: context.req.param("deviceId"),
    };
    if (
      new URL(context.req.url).origin !== scope.origin ||
      id.teamId !== teamId ||
      !(await standaloneMachineLinkAuthority(env).admitDevice(id)).live
    )
      return context.body(null, 403);
    // F1: never address an unknown scope/device, even for a refused dial.
    // The shared link independently rereads admission and verifies Seam.
    return env.MACHINE_LINK.getByName(machineLinkName(id)).fetch(
      context.req.raw,
    );
  });
}

const erasedKey = "machine-link:erased";

/** One device's link; directory, credentials and owner state remain elsewhere. */
export class MachineLinkDO extends DurableObject<StandaloneMachineLinkEnv> {
  private readonly link = createMachineLink(this.ctx, {
    authority: standaloneMachineLinkAuthority(this.env),
    addressed: (identity) =>
      this.ctx.id.equals(
        this.env.MACHINE_LINK.idFromName(machineLinkName(identity)),
      ),
    erasure: {
      erased: async () => (await this.ctx.storage.get(erasedKey)) === true,
      read: async () => ({
        erased: (await this.ctx.storage.get(erasedKey)) === true,
      }),
      erase: async () => {
        // Only this retired device's socket/replay owner, never an Agent,
        // directory or KEYS store. The shared factory checks canErase first.
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.put(erasedKey, true);
        return { erased: true };
      },
    },
    report: (operation, cause) => {
      console.error(operation, cause);
    },
  });

  override alarm() {
    return this.link.alarm();
  }

  override fetch(request: Request) {
    return this.link.fetch(request);
  }

  deliver(
    id: MachineLinkIdentity,
    caller: MachineLinkCaller,
    agentId: string,
    envelope: PostEnvelope,
  ): Promise<PostDeliveryResult> {
    return this.link.deliver(id, caller, agentId, envelope);
  }

  deliverRelayDisposition(
    id: MachineLinkIdentity,
    relay: MachineLinkIdentity,
    original: PostEnvelope,
    reply: PostEnvelope,
  ): Promise<PostDeliveryResult> {
    return this.link.deliverRelayDisposition(id, relay, original, reply);
  }

  hasStagedDisposition(
    id: MachineLinkIdentity,
    original: PostEnvelope,
    reply: PostEnvelope,
  ): Promise<boolean> {
    return this.link.hasStagedDisposition(id, original, reply);
  }

  operation(
    id: MachineLinkIdentity,
    caller: MachineLinkCaller,
    agentId: string,
    operation: MachineAgentOperation,
  ) {
    return this.link.operation(id, caller, agentId, operation);
  }

  applyFence(fact: MachineLinkFenceFact): Promise<MachineLinkFenceResult> {
    return Promise.resolve(this.link.applyFence(fact));
  }

  preflightErasure(teamId: string, deviceId: string) {
    return this.link.preflightErasure(teamId, deviceId);
  }

  eraseForTeam(teamId: string, deviceId: string) {
    return this.link.eraseForTeam(teamId, deviceId);
  }

  readErasure() {
    return this.link.readErasure();
  }

  deadLetters(id: MachineLinkIdentity, afterKey?: string) {
    return this.link.deadLetters(id, afterKey);
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return this.link.webSocketMessage(socket, message);
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.link.webSocketClose(socket, code, reason);
  }

  override webSocketError(socket: WebSocket) {
    this.link.webSocketError(socket);
  }
}

/** Enrollment and the ordinary directory share this one SQLite owner. */
export function createStandaloneMachineEnrollment(options: {
  owner: WatchdogSqliteOwner;
  scopeId: string;
  ownerId: () => Promise<string | null>;
  liveKey: (keyId: string) => Promise<LiveOysterKey | null>;
  onAgentCreated: (agentId: string) => void;
}) {
  options.owner.sql.exec(
    "CREATE TABLE IF NOT EXISTS standalone_machine_enroll_keys (key_id TEXT PRIMARY KEY, request_id TEXT NOT NULL) STRICT",
  );
  const configured = {
    // Retained host's private storage/representation ceilings, not plan quotas.
    limits: { machines: 256, agentsPerMachine: 256 },
    authorizeMember: async (memberId: string) => {
      if ((await options.ownerId()) !== memberId)
        throw new MachineLinkRefused("actor_not_allowed");
    },
    // Enrollment keys buy identity once; they are not ongoing device credentials.
    authorizeLogin: async ({ memberId }: { memberId: string }) =>
      (await options.ownerId()) === memberId,
    onAgentCreated: options.onAgentCreated,
    agents: machineAgentReservations,
  };
  const enrollment = createMachineEnrollment({
    ...configured,
    owner: options.owner,
  });
  // A view of the ordinary directory in this same store, not another catalog.
  const directory = createAgentDirectory(options.owner.sql);
  const grant = (memberId: string): AgentGrant => ({
    agents: "all",
    actions: ["read"],
    expiresAt: Date.now() + 60_000,
    provenance: { actor: memberId },
  });
  const owner = async () => {
    const memberId = await options.ownerId();
    if (memberId === null) throw new MachineLinkRefused("actor_not_allowed");
    return memberId;
  };
  const admitDevice = async (
    id: MachineLinkIdentity,
  ): Promise<MachineLinkDeviceFacts> => {
    if (id.teamId !== options.scopeId || (await options.ownerId()) === null)
      return { live: false };
    try {
      const device = await enrollment.authorizeDevice(id.deviceId);
      return {
        live: true,
        teamId: options.scopeId,
        deviceId: device.deviceId,
        memberId: device.memberId,
        publicKey: device.publicKey,
        fenceEpoch: device.fenceEpoch,
      };
    } catch (cause) {
      if (
        cause instanceof MachineEnrollmentRefused ||
        cause instanceof MachineLinkRefused
      )
        return { live: false };
      throw cause;
    }
  };
  const currentFence = async (
    id: MachineLinkIdentity,
  ): Promise<MachineLinkFenceFact | null> => {
    if (id.teamId !== options.scopeId) return null;
    const memberId = await options.ownerId();
    const device = enrollment
      .retainedDevices()
      .find((row) => row.deviceId === id.deviceId);
    return device === undefined
      ? null
      : {
          ...id,
          fenceEpoch: device.fenceEpoch,
          live: memberId === device.memberId && !device.revoked,
        };
  };
  const target = async (
    caller: MachineLinkCaller,
    agentId: string,
    requester: string | null,
  ): Promise<MachineLinkTargetFacts> => {
    const memberId = await owner();
    const exists = (id: string) => {
      const parsed = agentIds.agent.parse(id);
      return (
        parsed.ok && directory.read(grant(memberId), parsed.value) !== null
      );
    };
    if (
      !exists(caller.agentId) ||
      !exists(agentId) ||
      (requester !== null &&
        (!exists(requester) ||
          (caller.agentId !== agentId && caller.agentId !== requester)))
    )
      throw new MachineLinkRefused("actor_not_allowed");
    const source = enrollment.home(caller.agentId);
    if (
      caller.kind === "device"
        ? source?.kind !== "machine" || source.deviceId !== caller.deviceId
        : source !== null
    )
      throw new MachineLinkRefused("actor_not_allowed");
    if (source?.kind === "machine")
      await enrollment.authorizeDevice(source.deviceId);
    const targetHome: MachineAgentHome = enrollment.home(agentId) ?? {
      kind: "hosted",
    };
    if (targetHome.kind === "machine")
      await enrollment.authorizeDevice(targetHome.deviceId);
    return {
      teamId: options.scopeId,
      callerAgentId: caller.agentId,
      targetAgentId: agentId,
      actorAgentId: requester ?? caller.agentId,
      callerHome: source ?? { kind: "hosted" },
      targetHome,
    };
  };
  return {
    ...enrollment,
    admitDevice,
    currentFence,
    target,
    async publicDirectory(id: MachineLinkIdentity) {
      if (!(await admitDevice(id)).live)
        throw new MachineLinkRefused("actor_not_allowed");
      const memberId = await owner();
      return directory
        .list(grant(memberId))
        .map(({ agentId, name }) => ({ agentId, name }));
    },
    async enrollWithKey(keyId: string, input: MachineEnrollment) {
      const memberId = await options.ownerId();
      const key = await options.liveKey(keyId);
      if (
        memberId === null ||
        key?.owner !== memberId ||
        !keyAllowsMachineEnroll(key)
      )
        throw new MachineLinkRefused("actor_not_allowed");
      // This wrapper is per call: concurrent joins never share a mutable key
      // slot. createMachineEnrollment invokes it only around its synchronous
      // identity/directory commit, after awaited validation and authority reads.
      const consumingOwner: WatchdogSqliteOwner = {
        sql: options.owner.sql,
        transactionSync: (body) =>
          options.owner.transactionSync(() => {
            const consumed =
              options.owner.sql
                .exec(
                  "SELECT key_id FROM standalone_machine_enroll_keys WHERE key_id=?",
                  keyId,
                )
                .toArray().length !== 0;
            if (consumed) {
              // Replay is an ordinary enrollment receipt, not another spend.
              // The shared owner checks canonical body, member, login and
              // retirement before returning its original directory identities.
              if (
                options.owner.sql
                  .exec(
                    "SELECT 1 FROM standalone_machine_enroll_keys WHERE key_id=? AND request_id=?",
                    keyId,
                    input.requestId,
                  )
                  .toArray().length === 0
              )
                throw new MachineLinkRefused("actor_not_allowed");
            } else {
              options.owner.sql.exec(
                "INSERT INTO standalone_machine_enroll_keys (key_id, request_id) VALUES (?, ?)",
                keyId,
                input.requestId,
              );
            }
            return body();
          }),
      };
      return createMachineEnrollment({
        ...configured,
        owner: consumingOwner,
        authorizeMember: async (member) => {
          await configured.authorizeMember(member);
          const current = await options.liveKey(keyId);
          if (current?.owner !== member || !keyAllowsMachineEnroll(current))
            throw new MachineLinkRefused("actor_not_allowed");
        },
      }).enroll(
        { memberId, clientId: "oyster-key", loginId: key.keyId },
        input,
      );
    },
  };
}
