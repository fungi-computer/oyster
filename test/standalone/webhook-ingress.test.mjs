import { test } from "node:test";
import assert from "node:assert/strict";
import { workflowWebhookIngress } from "../../src/webhook-ingress.ts";
const { Request, ReadableStream } = globalThis;

test("native admission failures are unavailable, reveal no error text and never reach a binding", async () => {
  let failures = 0;
  const ingress = workflowWebhookIngress({
    limits: {
      bodyBytes: 32,
      headerBytes: 1024,
      headerCount: 16,
      readMilliseconds: 100,
    },
    hostLease: async () => {
      throw new Error("private-native-admission-details");
    },
    deliver: assert.fail,
    reportReadFailure: assert.fail,
    reportOwnerFailure: () => {
      failures++;
    },
  });
  const response = await ingress(
    "binding",
    new Request("https://owner.test/hook", { method: "POST" }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "unavailable" });
  assert.equal(failures, 1);
});

test("streaming byte cap refuses before binding lookup even with false Content-Length", async () => {
  let lookups = 0;
  const ingress = workflowWebhookIngress({
    limits: {
      bodyBytes: 3,
      headerBytes: 1024,
      headerCount: 16,
      readMilliseconds: 100,
    },
    hostLease: async () => () => undefined,
    deliver: async () => {
      lookups++;
      return { status: "accepted", deliveryId: "delivery" };
    },
    reportReadFailure: assert.fail,
    reportOwnerFailure: assert.fail,
  });
  const response = await ingress(
    "binding",
    new Request("https://owner.test/hook", {
      method: "POST",
      headers: { "content-length": "1" },
      body: new Uint8Array(4),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(lookups, 0);
});

test("read deadline refuses a stalled sender without looking up a binding", async () => {
  let lookups = 0;
  let cancelled = false;
  let released = false;
  const ingress = workflowWebhookIngress({
    limits: {
      bodyBytes: 32,
      headerBytes: 1024,
      headerCount: 16,
      readMilliseconds: 5,
    },
    hostLease: async () => () => {
      released = true;
    },
    deliver: async () => {
      lookups++;
      return { status: "accepted", deliveryId: "delivery" };
    },
    reportReadFailure: assert.fail,
    reportOwnerFailure: assert.fail,
  });
  const response = await ingress(
    "binding",
    new Request("https://owner.test/hook", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(lookups, 0);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test("header byte/count limits and exhausted host admission independently refuse before binding lookup", async () => {
  for (const { name, hostAllowed, headerBytes, headerCount, headers } of [
    {
      name: "header bytes",
      hostAllowed: true,
      headerBytes: 8,
      headerCount: 16,
      headers: { "x-sender": "too-long" },
    },
    {
      name: "header count",
      hostAllowed: true,
      headerBytes: 1024,
      headerCount: 1,
      headers: { x: "1", y: "2" },
    },
    {
      name: "host admission",
      hostAllowed: false,
      headerBytes: 1024,
      headerCount: 16,
      headers: { x: "1" },
    },
  ]) {
    let lookups = 0;
    const ingress = workflowWebhookIngress({
      limits: {
        bodyBytes: 32,
        headerBytes,
        headerCount,
        readMilliseconds: 50,
      },
      hostLease: async () => (hostAllowed ? () => undefined : null),
      deliver: async () => {
        lookups++;
        return { status: "accepted", deliveryId: "delivery" };
      },
      reportReadFailure: assert.fail,
      reportOwnerFailure: assert.fail,
    });
    const response = await ingress(
      "binding",
      new Request("https://owner.test/hook", {
        method: "POST",
        headers,
      }),
    );
    assert.equal(response.status, 403, name);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "refused" });
    assert.equal(lookups, 0, name);
  }
});

test("a private owner refusal projects only the fixed public status, headers and body", async () => {
  const bindingId = "binding";
  const ingress = workflowWebhookIngress({
    limits: {
      bodyBytes: 32,
      headerBytes: 1024,
      headerCount: 16,
      readMilliseconds: 50,
    },
    hostLease: async () => () => undefined,
    deliver: async () => ({ status: "refused" }),
    reportReadFailure: assert.fail,
    reportOwnerFailure: assert.fail,
  });
  const response = await ingress(
    bindingId,
    new Request("https://owner.test/hook", { method: "POST" }),
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "refused" });
});

test("unknown private owner failures are unavailable, not refusal, without exposing exception text", async () => {
  let failures = 0;
  const ingress = workflowWebhookIngress({
    limits: {
      bodyBytes: 32,
      headerBytes: 1024,
      headerCount: 16,
      readMilliseconds: 50,
    },
    hostLease: async () => () => undefined,
    deliver: async () => {
      throw new Error("private signing key material");
    },
    reportReadFailure: assert.fail,
    reportOwnerFailure: () => {
      failures++;
    },
  });
  const response = await ingress(
    "binding",
    new Request("https://owner.test/hook", { method: "POST" }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "unavailable" });
  assert.equal(failures, 1);
});
