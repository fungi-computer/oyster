import type { TenantPrincipal } from "../tenant.js";
import { createComputerFilesPort } from "@fungi.computer/computer";
import {
  checkComputerGrant,
  FleetGrantRefused,
  type ComputerAction,
  type ComputerGrant,
} from "@fungi.computer/computer/fleet";
import {
  computerCapabilities,
  computerValueSchema,
} from "@fungi.computer/computer-contract";
import type { FilesPort } from "@fungi.computer/knapsack";
import type { InvocationContext } from "@fungi.computer/mycelium";
import {
  attachComputerInputSchema,
  detachComputerInputSchema,
  readAgentComputersInputSchema,
  type AgentComputerProjection,
  type ComputerAttachmentInput,
} from "../agent-computers.js";
import type {
  AgentComputerConnection,
  AgentComputerPorts,
} from "../agent-computer-source.js";
import { type OysterEnv } from "../host.js";
import { owner, routes as routeTable, type Routes } from "../authorization.js";
import type { StandaloneAgentComputerRpc } from "./computer.js";

/** The directory supplies live authority; this adapter never invents a grant. */
export type StandaloneAgentComputerAccess = Readonly<{
  admit: (connection: AgentComputerConnection) => Promise<ComputerGrant>;
  computer: (computerId: string) => Rpc.Provider<StandaloneAgentComputerRpc>;
}>;

/** Native operations use the captured Computer, never the mutable workspace selection. */
export function standaloneAgentComputerPorts(
  access: StandaloneAgentComputerAccess,
  connection: AgentComputerConnection,
): AgentComputerPorts {
  const { computerId } = connection.attachment;
  async function authorized(action: ComputerAction) {
    const grant = await access.admit(connection);
    if (
      checkComputerGrant(grant, {
        computerId,
        action,
        now: Date.now(),
      }).kind !== "admitted"
    )
      throw new FleetGrantRefused();
    return grant;
  }
  // Constructing or advertising this port opens no native handle or Workspace.
  async function withFiles<A>(
    action: ComputerAction,
    context: InvocationContext,
    use: (files: FilesPort) => Promise<A>,
  ): Promise<A> {
    context.signal.throwIfAborted();
    await authorized(action);
    context.signal.throwIfAborted();
    return use(createComputerFilesPort(access.computer(computerId)));
  }
  return {
    files: {
      patch: async (input, context) => {
        context.signal.throwIfAborted();
        const grant = await authorized("files.edit");
        context.signal.throwIfAborted();
        return access.computer(computerId).filePatch(grant, input);
      },
      read: (input, context) =>
        withFiles("files.readBytes", context, (files) =>
          files.read(input, context),
        ),
      list: (input, context) =>
        withFiles("files.list", context, (files) => files.list(input, context)),
      glob: (input, context) =>
        withFiles("files.glob", context, (files) => files.glob(input, context)),
      grep: (input, context) =>
        withFiles("files.grep", context, (files) => files.grep(input, context)),
      replace: (input, context) =>
        withFiles("files.edit", context, (files) =>
          files.replace(input, context),
        ),
    },
    computer: {
      getCapabilities: (signal) => {
        signal.throwIfAborted();
        return Promise.resolve(
          computerValueSchema.parse(computerCapabilities()),
        );
      },
      call: async (capabilityId, input, context) => {
        context.signal.throwIfAborted();
        // tool() retains the native advertised-operation/action mapping and decoders.
        const grant = await access.admit(connection);
        context.signal.throwIfAborted();
        return computerValueSchema.parse(
          await access.computer(computerId).tool(grant, capabilityId, input),
        );
      },
    },
  };
}

/** Persisted command outcome, with no fabricated attachment result on refusal. */
export type StandaloneAgentComputerReply =
  | Readonly<{ kind: "ok"; projection: AgentComputerProjection }>
  | Readonly<{
      kind: "refused";
      error:
        | "not_granted"
        | "not_found"
        | "request_conflict"
        | "attachment_identity_conflict";
    }>;

/** Principal and persisted attachment transitions belong to the directory owner. */
export type StandaloneAgentComputerControl = Readonly<{
  attach: (
    principal: TenantPrincipal,
    command: ComputerAttachmentInput,
  ) => Promise<StandaloneAgentComputerReply>;
  detach: (
    principal: TenantPrincipal,
    command: ComputerAttachmentInput,
  ) => Promise<StandaloneAgentComputerReply>;
  read: (
    principal: TenantPrincipal,
    agentId: string,
  ) => Promise<StandaloneAgentComputerReply>;
}>;

/** Owner HTTP transport over the retained attachment command grammar. */
export function standaloneAgentComputerRoutes(
  control: StandaloneAgentComputerControl,
): Routes<OysterEnv> {
  const routes = routeTable<OysterEnv>();
  routes.post(
    "/api/agents/:agentId/computers/:operation",
    owner("direct-or-app"),
    async (context, { principal }) => {
      context.header("Cache-Control", "no-store");
      const operation = context.req.param("operation");
      if (!["attach", "detach", "read"].includes(operation))
        return context.json({ error: "not_found" }, 404);
      let body: unknown;
      try {
        body = await context.req.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return context.json({ error: "invalid_input" }, 400);
      }
      const schema =
        operation === "attach"
          ? attachComputerInputSchema
          : operation === "detach"
            ? detachComputerInputSchema
            : readAgentComputersInputSchema;
      const decoded = schema.safeParse(body);
      if (!decoded.success)
        return context.json({ error: "invalid_input" }, 400);
      if (decoded.data.agentId !== context.req.param("agentId"))
        return context.json({ error: "not_found" }, 404);
      const result =
        operation === "read"
          ? await control.read(principal, decoded.data.agentId)
          : operation === "attach"
            ? await control.attach(
                principal,
                attachComputerInputSchema.parse(decoded.data),
              )
            : await control.detach(
                principal,
                detachComputerInputSchema.parse(decoded.data),
              );
      if (result.kind === "ok") return context.json(result.projection);
      const status =
        result.error === "not_granted"
          ? 403
          : result.error === "not_found"
            ? 404
            : 409;
      return context.json({ error: result.error }, status);
    },
  );
  return routes;
}
