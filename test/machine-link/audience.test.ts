import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  importSeamVerifiers,
  signSeamRequest,
  unsignedPayload,
  verifySeamRequest,
} from "@fungi.computer/seam";
import {
  machineLinkAudience,
  machineLinkDialUrl,
} from "@fungi.computer/seam/machine-link-protocol";
import { createLocalBackendReplayStore } from "../../../computer/src/local-backend-replay.js";

await test("a valid Team A machine-link signature cannot authorize Team B", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("publicKey" in keys))
    throw new Error("Ed25519 did not return a key pair");
  const exported = await crypto.subtle.exportKey("raw", keys.publicKey);
  if (!(exported instanceof ArrayBuffer))
    throw new Error("Raw Ed25519 export did not return bytes");
  const deviceId = "device-one";
  const verifiers = await importSeamVerifiers({
    [deviceId]: btoa(String.fromCharCode(...new Uint8Array(exported))),
  });
  const audienceA = machineLinkAudience("A", deviceId);
  const audienceB = machineLinkAudience("B", deviceId);
  assert.equal(audienceA, "fungi-machine-link:A:device-one");
  assert.equal(audienceB, "fungi-machine-link:B:device-one");
  const url = machineLinkDialUrl("https://hub.test", "A", deviceId).href;
  const now = Date.now();
  const header = await signSeamRequest(
    { keyId: deviceId, key: keys.privateKey },
    audienceA,
    "GET",
    url,
    unsignedPayload,
    now,
  );
  const database = new DatabaseSync(":memory:");
  try {
    const replay = createLocalBackendReplayStore(fromNodeSqlite(database));
    // Hold URL, key, method, time and replay state constant. Only Team differs.
    await assert.rejects(
      verifySeamRequest(
        verifiers,
        audienceB,
        "GET",
        url,
        header,
        null,
        replay,
        now,
      ),
      /bad signature/u,
    );
    // The rejected B attempt must not consume A's otherwise valid request.
    assert.equal(
      await verifySeamRequest(
        verifiers,
        audienceA,
        "GET",
        url,
        header,
        null,
        replay,
        now,
      ),
      deviceId,
    );
  } finally {
    database.close();
  }
});
