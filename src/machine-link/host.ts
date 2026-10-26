import { Hono } from "hono";
import { z } from "zod";
import * as Schema from "effect/Schema";
import { correlationKey } from "@fungi.computer/cairn";
import {
  createMachineLinkPostChannel,
  MachineLinkPostUnavailable,
  machineLinkAudience,
  machineLinkProtocolVersion,
} from "@fungi.computer/seam/machine-link-protocol";
import {
  importSeamVerifiers,
  seamHeader,
  verifySeamRequest,
  type SeamReplayStore,
} from "@fungi.computer/seam";
import {
  createPost,
  definePostRoute,
  PostDeliveryResultSchema,
  type PostEnvelope,
  type PostDeliveryResult,
  type PostRegistryRoute,
  type PostRow,
  type PostRuntime,
} from "@fungi.computer/carrier/post";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";
import { machineAgentOperationSchema } from "@fungi.computer/seam/machine-link-protocol";
import {
  Watchdog,
  type WatchdogRuntime,
  type WatchdogSqliteOwner,
} from "@fungi.computer/watchdog";
import { createMachineLinkSockets } from "./presence.js";

const attachmentSchema = z.strictObject({
  deviceId: z.string().min(1).max(256),
  fenceEpoch: z.int().nonnegative(),
});
export type MachineLinkDevice = Readonly<{
  deviceId: string;
  memberId: string;
  publicKey: string;
  fenceEpoch: number;
}>;
type Channel = ReturnType<typeof createMachineLinkPostChannel>;
const maximumInFlight = 32;
const custodyDeadlineMs = 7 * 24 * 60 * 60 * 1_000;
const recipientOffline: PostDeliveryResult = {
  status: "accepted",
  receipt: {
    status: "held",
    reason: "recipient_offline",
    message: "waiting: recipient offline",
  },
};
// Carrier persists the nested application receipt, not the Post result wrapper.
const custodyReceipt = (
  status: "accepted" | "refused",
  receipt: Schema.Json,
): PostDeliveryResult =>
  Schema.decodeUnknownSync(PostDeliveryResultSchema)({ status, receipt });
const previousCustodyReceipt = (existing: PostRow): PostDeliveryResult => {
  if (existing.state === "delivered")
    return existing.receipt === undefined
      ? "accepted"
      : custodyReceipt("accepted", existing.receipt);
  if (existing.state === "dead" && existing.receipt !== undefined)
    return custodyReceipt("refused", existing.receipt);
  return recipientOffline;
};
type PostRuntimeCell = {
  current: PostRuntime<Record<string, PostRegistryRoute>> | undefined;
};
const custodyAddress = Schema.Struct({
  scopeId: Schema.String,
  agentId: Schema.String,
});
const machineAgentEvent = Schema.Struct({
  actorAgentId: Schema.String,
  operation: machineAgentOperationSchema,
});
const machineMailEnvelope = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literal("agentMail"),
  address: custodyAddress,
  event: BirdDogMailSchema,
});
const machineAgentEnvelope = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literal("machineAgent"),
  address: custodyAddress,
  event: machineAgentEvent,
});
/**
 * Native device socket I/O. Pins/member authority and mail admission are supplied
 * by their existing owners. Native attachments survive hibernation; Carrier
 * owns durable custody and per-Agent ordering across socket lifetimes.
 */
export class MachineLinkHost {
  private readonly channels = new Map<WebSocket, Channel>();
  private replayRuntime: Promise<SeamReplayStore> | undefined;
  private readonly router;
  private readonly custodyRoutes: Record<string, PostRegistryRoute>;
  private deviceId: string | undefined;
  private custodyRuntime:
    | Promise<
        Readonly<{
          post: PostRuntime<Record<string, PostRegistryRoute>>;
          watchdog: WatchdogRuntime;
        }>
      >
    | undefined;
  private readonly receipts = new Map<string, PostDeliveryResult>();

