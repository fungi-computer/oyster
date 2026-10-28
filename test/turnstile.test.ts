import { afterEach, expect, it, vi } from "vitest";
import {
  readTurnstileConfiguration,
  verifyTurnstileToken,
} from "@fungi.computer/oyster/turnstile";

afterEach(() => vi.unstubAllGlobals());

it("keeps the explicit opt-out, development default and deployed fail-closed configuration", () => {
  expect(readTurnstileConfiguration({}, undefined)).toEqual({
    kind: "disabled",
  });
  expect(readTurnstileConfiguration({}, "http://localhost:8787")).toEqual({
    kind: "disabled",
  });
  expect(readTurnstileConfiguration({}, "https://oyster.example")).toEqual({
    kind: "misconfigured",
  });
  expect(
    readTurnstileConfiguration({ TURNSTILE: "off" }, "https://oyster.example"),
  ).toEqual({ kind: "disabled" });
  for (const environment of [
    { TURNSTILE_SITE_KEY: "site" },
    { TURNSTILE_SECRET_KEY: "secret" },
    { TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "secret" },
    { TURNSTILE: "on" },
  ])
    expect(
      readTurnstileConfiguration(environment, "https://oyster.example"),
    ).toEqual({ kind: "misconfigured" });
  expect(
    readTurnstileConfiguration(
      { TURNSTILE_SITE_KEY: " site ", TURNSTILE_SECRET_KEY: " secret " },
      "https://oyster.example",
    ),
  ).toEqual({ kind: "enabled", siteKey: "site", secretKey: "secret" });
});

it.each([true, false])(
  "decodes siteverify success=%s without changing the provider request",
  async (success) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ success })),
    );
    vi.stubGlobal("fetch", fetch);
    const onError = vi.fn();
    expect(
      await verifyTurnstileToken(
        { secretKey: "secret", token: "token", remoteIp: "192.0.2.1" },
        { timeoutMs: 5_000, onError },
      ),
    ).toBe(success ? "passed" : "failed");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    if (init === undefined) throw new Error("Expected siteverify options");
    const { signal, ...options } = init;
    expect(options).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: "secret",
        response: "token",
        remoteip: "192.0.2.1",
      }),
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(onError).not.toHaveBeenCalled();
  },
);

it("omits an absent address rather than manufacturing a provider field", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(Response.json({ success: true })),
  );
  vi.stubGlobal("fetch", fetch);
  await verifyTurnstileToken(
    { secretKey: "secret", token: "token" },
    { timeoutMs: 5_000, onError: vi.fn() },
  );
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(
    JSON.stringify({ secret: "secret", response: "token" }),
  );
});

it.each([
  () => new Response(null, { status: 503 }),
  () => Response.json({ success: "true" }),
  () => new Response("not json"),
  () => Promise.reject(new Error("network unavailable")),
])(
  "fails closed when the provider response is unavailable or malformed",
  async (respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));
    expect(
      await verifyTurnstileToken(
        { secretKey: "secret", token: "token" },
        { timeoutMs: 5_000, onError: vi.fn() },
      ),
    ).toBe("unavailable");
  },
);

it("aborts a stalled provider call using the host's timeout and reports the failure", async () => {
  vi.stubGlobal(
    "fetch",
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Verification timed out", "TimeoutError"));
        });
      }),
  );
  const onError = vi.fn();
  expect(
    await verifyTurnstileToken(
      { secretKey: "secret", token: "token" },
      { timeoutMs: 10, onError },
    ),
  ).toBe("unavailable");
  expect(onError).toHaveBeenCalledOnce();
});
