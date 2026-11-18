import { AppRegionHost } from "@fungi.computer/agar/host";

/**
 * Oyster's page opens each Region socket itself, same-origin with its own
 * session, so no credential or socket URL ever reaches the sandboxed App.
 */
export function oysterRegionHost(regionUrl: string): AppRegionHost {
  return new AppRegionHost(() => {
    const url = new URL(regionUrl, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url);
  });
}
