import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { mintComputerRequestId } from "@fungi.computer/computer-contract";
import { serveHost } from "../../src/authorization.js";
import { standaloneComputerApiRoutes } from "../../src/standalone/computer-api.js";
import {
  computerApiInputs,
  computerApiInputDocument,
  computerApiOperations,
  computerApiOutputDocument,
  computerApiBodyBytes,
} from "../../src/computer-api.js";
import type { ComputerDO } from "../../src/standalone/computer.js";
import type { LiveOysterKey } from "../../src/keys.js";
import type { TenantPrincipal } from "../../src/tenant.js";

const owner: TenantPrincipal = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
};
function fixture(
  principal: TenantPrincipal | null = owner,
  key: LiveOysterKey | null = null,
) {
  const calls: {
    id: string;
    request: Parameters<ComputerDO["apiOperation"]>[1];
  }[] = [];
  const admissions: string[] = [];
  let owned = true;
  let failure = false;
  const table = standaloneComputerApiRoutes(
    () => ({
      computerFleet: (memberId, input) => {
        admissions.push(memberId);
        return Promise.resolve(
          owned &&
            input.operation === "resolve" &&
            ["a", "b"].includes(input.computerId)
            ? { computerId: input.computerId }
            : { error: "owner_required" },
        );
      },
    }),
    (id) => ({
      apiOperation: (grant, request) => {
        expect(grant.computerId).toBe(id);
        expect([...grant.actions]).toEqual([
          computerApiOperations.find((op) => op.operation === request.operation)
            ?.action,
        ]);
        expect(grant.provenance.actor).toBe("owner:owner");
        if (failure) throw new Error("synthetic-command-secret");
        calls.push({ id, request });
        return Promise.resolve({ path: "/workspace/a", bytes: 1 });
      },
    }),
  );
  const api = serveHost(
    table,
    () =>
      Promise.resolve(
        principal === null
          ? { kind: "refused", status: 401 }
          : { kind: "admitted", principal },
      ),
    { liveKey: () => Promise.resolve(key), appToolPolicy: () => null },
  );
  return {
    api,
    calls,
    admissions,
    revoke: () => {
      owned = false;
    },
    fail: () => {
      failure = true;
    },
  };
}
type ComputerApiTestInput = Readonly<Record<string, string | number>>;
/** The page's own origin: a browser sends it on every mutation. */
const origin = "https://oyster.test";
const body = (input: ComputerApiTestInput) => ({
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify(input),
});

function requestOptions(
  method: string,
  input?: ComputerApiTestInput,
): RequestInit {
  const options: RequestInit = { method };
  if (method !== "GET") options.headers = { Origin: origin };
  if (input !== undefined) Object.assign(options, body(input));
  return options;
}

