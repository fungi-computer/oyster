import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { capabilityFixture as fixture } from "../dist/testing/index.js";
import { computerSlots } from "../dist/computer.js";

test("browser transports admit only same-origin upgrades for a current installation", async () => {
  const host = await fixture({
    capabilities: ["computer.execute"],
    adapters: [
      {
        ...computerSlots.terminal,
        permission: "computer.execute",
        routes: new Hono().get("/terminal", (context) =>
          context.json({ admitted: true }),
        ),
      },
    ],
  });
  const request = (headers = {}, installation = "capability-fixture") =>
    host.app.request(
      `https://oyster.test/computer/terminal?oysterInstallation=${installation}`,
      {
        headers: {
          Upgrade: "websocket",
          Origin: "https://oyster.test",
          ...headers,
        },
      },
    );
  assert.equal((await request()).status, 200);
  assert.equal((await request({ Origin: "https://foreign.test" })).status, 403);
  assert.equal((await request({ Origin: "null" })).status, 403);
  assert.equal((await request({ Upgrade: "" })).status, 403);
  assert.equal((await request({}, "missing")).status, 403);
  assert.equal((await request({ "x-who": "visitor" })).status, 401);
  await host.removeDeclaration();
  assert.equal((await request()).status, 403);
});

test("the terminal contract is admitted by the Release's execute permission", async () => {
  const host = await fixture({
    capabilities: ["computer.execute"],
    adapters: [
      {
        ...computerSlots.terminal,
        permission: "computer.execute",
        routes: new Hono().get("/terminal", (context) =>
          context.json({ admitted: true }),
        ),
      },
    ],
  });
  const request = () =>
    host.app.request("https://oyster.test/computer/terminal", {
      headers: { "X-Oyster-Installation": "capability-fixture" },
    });
  assert.equal((await request()).status, 200);
  assert.match(
    await (await host.page()).text(),
    /"id":"computer.terminal","version":2/u,
  );
  await host.removeDeclaration();
  assert.equal((await request()).status, 403);
  assert.match(await (await host.page()).text(), /"capabilities":\[\]/u);
});

test("ANY transport templates admit real HTTP methods and still recheck the Release", async () => {
  const host = await fixture({
    capabilities: ["agent.send"],
    adapters: [
      {
        id: "agent.send",
        permission: "agent.send",
        version: 1,
        base: "/agents/",
        routes: new Hono().all("/:agentId/sessions/*", (context) =>
          context.json({
            agent: context.req.param("agentId"),
            method: context.req.method,
          }),
        ),
        methods: {
          open: { kind: "transport", method: "ANY", path: ":agentId/sessions" },
        },
      },
    ],
  });
  const request = (method) =>
    host.app.request("https://oyster.test/agents/amber/sessions/one/messages", {
      method,
      headers: { "X-Oyster-Installation": "capability-fixture" },
    });
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await request(method);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { agent: "amber", method });
  }
  await host.removeDeclaration();
  assert.equal((await request("POST")).status, 403);
});

test("nested transport routes recheck the declaring installation", async () => {
  const host = await fixture({
    capabilities: ["agent.read"],
    adapters: [
      {
        id: "agent.read",
        permission: "agent.read",
        version: 1,
        base: "/agent-door/",
        routes: new Hono().get("/session/sessions", (context) =>
          context.json({ sessions: [] }),
        ),
        methods: {
          open: { kind: "transport", method: "GET", path: "session" },
        },
      },
    ],
  });
  const request = () =>
    host.app.request(
      "https://oyster.test/agent-door/session/sessions?agentId=amber",
      {
        headers: { "X-Oyster-Installation": "capability-fixture" },
      },
    );
  assert.equal((await request()).status, 200);
  await host.removeDeclaration();
  assert.equal((await request()).status, 403);
});

test("overlapping Agent routes use an admitted capability without widening read authority", async () => {
  const routes = new Hono().all("/:agentId/sessions", (context) =>
    context.json({ ok: true }),
  );
  const host = await fixture({
    capabilities: ["agent.read"],
    adapters: [
      {
        id: "agent.manage",
        permission: "agent.manage",
        version: 1,
        base: "/agents/",
        routes,
        methods: {
          open: { kind: "transport", method: "ANY", path: ":agentId/sessions" },
        },
      },
      {
        id: "agent.read",
        permission: "agent.read",
        version: 1,
        base: "/agents/",
        routes,
        methods: {
          open: { kind: "transport", method: "GET", path: ":agentId/sessions" },
        },
      },
    ],
  });
  const request = (method) =>
    host.app.request("https://oyster.test/agents/amber/sessions", {
      method,
      headers: { "X-Oyster-Installation": "capability-fixture" },
    });
  assert.equal((await request("GET")).status, 200);
  assert.equal((await request("POST")).status, 403);
});

test("capability routes recheck the installation's current Release declaration", async () => {
  const host = await fixture();
  const admitted = await host.request();
  assert.equal(admitted.status, 200);
  assert.deepEqual(await admitted.json(), { entries: [] });
  await host.removeDeclaration();
  assert.equal((await host.request()).status, 403);
});

test("a file read declaration cannot authorize writes on the shared files mount", async () => {
  const fileSource = {
    read: async () => new globalThis.TextEncoder().encode("draft"),
    write: async () => {
      throw new Error("Undeclared writes must not reach storage");
    },
    list: async () => {
      throw new Error("Undeclared listings must not reach storage");
    },
    mkdir: async () => {
      throw new Error("Undeclared mkdir must not reach storage");
    },
    replace: async () => {
      throw new Error("Undeclared replace must not reach storage");
    },
  };
  const host = await fixture({
    fileSource,
    capabilities: ["computer.readFile"],
  });
  const headers = { "X-Oyster-Installation": "capability-fixture" };
  const read = await host.app.request(
    "https://oyster.test/files/content?path=/draft.md",
    { headers },
  );
  assert.equal(read.status, 200);
  assert.equal(await read.text(), "draft");
  for (const [method, path] of [
    ["PUT", "content?path=/draft.md"],
    ["GET", "list?path=/"],
    ["POST", "mkdir"],
    ["POST", "replace"],
  ]) {
    assert.equal(
      (
        await host.app.request(`https://oyster.test/files/${path}`, {
          method,
          headers,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (await host.app.request("https://oyster.test/files/content?path=/draft.md"))
      .status,
    403,
  );
});

test("pages offer a capability only when declared and admitted, and never to visitors", async () => {
  const admitted = await fixture();
  assert.match(
    await (await admitted.page()).text(),
    /"capabilities":\[\{"id":"computer.list","version":1,"base":"\/probe\/","methods":\{"list":\{"kind":"json","method":"POST","path":"list"\}\}\}\]/u,
  );
  for (const options of [
    { declared: false },
    { admitted: false },
    { visitor: true },
  ]) {
    const refused = await fixture(options);
    assert.match(await (await refused.page()).text(), /"capabilities":\[\]/u);
    assert.equal((await refused.request()).status, options.visitor ? 401 : 403);
  }
});
