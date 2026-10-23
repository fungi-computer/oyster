/** Native socket ownership for one machine; the caller authenticates each dial. */
export function createMachineLinkSockets(
  context: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">,
  deviceId: string,
) {
  const machineLinkTag = `machine-link:${deviceId}`;
  return {
    accept: (socket: WebSocket): void => {
      context.acceptWebSocket(socket, [machineLinkTag]);
      for (const previous of context.getWebSockets(machineLinkTag)) {
        if (previous !== socket && previous.readyState === WebSocket.OPEN)
          previous.close(4001, "replaced");
      }
    },
    isCurrent: (socket: WebSocket): boolean =>
      socket.readyState === WebSocket.OPEN &&
      context.getWebSockets(machineLinkTag).includes(socket),
  };
}

/**
 * Classify the accepted socket using its platform auto-response timestamp.
 * Presence is a liveness hint, never Team membership or execution authority.
 */
export function isMachineLinkOnline(
  hasCurrentSocket: boolean,
  lastAutoPongAt: Date | null,
  now: number,
): boolean {
  if (!hasCurrentSocket || lastAutoPongAt === null) return false;
  const age = now - lastAutoPongAt.getTime();
  return age >= 0 && age < 90_000;
}