describe("Computer REST admission and contract", () => {
  it("dispatches all nine operations to the requested Computer, never the UI default", async () => {
    const f = fixture();
    const cases = [
      [
        "POST",
        "/exec",
        {
          command: "printf ok",
          requestId: mintComputerRequestId(),
          timeoutMs: 600000,
        },
      ],
      [
        "POST",
        "/processes/start",
        { command: "sleep 60", requestId: "start-1" },
      ],
      ["GET", "/processes/logs?id=process&lines=10", undefined],
      ["POST", "/processes/kill", { id: "process" }],
      ["GET", "/files?path=%2Fworkspace%2Fa", undefined],
      ["PUT", "/files", { path: "/workspace/a", content: "a" }],
      ["GET", "/files/list?path=%2Fworkspace&limit=10&offset=2", undefined],
      ["DELETE", "/files?path=%2Fworkspace%2Fa", undefined],
      ["POST", "/ports", { port: 8080 }],
    ] as const;
    for (const id of ["a", "b"])
      for (const [method, path, input] of cases) {
        const response = await f.api.request(
          `https://oyster.test/api/computers/${id}${path}`,
          requestOptions(method, input),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(f.calls.at(-1)?.id).toBe(id);
      }
    expect(f.calls).toHaveLength(18);
  });
  it.each([
    null,
    { actor: { kind: "member", memberId: "member" }, role: "member" },
  ] as const)("rejects non-owners before fleet access", async (principal) => {
    const f = fixture(principal);
    expect(
      (await f.api.request("https://oyster.test/api/computers/a/files?path=/x"))
        .status,
    ).toBe(principal === null ? 401 : 403);
    expect(f.admissions).toEqual([]);
  });
  const wholeCases = [
    ["GET", "/files?path=%2Fworkspace%2Fa", undefined],
    ["PUT", "/files", { path: "/workspace/a", content: "a" }],
    ["POST", "/exec", { command: "x", requestId: mintComputerRequestId() }],
    ["POST", "/ports", { port: 8080 }],
  ] as const;
  const teamKey = { actor: { kind: "team-key", keyId: "ear-tag" } } as const;
  const everyComputer: LiveOysterKey = {
    keyId: "ear-tag",
    owner: "owner",
    grantVersion: 1,
    grants: [{ capability: "computer.use", targets: { kind: "all" } }],
  };
  const oneComputer: LiveOysterKey = {
    ...everyComputer,
    grants: [
      {
        capability: "computer.use",
        targets: { kind: "selected", ids: ["a"] },
      },
    ],
  };
  it.each([
    ["a key with no live grants", teamKey, null],
    ["a computer.use key for every Computer", teamKey, everyComputer],
    ["a computer.use key for this one Computer", teamKey, oneComputer],
    ["an Agent", { actor: { kind: "agent", agentId: "agent-a" } }, null],
  ] as const)(
    "refuses %s on every Computer route before fleet access",
    async (_name, principal, key) => {
      const f = fixture(principal, key);
      for (const [method, path, input] of wholeCases) {
        const response = await f.api.request(
          `https://oyster.test/api/computers/a${path}`,
          requestOptions(method, input),
        );
        expect(response.status).toBe(403);
      }
      expect(f.admissions).toEqual([]);
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    ["GET", "/files?path=%2Fworkspace%2F..%2Fetc%2Fhosts", undefined],
    ["GET", "/files?path=%2F..%2Fetc", undefined],
    ["GET", "/files/list?path=%2Fworkspace%2F..", undefined],
    ["DELETE", "/files?path=%2Fa%2F..%2Fb", undefined],
    ["PUT", "/files", { path: "/../etc/x", content: "x" }],
    [
      "POST",
      "/exec",
      {
        command: "ls",
        cwd: "/workspace/../etc",
        requestId: mintComputerRequestId(),
      },
    ],
    ["POST", "/processes/start", { command: "ls", cwd: "/..", requestId: "r" }],
  ] as const)(
    "rejects a '..' path segment with a typed 400: %s %s",
    async (method, path, input) => {
      const f = fixture();
      const response = await f.api.request(
        `https://oyster.test/api/computers/a${path}`,
        requestOptions(method, input),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_path" });
      expect(f.calls).toEqual([]);
    },
  );
  it("keeps names that merely contain dots and absolute paths for the owner", async () => {
    const f = fixture();
    for (const path of [
      "/etc/hosts",
      "/workspace/a..b",
      "/workspace/.hidden/...",
    ]) {
      const response = await f.api.request(
        `https://oyster.test/api/computers/a/files?path=${encodeURIComponent(path)}`,
      );
      expect(response.status).toBe(200);
    }
  });
  it("answers 413 for a body over the limit, whether declared or streamed in chunks", async () => {
    const f = fixture();
    const chunk = new TextEncoder().encode(
      `{"path":"/x","content":"${"x".repeat(computerApiBodyBytes / 2)}`,
    );
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const streamOptions = {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: stream,
      duplex: "half",
    };
    const streamed = await f.api.request(
      new Request("https://oyster.test/api/computers/a/files", streamOptions),
    );
    expect(streamed.status).toBe(413);
    const declared = await f.api.request(
      "https://oyster.test/api/computers/a/files",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "Content-Length": String(computerApiBodyBytes + 1),
        },
        body: "{}",
      },
    );
    expect(declared.status).toBe(413);
    expect(f.calls).toEqual([]);
  });
  // Every route that changes the Computer, with a valid body for it.
  const mutations = [
    ["POST", "/exec", { command: "id", requestId: mintComputerRequestId() }],
    ["POST", "/processes/start", { command: "sleep 60", requestId: "start-1" }],
    ["POST", "/processes/kill", { id: "process" }],
    ["POST", "/ports", { port: 8080 }],
    ["PUT", "/files", { path: "/workspace/a", content: "a" }],
    ["DELETE", "/files?path=%2Fworkspace%2Fa", undefined],
  ] as const;
  const call = (
    f: ReturnType<typeof fixture>,
    method: string,
    path: string,
    headers: Record<string, string>,
    payload: string | undefined,
  ) => {
    const init: RequestInit = { method, headers };
    if (payload !== undefined) init.body = payload;
    return f.api.request(`https://oyster.test/api/computers/a${path}`, init);
  };
  it.each(mutations.filter(([method]) => method !== "DELETE"))(
    "refuses a text/plain, form or multipart body on %s %s with a typed 415 before anything runs",
    async (method, path, input) => {
      // The form-encoded attack: valid JSON smuggled in a text/plain field.
      for (const type of [
        "text/plain",
        "text/plain;charset=UTF-8",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "application/jsonx",
        "",
      ]) {
        const f = fixture();
        const response = await call(
          f,
          method,
          path,
          type === ""
            ? { Origin: origin }
            : { "Content-Type": type, Origin: origin },
          JSON.stringify(input),
        );
        expect(response.status, type).toBe(415);
        expect(await response.json()).toEqual({
          error: "unsupported_media_type",
        });
        expect(f.calls, type).toEqual([]);
        expect(f.admissions, type).toEqual([]);
      }
    },
  );
  it.each(mutations)(
    "accepts a JSON body with parameters on %s %s",
    async (method, path, input) => {
      const f = fixture();
      const response = await call(
        f,
        method,
        path,
        { "Content-Type": "Application/JSON; charset=utf-8", Origin: origin },
        input === undefined ? undefined : JSON.stringify(input),
      );
      expect(response.status).toBe(200);
      expect(f.calls).toHaveLength(1);
    },
  );
  it.each(mutations)(
    "refuses a cross-origin, same-site or provenance-less %s %s with a typed 403 before anything runs",
    async (method, path, input) => {
      const json = { "Content-Type": "application/json" };
      for (const headers of [
        // A page on a sibling subdomain.
        { ...json, Origin: "https://blog.oyster.test" },
        { ...json, Origin: "https://oyster.test:8443" },
        { ...json, Origin: "null" },
        // Right origin, but the browser says the request is cross-site.
        { ...json, Origin: origin, "Sec-Fetch-Site": "cross-site" },
        // No Origin at all: a mutation must say where it came from.
        json,
      ]) {
        const f = fixture();
        const response = await call(
          f,
          method,
          path,
          headers,
          input === undefined ? undefined : JSON.stringify(input),
        );
        expect(response.status, JSON.stringify(headers)).toBe(403);
        expect(await response.json()).toEqual({ error: "cross_origin" });
        expect(f.calls).toEqual([]);
        expect(f.admissions).toEqual([]);
      }
    },
  );
  it("answers a reading route only to a same-origin or provenance-less request", async () => {
    for (const path of [
      "/files?path=%2Fworkspace%2Fa",
      "/files/list?path=%2Fworkspace",
      "/processes/logs?id=process",
    ]) {
      const f = fixture();
      const read = (headers: Record<string, string>) =>
        call(f, "GET", path, headers, undefined);
      expect((await read({})).status).toBe(200);
      expect((await read({ Origin: origin })).status).toBe(200);
      const foreign: Record<string, string>[] = [
        { Origin: "https://blog.oyster.test" },
        { "Sec-Fetch-Site": "cross-site" },
      ];
      for (const headers of foreign) {
        const refused = await read(headers);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: "cross_origin" });
      }
      expect(f.calls).toHaveLength(2);
    }
  });
  it("rejects another tenant's Computer and re-admits after body consumption", async () => {
    const f = fixture();
    expect(
      (
        await f.api.request(
          "https://oyster.test/api/computers/foreign/files?path=/x",
        )
      ).status,
    ).toBe(403);
    const stream = new ReadableStream(
      {
        pull(controller) {
          f.revoke();
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ path: "/x", content: "x" }),
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const requestOptions = {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: stream,
      duplex: "half",
    };
    const request = new Request(
      "https://oyster.test/api/computers/a/files",
      requestOptions,
    );
    expect((await f.api.request(request)).status).toBe(403);
    expect(f.calls).toEqual([]);
  });
  it.each([
    [
      "POST",
      "/exec",
      { command: "x", requestId: mintComputerRequestId(), timeoutMs: 600001 },
    ],
    [
      "POST",
      "/processes/start",
      { command: "x", requestId: "r", requestScope: "forged" },
    ],
    ["POST", "/ports", { port: 65536 }],
    ["PUT", "/files", { path: "relative", content: "x" }],
    ["GET", "/files?path=/a&path=/b", undefined],
    ["GET", "/files/list?limit=257", undefined],
    ["GET", "/processes/logs?id=x&lines=1.5", undefined],
    ["GET", "/files?path=/x&actor=owner", undefined],
  ])(
    "rejects malformed or excessive %s %s before native dispatch",
    async (method, path, input) => {
      const f = fixture();
      expect(
        (
          await f.api.request(
            `https://oyster.test/api/computers/a${path}`,
            requestOptions(method, input),
          )
        ).status,
      ).toBe(400);
      expect(f.calls).toEqual([]);
    },
  );
  it("bounds streamed bodies and does not return native error details", async () => {
    const f = fixture();
    expect(
      (
        await f.api.request("https://oyster.test/api/computers/a/files", {
          method: "PUT",
          ...body({ path: "/x", content: "x".repeat(computerApiBodyBytes) }),
        })
      ).status,
    ).toBe(413);
    f.fail();
    const response = await f.api.request(
      "https://oyster.test/api/computers/a/files?path=/x",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
  it("projects every request and response into the shared OpenAPI grammar", () => {
    for (const operation of computerApiOperations) {
      expect(computerApiInputDocument(operation.operation)).toHaveProperty(
        "type",
        "object",
      );
      expect(computerApiOutputDocument(operation)).toHaveProperty(
        "type",
        "object",
      );
    }
    expect(() =>
      Schema.decodeUnknownSync(computerApiInputs.exec, {
        onExcessProperty: "error",
      })({ command: "x", requestId: mintComputerRequestId(), secret: "no" }),
    ).toThrow();
  });
});
