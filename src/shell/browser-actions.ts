import {
  APP_BROWSER_SAVE_MAX_BYTES,
  APP_BROWSER_COPY_MAX_BYTES,
} from "@fungi.computer/agar";
import type {
  AppBrowserAction,
  AppBrowserActionOutcome,
} from "@fungi.computer/agar";

/** Browser effects stay in the trusted host, bound to one mounted App frame. */
export function createBrowserActionHandler(options: {
  frame: HTMLIFrameElement;
  hostWindow: Window;
  signal: AbortSignal;
}): (request: AppBrowserAction) => Promise<AppBrowserActionOutcome> {
  let pending = false;
  return async (request) => {
    const { frame, hostWindow, signal } = options;
    if (signal.aborted || !frame.isConnected)
      return { kind: "refused", reason: "unavailable" };
    if (
      !hostWindow.navigator.userActivation.isActive ||
      hostWindow.document.activeElement !== frame
    )
      return { kind: "refused", reason: "no-user-gesture" };
    if (
      request.kind === "saveFile"
        ? request.bytes.byteLength > APP_BROWSER_SAVE_MAX_BYTES
        : new TextEncoder().encode(request.text).byteLength >
          APP_BROWSER_COPY_MAX_BYTES
    )
      return { kind: "refused", reason: "too-large" };
    if (pending) return { kind: "refused", reason: "busy" };
    pending = true;
    try {
      if (request.kind === "copyText") {
        await hostWindow.navigator.clipboard.writeText(request.text);
        return { kind: "copied" };
      }
      const blob = new Blob([new Uint8Array(request.bytes)], {
        type: request.mime,
      });
      const url = URL.createObjectURL(blob);
      try {
        const link = hostWindow.document.createElement("a");
        link.href = url;
        link.download = request.name;
        link.click();
      } finally {
        // Keep the bytes alive until the browser handles the navigation task.
        hostWindow.setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 0);
      }
      // The browser accepted a download; this does not attest a disk write.
      return { kind: "saved" };
    } catch (cause) {
      return {
        kind: "refused",
        reason:
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "denied"
            : "unavailable",
      };
    } finally {
      pending = false;
    }
  };
}
