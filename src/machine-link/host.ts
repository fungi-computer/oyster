import { Hono } from "hono";
import { z } from "zod";
import { correlationKey } from "@fungi.computer/cairn";
import {
  createMachineLinkPostChannel,
  MachineLinkPostUnavailable,
  machineLinkAudience,
} from "@fungi.computer/seam/machine-link-protocol";
import {
  importSeamVerifiers,
  seamHeader,
  verifySeamRequest,
} from "@fungi.computer/seam";
import { createLocalBackendReplayStore } from "@fungi.computer/computer";
import type {
  PostEnvelope,
  PostDeliveryResult,
} from "@fungi.computer/carrier/post";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
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

/**
 * Native device socket I/O. Pins/member authority and mail admission are supplied
 * by their existing owners. Native attachments survive hibernation; pending
 * Post I/O does not claim durable custody and is retried by Carrier.
 */
export class MachineLinkHost {
  private readonly channels = new Map<WebSocket, Channel>();
  private readonly replay;
  private readonly routes;

  constructor(
    private readonly context: Pick<
      DurableObjectState,
      | "getWebSockets"
      | "acceptWebSocket"
      | "setWebSocketAutoResponse"
      | "waitUntil"
    >,
    owner: WatchdogSqliteOwner,
    private readonly options: Readonly<{
      teamId: string;
      directory: () => Promise<readonly { agentId: string; name: string }[]>;
      authorize: (deviceId: string) => Promise<MachineLinkDevice>;
      receive: (
        device: MachineLinkDevice,
        envelope: PostEnvelope,
      ) => Promise<PostDeliveryResult>;
      /** The host's failure log for refused dials and closed links. */
      report: (operation: string, cause: unknown) => void;
    }>,
  ) {
    this.replay = createLocalBackendReplayStore(owner);
    context.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.routes = new Hono().get(
      "/api/teams/:teamId/local/mesh/:deviceId/connect",
      async (context) => {
        if (context.req.param("teamId") !== options.teamId)
          return context.body(null, 403);
        const request = context.req.raw;
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return context.body(null, 426);
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
            this.replay,
          );
          if (keyId !== deviceId) return context.body(null, 403);
          const pair = new WebSocketPair();
          pair[1].serializeAttachment({
            deviceId,
            fenceEpoch: device.fenceEpoch,
          });
          createMachineLinkSockets(this.context, deviceId).accept(pair[1]);
          await this.publishDirectory(pair[1], deviceId);
          return new Response(null, { status: 101, webSocket: pair[0] });
        } catch (cause) {
          this.options.report("machine-link.dial", cause);
          return context.body(null, 403);
        }
      },
    );
  }

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.routes.fetch(request));
  }

  private async publishDirectory(
    socket: WebSocket,
    deviceId: string,
  ): Promise<void> {
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
    await this.options.authorize(deviceId);
    const links = createMachineLinkSockets(this.context, deviceId);
    const socket = this.context
      .getWebSockets(`machine-link:${deviceId}`)
      .find((candidate) => links.isCurrent(candidate));
    if (socket === undefined)
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    await this.publishDirectory(socket, deviceId);
    return await this.channel(socket, deviceId).deliver(envelope);
  }

  async message(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      const { deviceId } = attachmentSchema.parse(
        socket.deserializeAttachment(),
      );
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
