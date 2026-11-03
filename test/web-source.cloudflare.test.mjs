/* global AbortController, URL, Response, TextEncoder, TextDecoder, ReadableStream, WritableStream */
import { describe, expect, it, vi } from "vitest";
import { createPublicFetch } from "@fungi.computer/veil/public-fetch";
import {
  createWebSource,
  fetchWebPage,
  WEB_FETCH_MAX_BYTES,
} from "../src/web/source.ts";
import { unconfiguredWebSearch } from "../src/web/search.ts";

const publicResolver = vi.fn(() => Promise.resolve(["93.184.215.14"]));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serialize a Response as the HTTP/1.1 bytes a peer would put on the wire. */
async function wire(response) {
  const body = new Uint8Array(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${String(response.status)} Status`];
  for (const [name, value] of response.headers) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${String(body.byteLength)}`, "", "");
  const head = encoder.encode(lines.join("\r\n"));
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head);
  bytes.set(body, head.byteLength);
  return bytes;
}

/**
 * No real connection: a socket whose peer answers the request with what
 * `respond(url)` returns (a Response), or never answers for `null`.
 */
function network(respond) {
  const connects = [];
  const requests = [];
  const connect = (address, { secureTransport }) => {
    connects.push({ ...address, secureTransport });
    let wrote;
    const requested = new Promise((resolve) => {
      wrote = resolve;
    });
    let sent = false;
    const socket = {
      readable: new ReadableStream({
        pull: async (controller) => {
          await requested;
          if (sent) return controller.close();
          sent = true;
          const request = requests.at(-1);
          const host = /^Host: (.*)\r$/mu.exec(request)?.[1];
          const path = /^GET (\S+) /u.exec(request)?.[1];
          const scheme = secureTransport === "off" ? "http" : "https";
          const response = await respond(new URL(`${scheme}://${host}${path}`));
          if (response === null) return new Promise(() => undefined);
          controller.enqueue(await wire(response));
        },
      }),
      writable: new WritableStream({
        write: (bytes) => {
          requests.push(decoder.decode(bytes));
          wrote();
        },
      }),
      opened: Promise.resolve({}),
      startTls: () => socket,
      close: () => Promise.resolve(),
    };
    return socket;
  };
  return { connect, connects, requests };
}

function run(url, respond, options = {}) {
  const net = network(respond);
  const door = createPublicFetch({
    connect: net.connect,
    resolve: options.resolve ?? publicResolver,
  });
  const input = { url };
  if (options.maxChars !== undefined) input.maxChars = options.maxChars;
  const host = {
    get: door.get,
    signal: options.signal ?? new AbortController().signal,
  };
  if (options.timeoutMs !== undefined) host.timeoutMs = options.timeoutMs;
  return { net, result: fetchWebPage(input, host) };
}

const html = `<!doctype html><html lang="en"><head>
<title>Garden &amp; Greenhouse</title>
<meta name="description" content="Notes on &quot;shade&quot; plants">
<style>body { color: red }</style>
<script>window.secret = "never shown";</script>
</head><body>
<nav>Home</nav>
<h1>Ferns</h1><p>Ferns like shade &amp; damp soil.<br>Water weekly.</p>
<noscript>Enable JavaScript</noscript>
<ul><li>Maidenhair</li><li>Boston</li></ul>
<svg><text>vector label</text></svg>
</body></html>`;

