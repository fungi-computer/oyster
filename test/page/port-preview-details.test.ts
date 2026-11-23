import { expect, it, vi } from "vitest";
import { readPortPreviewDetails } from "../../src/port-preview-details.js";

const url = "/computers/workspace/ports/3000?computerId=workspace";
const entry = {
  action: url,
  computerId: "workspace",
  computerName: "Studio Computer",
  port: 3000,
};

it("reads the Computer's name", async () => {
  const fetch = vi.fn(() => Promise.resolve(Response.json(entry)));
  expect(await readPortPreviewDetails(url, { fetch })).toEqual({
    kind: "loaded",
    computerName: "Studio Computer",
  });
});

it("names an HTTP status", async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response("", { status: 503 })));
  const details = await readPortPreviewDetails(url, { fetch });
  expect(details).toMatchObject({ kind: "failed" });
  expect(details.kind === "failed" && details.message).toContain(
    "server error 503",
  );
});

it("names a dropped connection", async () => {
  const fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
  const details = await readPortPreviewDetails(url, { fetch });
  expect(details.kind === "failed" && details.message).toContain(
    "your connection dropped",
  );
});

it("names unreadable details", async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(new Response("<html>", { status: 200 })),
  );
  const details = await readPortPreviewDetails(url, { fetch });
  expect(details.kind === "failed" && details.message).toContain(
    "could not read",
  );
});

it("ends a hang with a named timeout", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn(
      (...[, init]: Parameters<typeof globalThis.fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = readPortPreviewDetails(url, { fetch, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const details = await pending;
    expect(details.kind === "failed" && details.message).toContain(
      "your Oyster did not answer within 5 seconds",
    );
  } finally {
    vi.useRealTimers();
  }
});
