import {
  Knapsack,
  type ComputerConnectionOptions,
  type FilesPort,
  type KnapsackComputer,
} from "@fungi.computer/knapsack";
import {
  computerCapabilities,
  computerValueSchema,
} from "@fungi.computer/computer-contract";
import type { CapabilitySource } from "@fungi.computer/mycelium";
import type {
  AgentComputerAdmission,
  AgentComputerProjection,
} from "./agent-computers.js";

/** The host's captured authority namespace, Agent and attachment projection. */
export type AgentComputerSnapshot = Readonly<{
  scopeId: string;
  agentId: string;
  projection: AgentComputerProjection;
}>;

/** Host adapters supply transport, not a second attachment owner. */
export type AgentComputerPorts = Readonly<{
  files: FilesPort;
  computer: KnapsackComputer;
}>;

export type AgentComputerConnection = Readonly<{
  scopeId: string;
  agentId: string;
  attachment: AgentComputerProjection["attachments"][number];
  /** Re-read on every operation; captured handles cannot follow a reattachment. */
  admission: () => AgentComputerAdmission | null;
}>;

/** A host-owned projection reader and the transport for its captured attachments. */
export type AgentComputerSourceOptions = Readonly<{
  read: () => AgentComputerSnapshot | null;
  subscribe: (invalidate: () => void) => () => void;
  connect: (connection: AgentComputerConnection) => AgentComputerPorts;
  onUnavailable?: (detail: { computerId: string; reason: unknown }) => void;
}>;

/** Capture each named Computer and its Files port under the same authority. */
export function readAgentComputerConnections(
  options: Pick<AgentComputerSourceOptions, "read" | "connect">,
): readonly (ComputerConnectionOptions & {
  attachmentId: string;
  files: { port: FilesPort };
})[] {
  return capturedConnections(options, options.read());
}

function capturedConnections(
  options: Pick<AgentComputerSourceOptions, "read" | "connect">,
  captured: AgentComputerSnapshot | null,
) {
  if (captured === null) return [];
  return captured.projection.attachments.map((attachment) => {
    const ports = options.connect({
      scopeId: captured.scopeId,
      agentId: captured.agentId,
      attachment,
      admission: () => {
        const current = options.read();
        if (
          current?.scopeId !== captured.scopeId ||
          current.agentId !== captured.agentId
        )
          return null;
        return (
          current.projection.attachments.find(
            (candidate) =>
              candidate.attachmentId === attachment.attachmentId &&
              candidate.computerId === attachment.computerId &&
              candidate.version === attachment.version,
          )?.admission ?? null
        );
      },
    });
    return {
      id: `computer:${attachment.attachmentId}`,
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      namespace: ["computers"],
      files: { port: ports.files },
      computer: ports.computer,
    };
  });
}

/** Discover the captured connections; current admission remains a per-call host check. */
export function createAgentComputerSource(
  options: AgentComputerSourceOptions,
): CapabilitySource {
  return Knapsack.computers({
    id: "agent-computers",
    subscribe: options.subscribe,
    onUnavailable: (detail) => {
      console.warn("Agent Computer unavailable", detail);
      options.onUnavailable?.(detail);
    },
    read: () => {
      const captured = options.read();
      return {
        version: JSON.stringify([
          captured?.scopeId ?? null,
          captured?.agentId ?? null,
          captured?.projection.revision ?? 0,
        ]),
        connections: capturedConnections(options, captured),
      };
    },
  });
}

const refusedBeforeRun = () =>
  Promise.reject(new Error("The tool gate refuses this call before it runs"));

/** Advertise only the denied shape; no attachment lookup or Computer wake. */
export function createAgentComputerSurface(): CapabilitySource {
  return Knapsack.computers({
    id: "agent-computers-surface",
    subscribe: () => () => undefined,
    onUnavailable: () => undefined,
    read: () => ({
      version: "surface",
      connections: [
        {
          id: "computer:surface",
          name: "computer",
          namespace: ["computers"],
          files: {
            port: {
              read: refusedBeforeRun,
              list: refusedBeforeRun,
              glob: refusedBeforeRun,
              grep: refusedBeforeRun,
              replace: refusedBeforeRun,
            },
          },
          computer: {
            getCapabilities: () =>
              Promise.resolve(
                computerValueSchema.parse(computerCapabilities()),
              ),
            call: refusedBeforeRun,
          },
        },
      ],
    }),
  });
}