describe("web.fetch", () => {
  it("returns readable text and metadata without scripts, styles or markup", async () => {
    const { net, result } = run(
      "https://garden.example/ferns#top",
      () =>
        new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    );
    const page = await result;
    expect(page).toMatchObject({
      url: "https://garden.example/ferns",
      status: 200,
      contentType: "text/html",
      title: "Garden & Greenhouse",
      description: 'Notes on "shade" plants',
      truncated: false,
    });
    expect(page.text).toBe(
      "Home\n\nFerns\n\nFerns like shade & damp soil.\nWater weekly.\n\nMaidenhair\n\nBoston",
    );
    // The connection goes to the one checked address, and the request names
    // the URL's own host (the fragment never leaves).
    expect(net.connects).toEqual([
      { hostname: "93.184.215.14", port: 443, secureTransport: "starttls" },
    ]);
    expect(net.requests[0]).toMatch(/^GET \/ferns HTTP\/1\.1\r\n/u);
    expect(net.requests[0]).toContain("Host: garden.example\r\n");
    expect(net.requests[0]).toMatch(/\r\nAccept: text\/markdown/iu);
  });

  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://10.0.0.8/",
    "http://localhost/",
    "http://printer.local/",
    "http://intranet/",
    "file:///etc/passwd",
    "ftp://files.example/",
    "https://user:secret@site.example/",
  ])("refuses %s before any request", async (url) => {
    const { net, result } = run(url, () => new Response("never"));
    await expect(result).rejects.toMatchObject({ code: "disallowed_url" });
    expect(net.connects).toEqual([]);
  });

  it("refuses a public name that resolves inward (DNS rebinding to metadata)", async () => {
    const { net, result } = run(
      "https://rebind.example/",
      () => new Response(""),
      {
        resolve: () => Promise.resolve(["93.184.215.14", "169.254.169.254"]),
      },
    );
    await expect(result).rejects.toMatchObject({ code: "disallowed_url" });
    expect(net.connects).toEqual([]);
  });

  it("is not moved by a later lookup: the connection lands on the checked address", async () => {
    let lookups = 0;
    const { net, result } = run(
      "https://rebind.example/",
      () => new Response("ok", { headers: { "Content-Type": "text/plain" } }),
      {
        resolve: () => {
          lookups += 1;
          return Promise.resolve(
            lookups === 1 ? ["93.184.215.14"] : ["127.0.0.1"],
          );
        },
      },
    );
    await expect(result).resolves.toMatchObject({ text: "ok" });
    expect(lookups).toBe(1);
    expect(net.connects.map(({ hostname }) => hostname)).toEqual([
      "93.184.215.14",
    ]);
  });

  it.each([
    ["IPv6 loopback", ["::1"]],
    ["an IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["an IPv4-mapped private address", ["::ffff:a00:5"]],
  ])("refuses a name that resolves to %s", async (_name, answers) => {
    const { net, result } = run(
      "https://six.example/",
      () => new Response("never"),
      { resolve: () => Promise.resolve(answers) },
    );
    await expect(result).rejects.toMatchObject({ code: "disallowed_url" });
    expect(net.connects).toEqual([]);
  });

  it("types a name that does not resolve and a host that cannot be reached", async () => {
    const missing = run("https://gone.example/", () => null, {
      resolve: () => Promise.resolve([]),
    });
    await expect(missing.result).rejects.toMatchObject({ code: "dns_failed" });
    const door = createPublicFetch({
      connect: () => {
        throw new Error("no route");
      },
      resolve: publicResolver,
    });
    await expect(
      fetchWebPage(
        { url: "https://down.example/" },
        { get: door.get, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("rechecks every redirect hop and stops at an inward target", async () => {
    const { net, result } = run(
      "https://short.example/go",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://192.168.1.1/admin" },
        }),
    );
    await expect(result).rejects.toMatchObject({ code: "disallowed_url" });
    expect(net.connects).toHaveLength(1);
  });

  it("resolves each redirect hop again and refuses one whose name now answers inward", async () => {
    const answers = new Map([
      ["first.example", ["93.184.215.14"]],
      ["second.example", ["10.0.0.5"]],
    ]);
    const { net, result } = run(
      "https://first.example/go",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://second.example/in" },
        }),
      { resolve: (hostname) => Promise.resolve(answers.get(hostname) ?? []) },
    );
    await expect(result).rejects.toMatchObject({ code: "disallowed_url" });
    expect(net.connects).toHaveLength(1);
  });

  it("follows public redirects and reports the final URL", async () => {
    const { result } = run("https://short.example/go", (target) =>
      String(target) === "https://short.example/go"
        ? new Response(null, { status: 301, headers: { Location: "/docs" } })
        : new Response("# Docs", {
            headers: { "Content-Type": "text/markdown" },
          }),
    );
    await expect(result).resolves.toMatchObject({
      url: "https://short.example/docs",
      contentType: "text/markdown",
      text: "# Docs",
      title: null,
    });
  });

  it("stops after five redirects", async () => {
    const { net, result } = run(
      "https://loop.example/0",
      (target) =>
        new Response(null, {
          status: 302,
          headers: { Location: `${target.href}x` },
        }),
    );
    await expect(result).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(net.connects).toHaveLength(6);
  });

  it("reads at most 1 MiB and at most maxChars characters", async () => {
    const big = new TextEncoder().encode(
      "a".repeat(WEB_FETCH_MAX_BYTES + 4096),
    );
    const capped = await run(
      "https://big.example/",
      () => new Response(big, { headers: { "Content-Type": "text/plain" } }),
    ).result;
    expect(capped.bytes).toBe(WEB_FETCH_MAX_BYTES);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toHaveLength(24_000);
    const short = await run(
      "https://small.example/",
      () =>
        new Response("abcdef", { headers: { "Content-Type": "text/plain" } }),
      { maxChars: 3 },
    ).result;
    expect(short).toMatchObject({ text: "abc", truncated: true, bytes: 6 });
  });

  it("times out a page that never answers", async () => {
    const { result } = run("https://slow.example/", () => null, {
      timeoutMs: 20,
    });
    await expect(result).rejects.toMatchObject({ code: "timeout" });
  });

  it("types non-2xx and binary answers", async () => {
    await expect(
      run(
        "https://gone.example/",
        () => new Response("missing", { status: 404 }),
      ).result,
    ).rejects.toMatchObject({ code: "non_2xx" });
    await expect(
      run(
        "https://img.example/cat.png",
        () =>
          new Response(new Uint8Array([137, 80]), {
            headers: { "Content-Type": "image/png" },
          }),
      ).result,
    ).rejects.toMatchObject({ code: "unsupported_content" });
  });

  it("composes one opaque web module per run lease", async () => {
    // Module names and operations are compiler-private; the native Agent
    // proof (agent-web-fetch.native.mjs) calls web.fetch through execute.
    const source = createWebSource({
      get: vi.fn(),
      search: unconfiguredWebSearch,
    });
    const lease = await source.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    });
    expect(source.id).toBe("hub-web");
    expect(lease.snapshot).toMatchObject({ version: "hub-web-v2" });
    expect(lease.snapshot.modules).toHaveLength(1);
  });
});
