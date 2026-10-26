import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it, vi } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createLocalBackendReplayStore } from "../../../computer/src/local-backend-replay.js";
import {
  signSeamRequest,
  seamHeader,
  unsignedPayload,
} from "@fungi.computer/seam";
import {
  machineLinkAudience,
  machineLinkDialUrl,
} from "@fungi.computer/seam/machine-link-protocol";
import { MachineLinkHost } from "../../src/machine-link/host.js";

it("an authenticated version mismatch refuses the dial with upgrade fungi", async () => {
  const database = new DatabaseSync(":memory:");
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      readonly request: string;
      readonly response: string;
      constructor(request: string, response: string) {
        this.request = request;
        this.response = response;
      }
    },
  );
  try {
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in keys)) throw new Error("Expected a device key pair");
    const exported = await crypto.subtle.exportKey("raw", keys.publicKey);
    if (!(exported instanceof ArrayBuffer))
      throw new Error("Expected raw Ed25519 bytes");
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(exported)));
    const context = {
      getWebSockets: () => [],
      acceptWebSocket: () => undefined,
      setWebSocketAutoResponse: () => undefined,
      waitUntil: () => undefined,
    } satisfies ConstructorParameters<typeof MachineLinkHost>[0];
    let authorized = 0;
    const reports: unknown[] = [];
    const host = new MachineLinkHost(context, fromNodeSqlite(database), {
      teamId: "team",
      directory: () => Promise.resolve([]),
      replay: () =>
        Promise.resolve(
          createLocalBackendReplayStore(fromNodeSqlite(database)),
        ),
      authorize: () => {
        authorized += 1;
        return Promise.resolve({
          deviceId: "device",
          memberId: "member",
          publicKey,
          fenceEpoch: 0,
        });
      },
      receive: () => Promise.resolve("refused"),
      scheduleWake: () => Promise.resolve(),
      report: (_operation, cause) => {
        reports.push(cause);
      },
    });
    const url = machineLinkDialUrl("https://hub.test", "team", "device");
    url.searchParams.set("version", "not-this-version");
    const header = await signSeamRequest(
      { keyId: "device", key: keys.privateKey },
      machineLinkAudience("team", "device"),
      "GET",
      url.href,
      unsignedPayload,
    );
    const response = await host.fetch(
      new Request(url, {
        headers: { [seamHeader]: header, Upgrade: "websocket" },
      }),
    );
    assert.equal(response.status, 426);
    assert.equal(await response.text(), "upgrade fungi");
    assert.equal(
      response.headers.get("x-fungi-machine-link-action"),
      "upgrade fungi",
    );
    assert.equal(authorized, 1);
    assert.deepEqual(reports, []);
    // The same HTTP status on a correctly versioned plain GET is only a
    // failed upgrade probe; it must not claim a client upgrade is needed.
    const current = machineLinkDialUrl("https://hub.test", "team", "device");
    const currentHeader = await signSeamRequest(
      { keyId: "device", key: keys.privateKey },
      machineLinkAudience("team", "device"),
      "GET",
      current.href,
      unsignedPayload,
    );
    const probe = await host.fetch(
      new Request(current, { headers: { [seamHeader]: currentHeader } }),
    );
    assert.equal(probe.status, 426);
    assert.equal(await probe.text(), "");
    assert.equal(probe.headers.get("x-fungi-machine-link-action"), null);
    assert.equal(authorized, 2);
  } finally {
    vi.unstubAllGlobals();
    database.close();
  }
});
