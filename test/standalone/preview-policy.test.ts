import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { serveHost } from "../../src/authorization.js";
import {
  createStandalonePreview,
  previewOrigins,
  standalonePortEntryRoutes,
  standalonePreviewRequest,
  type StandalonePreviewEnv,
} from "../../src/standalone/preview.js";

const env = {
  OYSTER_ORIGIN: "https://owner.example.com",
  OYSTER_PREVIEW_DOMAIN: "preview.example.net",
};
const previewOrigin = "https://workspace-5173.preview.example.net";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture(
  bindings: StandalonePreviewEnv = env,
  computerId = "workspace",
  forward?: (request: Request) => Promise<Response>,
) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = fromNodeSqlite(database);
  storage.sql.exec(
    "CREATE TABLE computer_exposed_ports (port INTEGER PRIMARY KEY, process_id TEXT)",
  );
  storage.sql.exec(
    "INSERT INTO computer_exposed_ports VALUES (5173,NULL), (5174,NULL)",
  );
  const origins = await previewOrigins(bindings);
  if (origins === null)
    throw new Error("Fixture preview configuration rejected");
  const seen: Request[] = [];
  let owner = "owner";
  const preview = createStandalonePreview(storage, computerId, origins, {
    accept: (ownerId) => {
      if (ownerId !== "owner") throw new Error("Fixture requires owner");
    },
    isOwner: (ownerId) => Promise.resolve(ownerId === owner),
    forward: async (_port, request, accept) => {
      accept();
      seen.push(request);
      if (forward !== undefined) return forward(request);
      return new Response("export const active = true", {
        headers: {
          "Content-Type": "text/javascript",
          "Set-Cookie": "app=fixture; Secure",
        },
      });
    },
  });
  const ownsComputer = (id: string) => Promise.resolve(id === computerId);
  const fetch = async (request: Request) => {
    const result = await standalonePreviewRequest(
      request,
      bindings,
      ownsComputer,
      (_id, port, incoming) => preview.fetch(port, incoming),
    );
    if (result === null)
      throw new Error("Fixture request escaped the preview fence");
    return result;
  };
  const entry = (signedIn: boolean) =>
    serveHost(
      standalonePortEntryRoutes({
        ownsComputer,
        issue: (_id, ownerId, port) => preview.issueOwner(ownerId, port),
      }),
      () =>
        Promise.resolve(
          signedIn
            ? {
                kind: "admitted",
                principal: {
                  actor: { kind: "member", memberId: "owner" },
                  role: "owner",
                },
              }
            : { kind: "refused", status: 401 },
        ),
      { liveKey: () => Promise.resolve(null), appToolPolicy: () => null },
    );
  const setOwner = (next: string) => {
    owner = next;
  };
  return { storage, preview, fetch, seen, entry, setOwner };
}
function session(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("Oyster private port previews", () => {
  it("requires isolated hosts on a different site and fences broken configurations", async () => {
    expect(await previewOrigins(env)).toEqual({
      owner: env.OYSTER_ORIGIN,
      preview: "https://preview.example.net",
    });
    for (const domain of [
      "other.example.com",
      "preview.example.net/api",
      "preview.example.net:443",
      "localhost",
    ])
      expect(
        await previewOrigins({ ...env, OYSTER_PREVIEW_DOMAIN: domain }),
      ).toBeNull();
    for (const [owner, domain] of [
      ["https://one.account.workers.dev", "two.account.workers.dev"],
      ["https://one.project.pages.dev", "two.project.pages.dev"],
    ])
      expect(
        await previewOrigins({
          OYSTER_ORIGIN: owner,
          OYSTER_PREVIEW_DOMAIN: domain,
        }),
      ).toBeNull();
    for (const bindings of [
      { OYSTER_PREVIEW_DOMAIN: env.OYSTER_PREVIEW_DOMAIN },
      { ...env, OYSTER_ORIGIN: "broken" },
    ]) {
      const result = await standalonePreviewRequest(
        new Request(`${previewOrigin}/login`),
        bindings,
        () => Promise.resolve(true),
        () => {
          throw new Error("Must not forward");
        },
      );
      expect(result?.status).toBe(404);
    }
    expect(
      await standalonePreviewRequest(
        new Request(env.OYSTER_ORIGIN),
        env,
        () => Promise.resolve(true),
        () => {
          throw new Error("Must not forward");
        },
      ),
    ).toBeNull();
  });
  it("refuses retired shared-origin paths, including cross-Computer and Service Worker requests", async () => {
    const legacy = {
      OYSTER_ORIGIN: env.OYSTER_ORIGIN,
      OYSTER_PREVIEW_ORIGIN: "https://shared.example.net",
    };
    expect(await previewOrigins(legacy)).toBeNull();
    for (const computer of ["a", "b"]) {
      const result = await standalonePreviewRequest(
        new Request(
          `${legacy.OYSTER_PREVIEW_ORIGIN}/preview/${computer}/5173/sw.js`,
          {
            headers: {
              cookie: "__Host-fungi-port-b=fixture",
              "Service-Worker": "script",
            },
          },
        ),
        legacy,
        () => Promise.resolve(true),
        () => {
          throw new Error("Shared previews must never forward");
        },
      );
      expect(result?.status).toBe(404);
      expect(result?.headers.has("Service-Worker-Allowed")).toBe(false);
    }
  });
  it("admits the owner through entry, single-use exchange and a clean URL; serves active assets without credentials", async () => {
    const f = await fixture();
    const entryUrl = `${env.OYSTER_ORIGIN}/computers/workspace/ports/5173`;
    const document = await f.entry(false).request(entryUrl);
    expect(document.status).toBe(200);
    expect(document.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin",
    );
    expect(await document.text()).toContain('method="post"');
    expect(document.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(
      (await f.entry(false).request(entryUrl, { method: "POST" })).status,
    ).toBe(401);
    const entry = await f.entry(true).request(entryUrl, { method: "POST" });
    expect(entry.status).toBe(302);
    const connect = z.string().parse(entry.headers.get("location"));
    const exchanged = await f.fetch(new Request(connect));
    expect(exchanged.status).toBe(302);
    const clean = z.string().parse(exchanged.headers.get("location"));
    expect(new URL(clean).searchParams.has("token")).toBe(false);
    expect((await f.fetch(new Request(connect))).status).toBe(401);
    expect((await f.fetch(new Request(clean))).status).toBe(401);
    const response = await f.fetch(
      new Request(`${clean}main.js?keep=1`, {
        headers: {
          cookie: session(exchanged),
          authorization: "Bearer fixture",
          "cf-access-jwt-assertion": "fixture",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(f.seen[0]?.url).toBe("http://localhost/main.js?keep=1");
    for (const header of ["cookie", "authorization", "cf-access-jwt-assertion"])
      expect(f.seen[0]?.headers.has(header)).toBe(false);
    expect(
      (
        await f
          .entry(true)
          .request(`${env.OYSTER_ORIGIN}/computers/unknown/ports/5173`, {
            method: "POST",
          })
      ).status,
    ).toBe(404);
  });
  it("forwards admitted writes and revokes access on unexpose", async () => {
    const f = await fixture();
    const issued = await f.preview.issueOwner("owner", 5173);
    const exchange = await f.fetch(new Request(issued.previewUrl));
    const cookie = session(exchange);
    const url = `${previewOrigin}/api`;
    expect(
      (
        await f.fetch(
          new Request(url, {
            method: "POST",
            body: "fixture",
            headers: { cookie, "sec-fetch-site": "same-origin" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(await f.seen[0]?.text()).toBe("fixture");
    expect(
      (
        await f.fetch(
          new Request(url, {
            method: "POST",
            body: "fixture",
            headers: { cookie, "sec-fetch-site": "same-site" },
          }),
        )
      ).status,
    ).toBe(401);
    expect(f.seen).toHaveLength(1);
    f.storage.sql.exec("DELETE FROM computer_exposed_ports WHERE port = 5173");
    expect(
      (await f.fetch(new Request(url, { headers: { cookie } }))).status,
    ).toBe(401);
  });
  it("ends an open preview session once its member is no longer the owner", async () => {
    const f = await fixture();
    const issued = await f.preview.issueOwner("owner", 5173);
    const cookie = session(await f.fetch(new Request(issued.previewUrl)));
    const page = () =>
      f.fetch(new Request(`${previewOrigin}/page`, { headers: { cookie } }));
    expect((await page()).status).toBe(200);
    f.setOwner("successor");
    expect((await page()).status).toBe(401);
    expect(f.seen).toHaveLength(1);
  });

  it("uses stable flat hosts and keeps host sessions bound to their port", async () => {
    const bindings = {
      OYSTER_ORIGIN: env.OYSTER_ORIGIN,
      OYSTER_PREVIEW_DOMAIN: "preview.example.net",
    };
    const f = await fixture(bindings, "computer_abc123");
    const issued = await f.preview.issueOwner("owner", 5173);
    expect(new URL(issued.previewUrl).hostname).toBe(
      "computer-abc123-5173.preview.example.net",
    );
    const exchange = await f.fetch(new Request(issued.previewUrl));
    const cookie = session(exchange);
    expect(cookie.startsWith("__Host-fungi-port=")).toBe(true);
    expect(
      (
        await f.fetch(
          new Request(
            "https://computer-abc123-5173.preview.example.net/main.js",
            { headers: { cookie } },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.fetch(
          new Request("https://computer-abc123-5174.preview.example.net/", {
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(401);
    expect(f.seen[0]?.url).toBe("http://localhost/main.js");
  });
  it("rejects unknown Computers and invalid host ports without forwarding", async () => {
    const f = await fixture();
    for (const host of [
      "preview.example.net",
      "other-5173.preview.example.net",
      "workspace-0.preview.example.net",
      "workspace-65536.preview.example.net",
      "workspace-05173.preview.example.net",
      "workspace-1e3.preview.example.net",
    ])
      expect((await f.fetch(new Request(`https://${host}/`))).status).toBe(404);
    expect(f.seen).toHaveLength(0);
  });
  it("keeps WebSocket upgrades on the isolated host session-bound, credential-free and sibling-fenced", async () => {
    const f = await fixture();
    const exchange = await f.fetch(
      new Request((await f.preview.issueOwner("owner", 5173)).previewUrl),
    );
    const cookie = session(exchange);
    // Vite's HMR client owns this token; Node cannot construct a 101, so the
    // fixture's 200 stands for the service's upgrade answer.
    const socket = `${previewOrigin}/?token=vite-hmr-token`;
    const upgrade = (headers: Record<string, string>) =>
      f.fetch(
        new Request(socket, {
          headers: { upgrade: "websocket", ...headers },
        }),
      );
    const refused: Record<string, string>[] = [
      { origin: previewOrigin },
      { cookie },
      { cookie, origin: "https://workspace-5174.preview.example.net" },
      { cookie, origin: previewOrigin, referer: "https://www.example.net/" },
      { cookie, origin: "null" },
      { cookie, origin: previewOrigin, "sec-fetch-site": "same-site" },
    ];
    for (const headers of refused)
      expect((await upgrade(headers)).status, JSON.stringify(headers)).toBe(
        401,
      );
    expect(f.seen).toHaveLength(0);
    const admitted = await upgrade({
      cookie,
      origin: previewOrigin,
      referer: `${previewOrigin}/`,
      authorization: "Bearer fixture",
      "cf-access-jwt-assertion": "fixture",
    });
    expect(admitted.status).toBe(200);
    expect(admitted.headers.has("Set-Cookie")).toBe(false);
    expect(f.seen).toHaveLength(1);
    const forwarded = f.seen[0];
    expect(forwarded?.url).toBe("http://localhost/?token=vite-hmr-token");
    expect(forwarded?.headers.get("upgrade")).toBe("websocket");
    for (const header of ["cookie", "authorization", "cf-access-jwt-assertion"])
      expect(forwarded?.headers.has(header)).toBe(false);
  });
  it("uses one private-suffix site rule for configuration and the gate", async () => {
    // workers.dev is a private PSL entry: a.workers.dev and b.workers.dev are
    // separate sites to browsers, so previewOrigins accepts the pair.
    const bindings = {
      OYSTER_ORIGIN: "https://a.workers.dev",
      OYSTER_PREVIEW_DOMAIN: "b.workers.dev",
    };
    expect(await previewOrigins(bindings)).not.toBeNull();
    const f = await fixture(bindings);
    const issued = await f.preview.issueOwner("owner", 5173);
    expect(new URL(issued.previewUrl).hostname).toBe(
      "workspace-5173.b.workers.dev",
    );
    // The owner's entry redirect carries its Referer onto the token navigation.
    const exchange = await f.fetch(
      new Request(issued.previewUrl, {
        headers: {
          referer: "https://a.workers.dev/computers/workspace/ports/5173",
        },
      }),
    );
    expect(exchange.status).toBe(302);
    const cookie = session(exchange);
    const asset = (referer: string) =>
      f.fetch(
        new Request("https://workspace-5173.b.workers.dev/main.js", {
          headers: { cookie, referer },
        }),
      );
    expect((await asset("https://a.workers.dev/")).status).toBe(200);
    expect((await asset("https://workspace-5174.b.workers.dev/")).status).toBe(
      401,
    );
  });
  it("treats every host under a multi-label public suffix preview domain as one site", async () => {
    const bindings = {
      OYSTER_ORIGIN: env.OYSTER_ORIGIN,
      OYSTER_PREVIEW_DOMAIN: "preview.example.co.uk",
    };
    const f = await fixture(bindings);
    const exchange = await f.fetch(
      new Request((await f.preview.issueOwner("owner", 5173)).previewUrl),
    );
    const cookie = session(exchange);
    const asset = (headers: Record<string, string>) =>
      f.fetch(
        new Request("https://workspace-5173.preview.example.co.uk/main.js", {
          headers: { cookie, ...headers },
        }),
      );
    const siblings: Record<string, string>[] = [
      { origin: "https://workspace-5174.preview.example.co.uk" },
      { referer: "https://other-80.preview.example.co.uk/" },
      { origin: "https://www.example.co.uk" },
      { referer: "%" },
    ];
    for (const headers of siblings)
      expect((await asset(headers)).status, JSON.stringify(headers)).toBe(401);
    const admitted: Record<string, string>[] = [
      {},
      { origin: "https://workspace-5173.preview.example.co.uk" },
      { origin: "https://another.co.uk" },
      { referer: env.OYSTER_ORIGIN },
    ];
    for (const headers of admitted)
      expect((await asset(headers)).status, JSON.stringify(headers)).toBe(200);
  });
});

it("serves real Vite assets on an isolated private preview host", async () => {
  const base = "/";
  const area = fileURLToPath(
    new URL("../../../../.botanical/", import.meta.url).href,
  );
  const directory = await mkdtemp(`${area}oyster-vite-`);
  const server = await createServer({
    root: directory,
    base,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await writeFile(
      `${directory}/index.html`,
      '<html><body><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(
      `${directory}/main.js`,
      'document.body.dataset.preview = "vite-preview-proof";',
    );
    await server.listen();
    const address = z
      .object({ port: z.number() })
      .parse(server.httpServer?.address());
    const f = await fixture(env, "workspace", (request) => {
      const target = new URL(request.url);
      target.hostname = "127.0.0.1";
      target.port = String(address.port);
      return fetch(new Request(target, request), { redirect: "manual" });
    });
    const issued = await f.preview.issueOwner("owner", 5173);
    const exchange = await f.fetch(new Request(issued.previewUrl));
    expect(exchange.status).toBe(302);
    const headers = { cookie: session(exchange) };
    const url = z.string().parse(exchange.headers.get("location"));
    expect(url).toBe(`${previewOrigin}${base}`);
    const page = await f.fetch(new Request(url, { headers }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`${base}main.js`);
    expect(html).toContain(`${base}@vite/client`);
    const script = await f.fetch(new Request(`${url}main.js`, { headers }));
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("vite-preview-proof");
    const client = await f.fetch(
      new Request(`${url}@vite/client`, { headers }),
    );
    expect(client.status).toBe(200);
    await client.body?.cancel();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