  constructor(
    private readonly context: Pick<
      DurableObjectState,
      | "getWebSockets"
      | "acceptWebSocket"
      | "setWebSocketAutoResponse"
      | "waitUntil"
    >,
    private readonly owner: WatchdogSqliteOwner,
    private readonly options: Readonly<{
      teamId: string;
      directory: () => Promise<readonly { agentId: string; name: string }[]>;
      authorize: (deviceId: string) => Promise<MachineLinkDevice>;
      replay: () => Promise<SeamReplayStore>;
      receive: (
        device: MachineLinkDevice,
        envelope: PostEnvelope,
      ) => Promise<PostDeliveryResult>;
      /** Arm the Durable Object alarm for Carrier/Watchdog progress. */
      scheduleWake: (at: number) => Promise<void>;
      /** The host's failure log for refused dials and closed links. */
      report: (operation: string, cause: unknown) => void;
    }>,
  ) {
    this.custodyRoutes = {
      agentMail: definePostRoute({
        addressKind: "machineLinkAgent",
        deadlineMs: custodyDeadlineMs,
        address: custodyAddress,
        event: BirdDogMailSchema,
        name: ({ agentId }) => agentId,
        namespace: {
          getByName: () => ({
            deliver: (envelope) => this.deliverToSocket(envelope),
          }),
        },
      }),
    };
    context.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.router = new Hono().get(
      "/api/teams/:teamId/local/mesh/:deviceId/connect",
      async (context) => {
        if (context.req.param("teamId") !== options.teamId)
          return context.body(null, 403);
        const request = context.req.raw;
        const deviceId = context.req.param("deviceId");
        try {
          const device = await options.authorize(deviceId);
          const keyId = await verifySeamRequest(
            await importSeamVerifiers({ [deviceId]: device.publicKey }),
            machineLinkAudience(options.teamId, deviceId),
            request.method,
            request.url,
            request.headers.get(seamHeader),
            null,
            await this.replayStore(),
          );
          if (keyId !== deviceId) return context.body(null, 403);
          // Seam verifies the signed path and query before we decide whether
          // this client speaks the one supported wire contract.
          const versions = new URL(request.url).searchParams.getAll("version");
          if (
            versions.length !== 1 ||
            versions[0] !== machineLinkProtocolVersion
          )
            return context.body("upgrade fungi", 426, {
              "x-fungi-machine-link-action": "upgrade fungi",
            });
          if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
            return context.body(null, 426);
          const pair = new WebSocketPair();
          pair[1].serializeAttachment({
            deviceId,
            fenceEpoch: device.fenceEpoch,
          });
          createMachineLinkSockets(this.context, deviceId).accept(pair[1]);
          const response = new Response(null, {
            status: 101,
            webSocket: pair[0],
          });
          this.context.waitUntil(this.connected(pair[1], deviceId));
          return response;
        } catch (cause) {
          this.options.report("machine-link.dial", cause);
          return context.body(null, 403);
        }
      },
    );
  }

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.router.fetch(request));
  }

  private replayStore(): Promise<SeamReplayStore> {
    this.replayRuntime ??= this.options.replay();
    return this.replayRuntime;
  }

  /** Start the fresh socket and then hand durable rows to its live channel. */
  async connected(socket: WebSocket, deviceId: string): Promise<void> {
    this.deviceId = deviceId;
    await this.publishDirectory(socket, deviceId);
    await this.releaseCustody();
    await this.drainCustody();
  }

  private async publishDirectory(
    socket: WebSocket,
    deviceId: string,
  ): Promise<void> {
    this.deviceId = deviceId;
    // Ordered before the addressed operation, but its metadata ACK is not a
    // prerequisite for work admission (including the deliberately lost ACK).
    const agents = await this.options.directory();
    this.context.waitUntil(
      this.channel(socket, deviceId)
        .deliver({
          key: `directory:${correlationKey()}`,
          kind: "machineDirectory",
          address: { teamId: this.options.teamId, deviceId },
          event: {
            agents: agents.map(({ agentId, name }) => ({ agentId, name })),
          },
        })
        .then(
          () => undefined,
          (cause: unknown) => {
            this.options.report("machine-link.directory", cause);
            socket.close(1011, "directory unavailable");
          },
        ),
    );
  }

  private channel(socket: WebSocket, deviceId: string): Channel {
    let channel = this.channels.get(socket);
    if (channel === undefined) {
      // Native stream ordering survives asynchronous authority pulls. Bound
      // writes to the combined send/receive budgets independently of receipt
      // timeouts; this is not a custody or retry queue.
      const writer = new WritableStream<string>(
        {
          write: async (frame: string) => {
            await this.authorizeSocket(socket, deviceId);
            socket.send(frame);
          },
        },
        new CountQueuingStrategy({ highWaterMark: 2 * maximumInFlight }),
      ).getWriter();
      channel = createMachineLinkPostChannel({
        limits: {
          maxInFlight: maximumInFlight,
          maxFrameBytes: 512 * 1024,
          acknowledgmentMs: 10_000,
        },
        send: (frame) => {
          // A receipt timeout releases Post custody, not a still-blocked
          // native write. Enforce the stream's bound before enqueueing again.
          if (writer.desiredSize === null || writer.desiredSize <= 0)
            throw new MachineLinkPostUnavailable({ reason: "busy" });
          return writer.write(frame);
        },
        receive: async (envelope) => {
          const device = await this.authorizeSocket(socket, deviceId);
          return await this.options.receive(device, envelope);
        },
      });
      this.channels.set(socket, channel);
    }
    return channel;
  }

  async deliver(
    deviceId: string,
    envelope: PostEnvelope,
  ): Promise<PostDeliveryResult> {
    this.deviceId = deviceId;
    await this.options.authorize(deviceId);
    const links = createMachineLinkSockets(this.context, deviceId);
    const socket = this.context
      .getWebSockets(`machine-link:${deviceId}`)
      .find((candidate) => links.isCurrent(candidate));
    const typedEnvelope = Schema.decodeUnknownSync(
      Schema.Union([machineMailEnvelope, machineAgentEnvelope]),
    )(envelope);
    if (typedEnvelope.kind === "machineAgent")
      return await this.deliverLiveOperation(deviceId, socket, typedEnvelope);
    return await this.deliverCustodyMail(deviceId, socket, typedEnvelope);
  }

  private async deliverLiveOperation(
    deviceId: string,
    socket: WebSocket | undefined,
    envelope: Schema.Schema.Type<typeof machineAgentEnvelope>,
  ): Promise<PostDeliveryResult> {
    if (socket === undefined)
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    await this.publishDirectory(socket, deviceId);
    return await this.channel(socket, deviceId).deliver(envelope);
  }

  private async deliverCustodyMail(
    deviceId: string,
    socket: WebSocket | undefined,
    envelope: Schema.Schema.Type<typeof machineMailEnvelope>,
  ): Promise<PostDeliveryResult> {
    const { post } = await this.custody();
    const existing = post.read(envelope.key);
    if (existing !== undefined) {
      this.owner.transactionSync(() => {
        post.send(envelope);
      });
      return previousCustodyReceipt(existing);
    }
    this.owner.transactionSync(() => {
      post.send(envelope);
    });
    await this.options.scheduleWake(post.nextWake() ?? Date.now());
    if (socket === undefined) return recipientOffline;
    await this.publishDirectory(socket, deviceId);
    await this.drainCustody();
    const receipt = this.receipts.get(envelope.key);
    this.receipts.delete(envelope.key);
    return receipt ?? recipientOffline;
  }

  /** Run due Carrier work; expired rows remain visible as Carrier dead letters. */
  async alarm(): Promise<void> {
    await this.drainCustody();
  }

  /** Expose terminal custody rows so S9 can stage its own disposition reply. */
  async deadLetters(afterKey?: string) {
    const { post } = await this.custody();
    return post.deadLetters(64, afterKey);
  }

  private async deliverToSocket(
    envelope: PostEnvelope,
  ): Promise<PostDeliveryResult> {
    const deviceId = this.deviceId;
    if (deviceId === undefined)
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    const links = createMachineLinkSockets(this.context, deviceId);
    const socket = this.context
      .getWebSockets(`machine-link:${deviceId}`)
      .find((candidate) => links.isCurrent(candidate));
    if (socket === undefined)
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    const result = await this.channel(socket, deviceId).deliver(envelope);
    this.receipts.set(envelope.key, result);
    return result;
  }

  private async custody() {
    this.custodyRuntime ??= this.createCustody();
    return await this.custodyRuntime;
  }

  private async createCustody() {
    const postRef: PostRuntimeCell = { current: undefined };
    const watchdog: WatchdogRuntime = await Watchdog.make({
      owner: this.owner,
      isAlive: () => Promise.resolve(false),
      execute: (job) => {
        const post = postRef.current;
        if (post === undefined)
          throw new Error("Carrier Post runtime is not initialized");
        return post.execute(job);
      },
      wake: {
        recompute: async () => {
          const at = postRef.current?.nextWake();
          if (at !== null && at !== undefined)
            await this.options.scheduleWake(at);
        },
      },
    });
    const post = createPost({
      routes: this.custodyRoutes,
      owner: this.owner,
      transactional: watchdog.transactional,
      readJob: watchdog.read,
      now: Date.now,
      scheduleWake: this.options.scheduleWake,
    });
    postRef.current = post;
    return { post, watchdog };
  }

  private async releaseCustody(): Promise<void> {
    const { post } = await this.custody();
    let cursor: string | undefined;
    do {
      cursor = await post.releaseNow(64, cursor);
    } while (cursor !== undefined);
  }

  private async drainCustody(): Promise<void> {
    const { post, watchdog } = await this.custody();
    let cursor: string | undefined;
    do {
      cursor = await post.enqueueDue(64, cursor);
    } while (cursor !== undefined);
    for (let count = 0; count < 64; count += 1) {
      const tick = await watchdog.tick();
      if (tick.status !== "settled") break;
    }
    const at = post.nextWake();
    if (at !== null) await this.options.scheduleWake(at);
  }

  async message(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      const { deviceId } = attachmentSchema.parse(
        socket.deserializeAttachment(),
      );
      this.deviceId = deviceId;
      if (!createMachineLinkSockets(this.context, deviceId).isCurrent(socket)) {
        socket.close(4001, "replaced");
        return;
      }
      await this.authorizeSocket(socket, deviceId);
      const text = z.string().safeParse(message);
      if (!text.success) {
        socket.close(1003, "text required");
        return;
      }
      await this.channel(socket, deviceId).receive(text.data);
    } catch (cause) {
      this.#fail(socket, cause);
    }
  }

  close(socket: WebSocket): void {
    this.channels.get(socket)?.close();
    this.channels.delete(socket);
  }

  // A message that cannot be admitted or received ends this link: the host
  // records the cause and the device sees 1011, then reconnects with a fresh dial.
  #fail(socket: WebSocket, cause: unknown): void {
    this.options.report("machine-link.message", cause);
    this.close(socket);
    socket.close(1011, "machine link unavailable");
  }

  private async authorizeSocket(socket: WebSocket, deviceId: string) {
    const attachment = attachmentSchema.parse(socket.deserializeAttachment());
    const device = await this.options
      .authorize(deviceId)
      .catch((cause: unknown) => {
        this.close(socket);
        socket.close(4003, "authority unavailable");
        throw cause;
      });
    if (
      attachment.deviceId !== deviceId ||
      attachment.fenceEpoch !== device.fenceEpoch ||
      !createMachineLinkSockets(this.context, deviceId).isCurrent(socket)
    ) {
      this.close(socket);
      socket.close(4003, "authority changed");
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    }
    return device;
  }

  /** A delayed old fence cannot retire a fresh connection at the current epoch. */
  fence(fenceEpoch: number, live: boolean): void {
    for (const socket of this.context.getWebSockets()) {
      const pin = attachmentSchema.safeParse(socket.deserializeAttachment());
      if (
        !pin.success ||
        pin.data.fenceEpoch < fenceEpoch ||
        (!live && pin.data.fenceEpoch === fenceEpoch)
      ) {
        this.close(socket);
        socket.close(4003, "authority changed");
      }
    }
  }

  /** Authorized physical erasure retires even hibernated sockets, at any epoch. */
  retireForErasure(): void {
    for (const socket of this.context.getWebSockets()) {
      this.close(socket);
      socket.close(4003, "erased");
    }
  }
}
