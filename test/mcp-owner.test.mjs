/* global Request, URL */
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ownerFrontends } from "./mcp-owner.fixture.mjs";

test("concurrent cold requests retain the first initialized MCP session", async () => {
  const firstHost = Promise.withResolvers();
  const secondHost = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let cold = true;
  let constructions = 0;
  const fixture = ownerFrontends({
    beforeHost: async () => {
      if (!cold) return;
      constructions++;
      entered.resolve();
      await (constructions === 1 ? firstHost.promise : secondHost.promise);
    },
  });
  const client = new Client({ name: "cold owner race", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://oyster.test/mcp"),
    {
      fetch: (input, init) => fixture.first.app.fetch(new Request(input, init)),
    },
  );
  try {
    const initializing = client.connect(transport);
    await entered.promise;
    const concurrent = fixture.second.app.fetch(
      new Request("https://oyster.test/mcp"),
    );
    // Drain the second request's cached protocol imports while construction is held.
    await setImmediate();
    // Later catalog acquisitions still capture the ordinary current host.
    cold = false;
    firstHost.resolve();
    await initializing;
    assert.ok(transport.sessionId);
    secondHost.resolve();
    assert.equal((await concurrent).status, 404);
    await assert.doesNotReject(
      client.listTools(),
      "the first session survives the other cold request",
    );
    assert.equal(constructions, 1, "cold callers share one owner construction");
  } finally {
    firstHost.resolve();
    secondHost.resolve();
    await client.close();
    fixture.close();
  }
});

test("failed cold owner construction can be retried by a later request", async () => {
  let fail = true;
  const fixture = ownerFrontends({
    beforeHost: () => {
      if (fail) {
        fail = false;
        throw new Error("host construction unavailable");
      }
    },
  });
  const failed = new Client({ name: "failed owner", version: "1" });
  const retry = new Client({ name: "retry owner", version: "1" });
  const connection = () =>
    new StreamableHTTPClientTransport(new URL("https://oyster.test/mcp"), {
      fetch: (input, init) => fixture.first.app.fetch(new Request(input, init)),
    });
  try {
    await assert.rejects(
      failed.connect(connection()),
      (error) => error instanceof SdkHttpError && error.status === 500,
    );
    await retry.connect(connection());
    await retry.listTools();
  } finally {
    await failed.close();
    await retry.close();
    fixture.close();
  }
});

test("the shared owner reauthenticates roles, expires cold SDK sessions, and permits reinitialization", async () => {
  const fixture = ownerFrontends();
  const client = new Client({ name: "durable owner proof", version: "1" });
  const connection = () =>
    new StreamableHTTPClientTransport(new URL("https://oyster.test/mcp"), {
      fetch: (input, init) =>
        fixture.second.app.fetch(new Request(input, init)),
    });
  const transport = connection();
  try {
    await client.connect(transport);
    const id = transport.sessionId;
    assert.ok(id);
    await Promise.all([client.listTools(), client.listTools()]);
    await fixture.populateCache();
    await client.listTools();
    fixture.setPrincipal({
      actor: { kind: "member", memberId: "member-proof" },
      role: "member",
    });
    await assert.rejects(
      client.listTools(),
      (error) => error instanceof SdkHttpError && error.status === 404,
    );
    fixture.setPrincipal({
      actor: { kind: "member", memberId: "other-member" },
      role: "owner",
    });
    await assert.rejects(
      client.listTools(),
      (error) => error instanceof SdkHttpError && error.status === 404,
    );
    fixture.setPrincipal({
      actor: { kind: "member", memberId: "member-proof" },
      role: "owner",
    });
    fixture.refuse({ kind: "refused", status: 429, retryAfter: "12" });
    const refused = await fixture.first.app.fetch(
      new Request("https://oyster.test/mcp", {
        headers: { "Mcp-Session-Id": id },
      }),
    );
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("Retry-After"), "12");
    fixture.refuse(undefined);
    assert.equal(
      (await fixture.wrongPin(new Request("https://oyster.test/mcp"))).status,
      404,
    );
    assert.equal(
      (await fixture.withoutBinding(new Request("https://oyster.test/mcp")))
        .status,
      503,
    );
    fixture.reconstruct();
    await assert.rejects(
      client.listTools(),
      (error) => error instanceof SdkHttpError && error.status === 404,
    );
    await client.close();
    const fresh = connection();
    await client.connect(fresh);
    assert.notEqual(fresh.sessionId, id);
    await client.listTools();
    const freshId = fresh.sessionId;
    assert.ok(freshId);
    await fresh.terminateSession();
    const ended = await fixture.first.app.fetch(
      new Request("https://oyster.test/mcp", {
        headers: { "Mcp-Session-Id": freshId },
      }),
    );
    assert.equal(ended.status, 404);
  } finally {
    await client.close();
    fixture.close();
  }
});
