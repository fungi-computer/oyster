import { connectAppHost } from "@fungi.computer/agar/host";
import { z } from "zod";
import { bootUiSchema } from "../boot-gate.js";

/**
 * Trusted, zero-grant parent for a candidate entry. App readiness messages
 * establish the ordinary Agar connection, never the boot-gate verdict.
 */
async function bootHost(): Promise<void> {
  const element = document.getElementById("boot-config");
  if (element === null) throw new Error("Host boot configuration unavailable");
  const config = bootUiSchema
    .pick({ identity: true })
    .extend({
      identity: bootUiSchema.shape.identity.extend({
        surfaceId: z.string().min(1).max(256),
      }),
      entry: z.url(),
      expiresAt: z.number().optional(),
    })
    .parse(JSON.parse(element.textContent));
  const frame = document.getElementById("candidate");
  if (!(frame instanceof HTMLIFrameElement) || frame.contentWindow === null)
    throw new Error("Host candidate frame unavailable");
  if (config.expiresAt !== undefined) {
    window.setTimeout(
      () => {
        frame.hidden = true;
        document.querySelector(".preview-details")?.removeAttribute("open");
        const expired = document.getElementById("preview-expired");
        if (expired !== null) expired.hidden = false;
        const state = document.getElementById("preview-state");
        if (state !== null) state.textContent = "expired";
      },
      Math.max(0, config.expiresAt - Date.now()),
    );
  }
  const denied = () => Promise.reject(new Error("No grants in this preview"));
  const connection = connectAppHost({
    appWindow: frame.contentWindow,
    expectedAppOrigin: "null",
    hostWindow: window,
    launch: {
      identity: config.identity,
      capabilities: [],
      context: {
        version: 1,
        value: {
          computerId: null,
          focus: { editing: false, surface: null },
          openRequest: null,
          visibility: "visible",
        },
      },
      lifecycle: { version: 1, value: "connected" },
      reservedChords: { version: 1, value: [] },
      theme: { version: 1, value: "light" },
    },
    handlers: {
      invokeReservedChord: denied,
      onDisconnect: () => Promise.resolve(),
      openNavigation: denied,
      registerCommands: () =>
        Promise.resolve({
          update: () => undefined,
          dispose: () => undefined,
        }),
      reportFocus: () => Promise.resolve(),
      reportAgentSessionSelection: () => Promise.resolve(),
      showToast: () => Promise.resolve(),
    },
  });
  // Install the host connection listener before the candidate can announce ready.
  frame.src = config.entry;
  await connection;
}

await bootHost();
