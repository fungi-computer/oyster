import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { z } from "zod";
import type * as Schema from "effect/Schema";
import type {
  PostEnvelope,
  PostDeliveryResult,
} from "@fungi.computer/carrier/post";
import type { MachineAgentOperation } from "@fungi.computer/seam/machine-link-protocol";
import { createHomeAwareAgentMailNamespace } from "./delivery.js";
import type { MachineAgentHome } from "./home.js";
// Type-only: the Workers link itself is never loaded by this portable client.
import type { MachineLink } from "./link.js";
import {
  machineLinkName,
  type MachineLinkCaller,
  type MachineLinkIdentity,
} from "./authority.js";

const identity = z.string().min(1).max(256);

/** The caller a hosted settlement read acts for. */
export type MachineAgentSettlementPrincipal = Readonly<{
  teamId: string;
  actor: Readonly<{ kind: "agent"; id: string }>;
}>;

/**
 * The host's Agent wire grammar. This module routes Agent work by home and
 * never decodes an Agent body itself. Each codec must be strict: it is the
 * only decoder of caller bodies and of settlements a device returns.
 */
export type MachineAgentCodecs<Settlement> = Readonly<{
  /** The Session-creation intent, or null when the body is not one. */
  sessionCreation(body: Schema.Json): Readonly<{ requestId: string }> | null;
  /** One serialized settlement from a hosted or machine-homed Agent. */
  settlement(encoded: string): Settlement;
  /** Throws unless an acknowledgment carries a well-formed Accepted receipt. */
  accepted(receipt: Schema.Json): void;
}>;

/** The device link entry points a hosted caller needs. */
export type MachineAgentLinkPort = Readonly<{
  deliver(
    identity: MachineLinkIdentity,
    caller: MachineLinkCaller,
    agentId: string,
    envelope: PostEnvelope,
  ): Promise<PostDeliveryResult>;
  operation(
    identity: MachineLinkIdentity,
    caller: MachineLinkCaller,
    agentId: string,
    operation: MachineAgentOperation,
  ): ReturnType<MachineLink["operation"]>;
}>;

/**
 * Actual-home routing for a hosted Agent's mail, Session creation and
 * settlement reads. A machine-homed target goes to its device link and never
 * falls back to a hosted Agent; the host supplies the fresh home read.
 */
export function createMachineAgentClient<Settlement>(options: {
  identity: () => Readonly<{ teamId: string; agentId: string }> | null;
  links: { getByName(name: string): MachineAgentLinkPort };
  /** The target's current home, read fresh for this act. */
  home: (agentId: string) => Promise<MachineAgentHome>;
  codecs: MachineAgentCodecs<Settlement>;
  hosted: {
    getByName(name: string): {
      deliver(envelope: PostEnvelope): Promise<PostDeliveryResult>;
      fetch(request: Request): Promise<Response>;
      settlement(
        principal: MachineAgentSettlementPrincipal,
        sessionId: string,
        commandId: string,
      ): Promise<string | undefined>;
    };
  };
}) {
  function actor() {
    const current = options.identity();
    if (current === null) throw new Error("Agent Team identity is unavailable");
    return current;
  }
  const home = (agentId: string) => options.home(agentId);
  const machine = (deviceId: string) => {
    const current = actor();
    const identity = { teamId: current.teamId, deviceId };
    const caller: MachineLinkCaller = {
      kind: "hosted",
      agentId: current.agentId,
    };
    return {
      identity,
      caller,
      link: options.links.getByName(machineLinkName(identity)),
    };
  };
  return {
    namespace: {
      getByName: (agentId: string) => ({
        deliver: async (envelope: PostEnvelope) => {
          return await createHomeAwareAgentMailNamespace({
            sender: actor(),
            home,
            hosted: options.hosted,
            accepted: options.codecs.accepted,
            machine: (deviceId, cargo) => {
              const target = machine(deviceId);
              return target.link.deliver(
                target.identity,
                target.caller,
                agentId,
                cargo,
              );
            },
          })
            .getByName(agentId)
            .deliver(envelope);
        },
      }),
    },
    dispatch: async (agentId: string, request: Request) => {
      const targetHome = await home(agentId);
      if (targetHome.kind === "hosted")
        return await options.hosted.getByName(agentId).fetch(request);
      const routes = new Hono().post(
        "/sessions",
        bodyLimit({ maxSize: 512 * 1024 }),
        // Hono hands over the parsed JSON body; the host codec decodes it.
        validator("json", (value: Schema.Json, context) => {
          const parsed = options.codecs.sessionCreation(value);
          if (parsed === null) return context.json({ error: "invalid" }, 400);
          return parsed;
        }),
        async (context) => {
          const target = machine(targetHome.deviceId);
          const result = z.strictObject({ sessionId: identity }).parse(
            await target.link.operation(
              target.identity,
              target.caller,
              agentId,
              {
                type: "createSession",
                requestId: context.req.valid("json").requestId,
              },
            ),
          );
          return context.json(result, 201);
        },
      );
      return await routes.fetch(request);
    },
    settlement: async (
      agentId: string,
      sessionId: string,
      commandId: string,
      requesterAgentId: string,
    ): Promise<Settlement | undefined> => {
      const targetHome = await home(agentId);
      const current = actor();
      const target =
        targetHome.kind === "machine" ? machine(targetHome.deviceId) : null;
      const encoded =
        target === null
          ? await options.hosted.getByName(agentId).settlement(
              {
                teamId: current.teamId,
                actor: { kind: "agent", id: requesterAgentId },
              },
              sessionId,
              commandId,
            )
          : (z.strictObject({ settlement: z.string().nullable() }).parse(
              await target.link.operation(
                target.identity,
                target.caller,
                agentId,
                {
                  type: "settlement",
                  requesterAgentId,
                  sessionId,
                  commandId,
                },
              ),
            ).settlement ?? undefined);
      return encoded === undefined
        ? undefined
        : options.codecs.settlement(encoded);
    },
  };
}
