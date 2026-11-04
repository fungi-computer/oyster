/* global fetch, AbortSignal, TextDecoder, console */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { channelIds } from "../../dist/channels/ids.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/visitor-edge-native-`);
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const { port } = socket.address();
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const siteKey = channelIds.site.generate();
const bindingId = channelIds.binding.generate();
let child;
let output = "";

try {
  await writeFile(
    `${work}/wrangler.json`,
    JSON.stringify({
      name: "oyster-visitor-edge-native-proof",
      main: `${root}test/standalone/visitor-edge.native.fixture.ts`,
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      vars: {
        SITE_KEY: siteKey,
        BINDING_ID: bindingId,
        PROOF_KEY: ["fixture", "proof"].join("-").padEnd(40, "p"),
      },
      durable_objects: {
        bindings: [
          { name: "VISITORS", class_name: "Visitors" },
          { name: "WEBSITE_AGENTS", class_name: "WebsiteAgent" },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["Visitors", "WebsiteAgent"],
        },
      ],
    }),
  );
  child = spawn(
    `${root}node_modules/.bin/wrangler`,
    [
      "dev",
      "--config",
      `${work}/wrangler.json`,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      `${work}/state`,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: work,
        XDG_CONFIG_HOME: `${work}/config`,
      },
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      output += bytes.toString();
    });

  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Worker stopped during startup: ${output.slice(-3500)}`);
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch (error) {
      // A transient refusal means workerd is still starting; retain the
      // terminal cause instead of silently converting it into a green probe.
      if (attempt === 89)
        throw new Error(`Worker did not start: ${output.slice(-3500)}`, {
          cause: error,
        });
    }
    await delay(500);
  }
  assert.ok(ready, `Worker did not start: ${output.slice(-3500)}`);
  const path = `/api/embed/v1/sites/${siteKey}`;
  const post = (part, token, body) => {
    const headers = {
      origin,
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(`${origin}${path}${part}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  };
  const minted = await Promise.all([
    post("/visitors", null, {}),
    post("/visitors", null, {}),
  ]);
  assert.deepEqual(
    minted.map((response) => response.status),
    [201, 201],
  );
  const [first, second] = await Promise.all(
    minted.map((response) => response.json()),
  );
  const forge = await fetch(`${origin}/forge/${first.visitorId}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(forge.status, 403, "the actual Agent DO refused forged RPC");
  const opened = await post("/session", first.accessToken, {});
  assert.equal(opened.status, 200, await opened.text());
  const sent = await post("/messages", first.accessToken, {
    requestId: "native-visitor-message",
    text: "First private native text",
  });
  assert.equal(sent.status, 202, await sent.text());
  let firstDocument = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await post("/session", first.accessToken, {});
    firstDocument = await response.text();
    assert.equal(response.status, 200, firstDocument);
    if (firstDocument.includes("Private native reply")) break;
    await delay(250);
  }
  assert.match(firstDocument, /First private native text/u);
  assert.match(firstDocument, /Private native reply/u);
  const other = await post("/session", second.accessToken, {});
  const otherDocument = await other.text();
  assert.equal(other.status, 200, otherDocument);
  assert.doesNotMatch(otherDocument, /First private native text/u);
  const transcripts = await (
    await fetch(`${origin}/owner/transcripts`, {
      signal: AbortSignal.timeout(10_000),
    })
  ).json();
  const lines = transcripts.transcripts.map((transcript) => transcript.lines);
  assert.deepEqual(
    lines.filter((conversation) => conversation.length > 0),
    [
      [
        { role: "visitor", text: "First private native text" },
        { role: "agent", text: "Private native reply" },
      ],
    ],
    "the owner reads the first visitor's conversation from the one website Agent",
  );
  assert.equal(lines.length, 2, "the second visitor has a separate, empty one");
  const sse = await fetch(`${origin}${path}/conversation/events`, {
    headers: {
      origin,
      authorization: `Bearer ${first.accessToken}`,
    },
    signal: AbortSignal.timeout(40_000),
  });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let initial = "";
  while (
    !initial.includes("First private native text") &&
    initial.length < 65_536
  ) {
    const chunk = await reader.read();
    assert.equal(
      chunk.done,
      false,
      "SSE closed before the visitor's transcript",
    );
    initial += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(initial, /First private native text/u);
  const revoked = await fetch(`${origin}/revoke/${first.visitorId}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(revoked.status, 200);
  // The native SSE callback crosses the DO→Worker RPC boundary on the next
  // beat; revocation must terminate rather than emitting another frame.
  const ended = await Promise.race([
    reader.read(),
    delay(35_000).then(() => {
      throw new Error("Revoked native stream did not close on its next beat");
    }),
  ]);
  assert.equal(ended.done, true);
  console.log("native visitor HTTP, DO RPC, SSE callback and revocation PASS");
} catch (error) {
  console.error("native website visitor proof failed", error);
  console.error(output.slice(-4500));
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(3_000),
    ]);
  }
  await rm(work, { recursive: true, force: true });
}
