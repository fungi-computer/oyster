import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  putContentObject,
  type ContentObjectBucket,
} from "@fungi.computer/oyster/build-contract";
import {
  serveOysterComputerEgress,
  type OysterComputerBuildPort,
} from "../../src/standalone/computer-egress.js";

const origin = "https://oyster.test";
const livePass = `obp.build_${"a".repeat(32)}.${"b".repeat(64)}`;

/** A registry with live build jobs of `bonsai/my-app` and of the
 * `template-shed` template on this Computer. */
function liveBuild(
  events: unknown[] = [],
  templateExchanges: Request[] = [],
  bucket: ContentObjectBucket = r2Fake(new Map()),
): OysterComputerBuildPort {
  return {
    admitObject: (jobId, grant) =>
      Promise.resolve(
        jobId === "build_live" && grant === "grant"
          ? { maxObjectBytes: 8 }
          : null,
      ),
    storeObject: (object, body, mediaType) =>
      putContentObject(bucket, object, body, mediaType),
    exchangeTemplate: (repository, request) => {
      if (repository !== "template-shed")
        return Promise.resolve(new Response(null, { status: 403 }));
      templateExchanges.push(request);
      return Promise.resolve(new Response("pack", { status: 200 }));
    },
    gitPassFor: (target) =>
      Promise.resolve(
        target.installationId === "bonsai" && target.repository === "my-app"
          ? livePass
          : null,
      ),
    admitBuild: (jobId) =>
      Promise.resolve(jobId === "build_live" ? { credentialId: "c" } : null),
    submitCandidate: () => Promise.resolve(new Response(null, { status: 200 })),
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

const hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** R2 as the egress streams into it: a put whose body's SHA-256 is not the
 * one it names is refused and stores nothing. */
function r2Fake(objects: Map<string, Uint8Array>): ContentObjectBucket {
  return {
    head: (key) => {
      const bytes = objects.get(key);
      return Promise.resolve(
        bytes === undefined
          ? null
          : {
              size: bytes.byteLength,
              checksums: {
                sha256: Uint8Array.from(
                  hex(bytes).match(/../gu) ?? [],
                  (pair) => Number.parseInt(pair, 16),
                ).buffer,
              },
            },
      );
    },
    async put(key, value, { sha256 }) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      if (hex(bytes) !== sha256) throw new Error("Checksum mismatch");
      objects.set(key, bytes);
      return null;
    },
  };
}

async function egress(
  request: Request,
  options: { publicEgress?: string; build?: OysterComputerBuildPort } = {},
) {
  const forwarded: Request[] = [];
  const response = await serveOysterComputerEgress(request, {
    origin,
    computerId: "computer-object",
    publicEgress: options.publicEgress,
    build: options.build ?? liveBuild(),
    forward: (admitted) => {
      forwarded.push(admitted);
      return Promise.resolve(new Response("git", { status: 200 }));
    },
  });
  return { response, forwarded };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone Oyster Computer egress", () => {
  it.each([
    [
      "GET",
      "https://oyster.test/git/bonsai/storyboard.git/info/refs?service=git-upload-pack",
    ],
    [
      "GET",
      "https://oyster.test/git/bonsai/storyboard.git/info/refs?service=git-receive-pack",
    ],
    ["POST", "https://oyster.test/git/bonsai/storyboard.git/git-upload-pack"],
    ["POST", "https://oyster.test/git/bonsai/storyboard.git/git-receive-pack"],
  ])(
    "admits %s %s into the Oyster Worker with the guest's credential",
    async (method, url) => {
      const init: RequestInit = {
        method,
        headers: {
          authorization: "Bearer oyster-pass",
          cookie: "session=owner",
          "git-protocol": "version=2",
        },
      };
      if (method === "POST") init.body = "0000";
      const { response, forwarded } = await egress(new Request(url, init));
      expect(response.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      const [admitted] = forwarded;
      expect(admitted?.url).toBe(url);
      expect(admitted?.method).toBe(method);
      expect(admitted?.headers.get("authorization")).toBe("Bearer oyster-pass");
      expect(admitted?.headers.get("git-protocol")).toBe("version=2");
      expect(admitted?.headers.get("cookie")).toBeNull();
    },
  );

  it.each([
    [
      "GET",
      "https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
    ],
    ["GET", "https://example.com/"],
    [
      "GET",
      "https://git.team.internal/notes.git/info/refs?service=git-upload-pack",
    ],
    [
      "GET",
      "https://git.team.internal/git/bonsai/other-app.git/info/refs?service=git-upload-pack",
    ],
    [
      "POST",
      "https://git.team.internal/git/bonsai/my-app.git/git-receive-pack",
    ],
    ["GET", "https://oyster.test/"],
    ["GET", "https://oyster.test/api/apps"],
    ["POST", "https://oyster.test/mcp"],
    [
      "GET",
      "https://oyster.test/git/bonsai/storyboard.git/info/refs?service=other",
    ],
    ["POST", "https://oyster.test/git/bonsai/storyboard.git/info/refs"],
    [
      "GET",
      "http://oyster.test/git/bonsai/storyboard.git/info/refs?service=git-upload-pack",
    ],
    [
      "GET",
      "https://oyster.test:8443/git/bonsai/storyboard.git/info/refs?service=git-upload-pack",
    ],
    [
      "GET",
      "https://oyster.test.evil.example/git/bonsai/storyboard.git/info/refs?service=git-upload-pack",
    ],
  ])("refuses %s %s without reaching the Worker", async (method, url) => {
    const init: RequestInit = { method };
    if (method === "POST") init.body = "x";
    const { response, forwarded } = await egress(new Request(url, init));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Computer egress denied by policy");
    expect(forwarded).toHaveLength(0);
  });

  it("downloads packages anonymously on the public lane", async () => {
    const fetched: Request[] = [];
    vi.stubGlobal("fetch", (request: Request) => {
      fetched.push(request);
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "x=y" },
        }),
      );
    });
    const { response, forwarded } = await egress(
      new Request("https://registry.npmjs.org/react", {
        headers: { authorization: "Bearer guest", accept: "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(forwarded).toHaveLength(0);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.headers.get("authorization")).toBeNull();
  });

  it("closes the public lane with COMPUTER_PUBLIC_EGRESS=disabled", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("The public lane must not be reached");
    });
    const { response } = await egress(
      new Request("https://registry.npmjs.org/react"),
      { publicEgress: "disabled" },
    );
    expect(response.status).toBe(403);
  });

  it("clones a live build job's one repository with the host-held pass", async () => {
    const { response, forwarded } = await egress(
      new Request(
        "https://git.team.internal/git/bonsai/my-app.git/info/refs?service=git-upload-pack",
        { headers: { authorization: "Bearer guest-supplied" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toBe(
      "https://oyster.test/git/bonsai/my-app.git/info/refs?service=git-upload-pack",
    );
    expect(forwarded[0]?.headers.get("authorization")).toBe(
      `Bearer ${livePass}`,
    );
  });

  it.each([
    [
      "GET",
      "https://git.team.internal/template-shed.git/info/refs?service=git-upload-pack",
    ],
    ["POST", "https://git.team.internal/template-shed.git/git-upload-pack"],
  ])(
    "reads a live template job's repository through the registry: %s %s",
    async (method, url) => {
      const exchanges: Request[] = [];
      const init: RequestInit = { method };
      if (method === "POST") init.body = "0000";
      const { response, forwarded } = await egress(new Request(url, init), {
        build: liveBuild([], exchanges),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("pack");
      expect(forwarded).toHaveLength(0);
      expect(exchanges.map((request) => request.url)).toEqual([url]);
    },
  );

  it.each([
    [
      "GET",
      "https://git.team.internal/template-shed.git/info/refs?service=git-receive-pack",
    ],
    ["POST", "https://git.team.internal/template-shed.git/git-receive-pack"],
    [
      "GET",
      "https://git.team.internal/template-shed.git/info/refs?service=other",
    ],
    [
      "GET",
      "https://git.team.internal/template-inkcap.git/info/refs?service=git-upload-pack",
    ],
  ])(
    "refuses a template exchange that is a write or has no live job: %s %s",
    async (method, url) => {
      const exchanges: Request[] = [];
      const init: RequestInit = { method };
      if (method === "POST") init.body = "0000";
      const { response, forwarded } = await egress(new Request(url, init), {
        build: liveBuild([], exchanges),
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Computer egress denied by policy");
      expect(forwarded).toHaveLength(0);
      expect(exchanges).toHaveLength(0);
    },
  );

  it("takes a live build job's report and refuses any other job", async () => {
    const events: unknown[] = [];
    const build = liveBuild(events);
    const report = (jobId: string) =>
      egress(
        new Request(`https://build.team.internal/jobs/${jobId}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "succeeded" }),
        }),
        { build },
      );
    expect((await report("build_live")).response.status).toBe(204);
    expect(events).toEqual([
      {
        kind: "build-status",
        jobId: "build_live",
        credentialId: "c",
        status: "succeeded",
        detail: null,
      },
    ]);
    expect((await report("build_other")).response.status).toBe(403);
  });

  it("streams a live job's object into the content store under its digest", async () => {
    const objects = new Map<string, Uint8Array>();
    const build = liveBuild([], [], r2Fake(objects));
    const bytes = new Uint8Array(new TextEncoder().encode("asset"));
    const put = (
      body: Uint8Array<ArrayBuffer>,
      digest: string,
      headers: Record<string, string> = { "X-Team-App-Build": "grant" },
      jobId = "build_live",
    ) =>
      egress(
        new Request(
          `https://build.team.internal/jobs/${jobId}/objects/sha256-${digest}`,
          {
            method: "PUT",
            headers: {
              "Content-Length": String(body.byteLength),
              "Content-Type": "application/octet-stream",
              ...headers,
            },
            body,
          },
        ),
        { build },
      );
    expect((await put(bytes, hex(bytes))).response.status).toBe(204);
    expect(objects.get(`artifact:sha256-${hex(bytes)}`)).toEqual(bytes);
    // Write-once: the same object again is kept.
    expect((await put(bytes, hex(bytes))).response.status).toBe(204);
    // A body that is not its digest is refused by the store.
    const forged = new Uint8Array(new TextEncoder().encode("forged"));
    expect(
      (await put(forged, hex(bytes).replace(/^./u, "0"))).response.status,
    ).toBe(400);
    expect(objects.size).toBe(1);
    // Over the job's object bound, before a byte is stored.
    const large = new Uint8Array(new TextEncoder().encode("too large!"));
    expect((await put(large, hex(large))).response.status).toBe(413);
    // Another job, or no grant, is refused.
    expect(
      (
        await put(
          bytes,
          hex(bytes),
          { "X-Team-App-Build": "grant" },
          "build_other",
        )
      ).response.status,
    ).toBe(403);
    expect((await put(bytes, hex(bytes), {})).response.status).toBe(403);
    // A body without a stated length is refused before a byte moves.
    // Node's fetch requires `duplex` for a streamed body.
    const streamed: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Team-App-Build": "grant",
      },
      body: new Response(bytes).body,
      duplex: "half",
    };
    const unstated = await egress(
      new Request(
        `https://build.team.internal/jobs/build_live/objects/sha256-${hex(bytes)}`,
        streamed,
      ),
      { build },
    );
    expect(unstated.response.status).toBe(411);
    expect(objects.size).toBe(1);
  });
});
