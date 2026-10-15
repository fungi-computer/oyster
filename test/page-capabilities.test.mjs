import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newMessagePortRpcSession,
  RpcStub,
  RpcTarget,
} from "@fungi.computer/capnweb";
import {
  agentManage,
  agentSessionRead,
  agentSessionWrite,
  openAppAgent,
  openAppInbox,
} from "@fungi.computer/agar/agents";
import { createCapabilityRegistry } from "@fungi.computer/agar";
import { agentCapabilities } from "../dist/agents.js";
import {
  computerList,
  computerPorts,
  computerProcesses,
  computerReadFile,
  computerTerminal,
  computerWriteFile,
} from "@fungi.computer/agar/computer";
import {
  capabilityHandle,
  capabilityJsonCaller,
  registeredCapabilityHandle,
} from "../src/page/capabilities.ts";
import { pending } from "@fungi.computer/agar";
import { TerminalCapability } from "../src/page/terminal.ts";
import { computerSlots } from "../src/computer.ts";
// Use the maintained browser build, including the page/shell JSX configuration.
import { oysterAppCapabilities } from "../dist/page/mount.js";

test("Computer port and process mutations send the host wire body, not the bare argument", async (context) => {
  const sent = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({
      url,
      method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    if (url === "/computer/ports/expose")
      return globalThis.Response.json({ port: 8099, exposed: true });
    if (url === "/computer/ports/unexpose")
      return globalThis.Response.json({ port: 8099, removed: true });
    if (url === "/computer/ports")
      return globalThis.Response.json({ ports: [] });
    if (url === "/computer/processes")
      return globalThis.Response.json({ processes: [] });
    const process = {
      id: "computer_process_proof",
      command: "node server.mjs",
      port: 8099,
      cwd: null,
      state: "exited",
      exitCode: null,
      startedAt: 1,
      endedAt: 2,
      sync: "unknown",
    };
    return globalThis.Response.json(
      url === "/computer/processes/kill"
        ? { process, signalled: true }
        : { ...process, state: "running", endedAt: null },
    );
  });
  const controller = new globalThis.AbortController();
  context.after(() => controller.abort());
  const capabilities = await oysterAppCapabilities({
    config: {
      workbench: false,
      shellModuleUrl: null,
      storage: false,
      appsOpen: false,
      computerId: "workspace",
      authorityVersion: 1,
      commands: [],
      icon: null,
      roles: [],
      installationId: "shed",
      appId: "app_shed",
      releaseId: "rel_shed",
      uiUrl: "/ui/shed/",
      backendUrl: "/backend/",
      methodsUrl: "/methods/",
      capabilities: [computerSlots.ports, computerSlots.processes],
    },
    signal: controller.signal,
  });
  const handleOf = (contract) => {
    const handle = capabilities.find(({ id }) => id === contract.id)?.handle;
    assert.ok(handle);
    return contract.schema.parse(new RpcStub(handle));
  };
  const ports = handleOf(computerPorts);
  const processes = handleOf(computerProcesses);
  assert.deepEqual(await ports.list(), { ports: [] });
  assert.deepEqual(await ports.expose(8099), { port: 8099, exposed: true });
  assert.deepEqual(await ports.unexpose(8099), { port: 8099, removed: true });
  assert.deepEqual(await processes.list(), { processes: [] });
  await processes.start({ command: "node server.mjs", port: 8099 });
  assert.equal(
    (await processes.kill("computer_process_proof")).signalled,
    true,
  );
  // Exactly the bodies Hub's routes and the Computer owner parse.
  assert.deepEqual(
    sent.map(({ url, method, body }) => [url, method, body]),
    [
      ["/computer/ports", "GET", undefined],
      ["/computer/ports/expose", "POST", { port: 8099 }],
      ["/computer/ports/unexpose", "POST", { port: 8099 }],
      ["/computer/processes", "GET", undefined],
      [
        "/computer/processes/start",
        "POST",
        { command: "node server.mjs", port: 8099 },
      ],
      ["/computer/processes/kill", "POST", { id: "computer_process_proof" }],
    ],
  );
});

test("registered terminal factories bind transport access to their installation", async (context) => {
  context.mock.method(globalThis, "WebSocket", function (url) {
    return { url };
  });
  await registeredCapabilityHandle(
    {
      contract: computerTerminal,
      createHandle: (_call, transport) => {
        const socket = transport("open", {
          cols: 80,
          rows: 24,
          session: "terminal-one",
          oysterInstallation: "forged-installation",
        });
        const url = new globalThis.URL(socket.url, "https://oyster.test");
        assert.equal(url.pathname, "/computer/terminal");
        assert.equal(url.searchParams.get("oysterInstallation"), "shed");
        assert.equal(url.searchParams.get("session"), "terminal-one");
        assert.equal(url.searchParams.get("cols"), "80");
        assert.equal(url.searchParams.get("rows"), "24");
        return new RpcTarget();
      },
    },
    computerSlots.terminal,
    "shed",
  );
});

function terminalSocketFixture(context, failConnection = false) {
  const sockets = [];
  class TestSocket extends globalThis.EventTarget {
    sent = [];
    closed = false;
    readyState = 0;
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
      globalThis.queueMicrotask(() => {
        if (failConnection) this.close();
        else {
          this.readyState = 1;
          this.dispatchEvent(new globalThis.Event("open"));
        }
      });
    }
    send(data) {
      this.sent.push(data);
      this.dispatchEvent(new globalThis.MessageEvent("sent", { data }));
    }
    message(data) {
      this.dispatchEvent(new globalThis.MessageEvent("message", { data }));
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.dispatchEvent(new globalThis.Event("close"));
    }
  }
  context.mock.method(globalThis, "WebSocket", function (url) {
    return new TestSocket(url);
  });
  return sockets;
}

function terminalFixture(
  context,
  failConnection = false,
  ensureAccess = async () => ({
    computerId: "workspace",
    terminalUrl: "/computer/terminal",
  }),
) {
  const sockets = terminalSocketFixture(context, failConnection);
  return {
    sockets,
    handle: registeredCapabilityHandle(
      {
        contract: computerTerminal,
        createHandle: (_call, transport) =>
          new TerminalCapability((size) => transport("open", size), {
            terminalUrl: "/computer/terminal",
            computerId: "workspace",
            ensureAccess,
            hostWindow: globalThis,
            mountSignal: undefined,
          }),
      },
      computerSlots.terminal,
      "shed",
    ),
  };
}

test("terminal input and resize use the admitted lease instead of round trips per byte", async (context) => {
  let checks = 0;
  const expiresAt = Date.now() + 60_000;
  const access = Object.assign(
    async () => {
      checks += 1;
      return { computerId: "workspace", terminalUrl: "/computer/terminal" };
    },
    { leaseExpiresAt: () => expiresAt },
  );
  const fixture = terminalFixture(context, false, access);
  const handle = await fixture.handle;
  context.after(() => handle[Symbol.dispose]());
  const terminal = await handle.open({ cols: 80, rows: 24 });
  const writer = (await terminal.input()).getWriter();
  for (const byte of new globalThis.TextEncoder().encode(
    "abcdefghijklmnopqrst",
  ))
    await writer.write(new Uint8Array([byte]));
  await terminal.resize({ cols: 120, rows: 40 });
  assert.equal(fixture.sockets[0].sent.length, 21);
  assert.equal(
    checks,
    1,
    "One admission per connection, no RTT per keystroke or resize",
  );
});

for (const refusal of [
  "revoked",
  "release changed",
  "Computer changed",
  "terminal removed",
]) {
  test(`Oyster terminal admits once per connection and closes at lease expiry: ${refusal}`, async (context) => {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    Object.defineProperty(globalThis, "window", {
      value: globalThis,
      configurable: true,
    });
    context.after(() => {
      Reflect.deleteProperty(globalThis, "window");
    });
    const sockets = terminalSocketFixture(context);
    const config = {
      workbench: false,
      shellModuleUrl: null,
      storage: false,
      appsOpen: false,
      computerId: "workspace",
      authorityVersion: 1,
      commands: [],
      icon: null,
      roles: [],
      installationId: "shed",
      appId: "app_shed",
      releaseId: "rel_shed",
      uiUrl: "/ui/shed/",
      backendUrl: "/backend/",
      methodsUrl: "/methods/",
      capabilities: [computerSlots.terminal],
    };
    let current = config;
    let revoked = false;
    let requests = 0;
    let completeRenewal;
    const renewal = new Promise((resolve) => {
      completeRenewal = resolve;
    });
    context.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(url, "/apps/shed/");
      assert.equal(init.headers.Accept, "application/json");
      assert.equal(init.cache, "no-store");
      requests += 1;
      if (revoked) {
        await renewal;
        return new globalThis.Response(null, { status: 403 });
      }
      return globalThis.Response.json(current);
    });
    const controller = new globalThis.AbortController();
    const capabilities = await oysterAppCapabilities({
      config,
      signal: controller.signal,
    });
    const handle = capabilities.find(
      ({ id }) => id === computerTerminal.id,
    )?.handle;
    assert.ok(handle);
    context.after(() => {
      handle[Symbol.dispose]();
      controller.abort();
    });
    const terminal = await handle.open({ cols: 80, rows: 24 });
    const writer = (await terminal.input()).getWriter();
    for (const byte of new globalThis.TextEncoder().encode(
      "abcdefghijklmnopqrst",
    ))
      await writer.write(new Uint8Array([byte]));
    await terminal.resize({ cols: 42, rows: 24 });
    assert.equal(
      requests,
      1,
      "App admission must not charge a Worker RTT per byte",
    );
    context.mock.timers.tick(59_999);
    assert.equal(sockets[0].closed, false);
    if (refusal === "revoked") revoked = true;
    else if (refusal === "release changed")
      current = { ...config, releaseId: "rel_new" };
    else if (refusal === "Computer changed")
      current = { ...config, computerId: "other" };
    else current = { ...config, capabilities: [] };
    if (refusal === "Computer changed") {
      // A suspended tab may observe expiry before its idle timer runs. A
      // refused second open must not extend the original session's lease.
      context.mock.timers.setTime(61_000);
      await assert.rejects(
        handle.open({ cols: 80, rows: 24 }),
        /selected Computer changed/u,
      );
      await assert.rejects(
        writer.write(new Uint8Array([120])),
        /selected Computer changed/u,
      );
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].closed, true);
      assert.equal(sockets[0].sent.length, 21);
      return;
    }
    const reader = (await terminal.output()).getReader();
    const denied = assert.rejects(reader.read(), /denied|changed|unavailable/u);
    context.mock.timers.tick(1);
    if (revoked) {
      const inputDenied = assert.rejects(
        writer.write(new Uint8Array([120])),
        /denied/u,
      );
      const resizeDenied = assert.rejects(
        terminal.resize({ cols: 50, rows: 24 }),
        /denied/u,
      );
      assert.equal(
        sockets[0].sent.length,
        21,
        "Expired admission pauses input while renewal is pending",
      );
      const renewalRequests = requests;
      completeRenewal();
      await Promise.all([denied, inputDenied, resizeDenied]);
      assert.equal(
        renewalRequests,
        2,
        "Idle timer, input and resize share one pending admission",
      );
    }
    await denied;
    assert.equal(
      requests,
      2,
      "An idle terminal rechecks by the lease boundary",
    );
    assert.equal(sockets[0].closed, true);
    await assert.rejects(
      writer.write(new Uint8Array([120])),
      /denied|changed|unavailable/u,
    );
    assert.equal(
      sockets[0].sent.length,
      21,
      "No input is sent after revocation",
    );
  });
}

test("a terminal rechecks host access before resize and refuses revoked access", async (context) => {
  let revoked = false;
  const fixture = terminalFixture(context, false, async () => {
    if (revoked) throw new Error("permission revoked");
    return { computerId: "workspace", terminalUrl: "/computer/terminal" };
  });
  const handle = await fixture.handle;
  context.after(() => handle[Symbol.dispose]());
  const terminal = await handle.open({ cols: 80, rows: 24 });
  revoked = true;
  await assert.rejects(
    terminal.resize({ cols: 120, rows: 40 }),
    /permission revoked/u,
  );
  assert.equal(fixture.sockets[0].closed, true);
  assert.deepEqual(fixture.sockets[0].sent, []);
});

test("Agar terminal streams preserve PTY bytes, metadata, input, resize and disposal", async (context) => {
  const fixture = terminalFixture(context);
  const handle = await fixture.handle;
  const channel = new globalThis.MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, handle);
  context.after(() => {
    client[Symbol.dispose]();
    peer[Symbol.dispose]();
    channel.port1.close();
    channel.port2.close();
  });
  const terminal = await computerTerminal.schema
    .parse(client)
    .open({ cols: 80, rows: 24 });
  const socket = fixture.sockets[0];
  const information = {
    computerName: "Workspace",
    teamName: "Oyster",
    modelDoor: "Standalone",
    uptimeSeconds: 12,
    version: "0.0.0",
  };
  const pendingInformation = terminal.information();
  socket.message(JSON.stringify({ type: "ready", information }));
  assert.deepEqual(await pendingInformation, information);
  const bytes = new globalThis.TextEncoder().encode('{"type":"ready"}');
  socket.message(bytes.buffer);
  const reader = (await terminal.output()).getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  const writer = (await terminal.input()).getWriter();
  const delivered = new Promise((resolve) =>
    socket.addEventListener("sent", (event) => resolve(event.data), {
      once: true,
    }),
  );
  await writer.write(new Uint8Array([112, 119, 100, 13]));
  assert.deepEqual(await delivered, new Uint8Array([112, 119, 100, 13]));
  await terminal.resize({ cols: 120, rows: 40 });
  assert.equal(socket.sent[1], '{"type":"resize","cols":120,"rows":40}');
  handle[Symbol.dispose]();
  assert.equal(socket.closed, true);
  assert.equal((await reader.read()).done, true);
});

test("invalid terminal metadata and close both settle pending information", async (context) => {
  const fixture = terminalFixture(context);
  const handle = await fixture.handle;
  for (const invalid of [true, false]) {
    const terminal = await handle.open({ cols: 80, rows: 24 });
    const socket = fixture.sockets.at(-1);
    const rejected = assert.rejects(terminal.information());
    if (invalid)
      socket.message('{"type":"ready","information":{"uptimeSeconds":-1}}');
    else await terminal.close();
    await rejected;
    assert.equal(socket.closed, true);
  }
  handle[Symbol.dispose]();
});

test("a failed terminal handshake releases its socket", async (context) => {
  const fixture = terminalFixture(context, true);
  const handle = await fixture.handle;
  await assert.rejects(
    handle.open({ cols: 80, rows: 24 }),
    /connection closed/u,
  );
  assert.equal(fixture.sockets[0].closed, true);
  handle[Symbol.dispose]();
});

test("JSON capability methods surface Pending without polling or rewriting it", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return globalThis.Response.json(pending(2000));
  });
  const capability = new RpcStub(
    capabilityHandle(
      {
        id: "media.generation",
        version: 5,
        base: "/media/",
        methods: {
          generate: { kind: "json", method: "POST", path: "generate" },
        },
      },
      "notes",
    ),
  );
  assert.deepEqual(await capability.generate({ prompt: "A tree" }), {
    kind: "pending",
    retryAfterMs: 2000,
  });
  assert.equal(requests, 1);
});

test("path parameters cannot resolve outside the descriptor route", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new globalThis.Response("unexpected");
  });
  const capability = new RpcStub(
    capabilityHandle(
      {
        id: "agent.send",
        version: 1,
        base: "/agents/",
        methods: {
          open: { kind: "transport", method: "ANY", path: ":agentId" },
        },
      },
      "notes",
    ),
  );
  await assert.rejects(async () => await capability.open({ agentId: ".." }), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(requests, 0);
});

test("transport templates bind named input fields and ANY preserves the Fetch method", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return new globalThis.Response("accepted");
  });
  const capability = agentSessionRead.schema.parse(
    new RpcStub(
      capabilityHandle(
        {
          id: "agent.read",
          version: 1,
          base: "/agents/",
          methods: {
            open: {
              kind: "transport",
              method: "ANY",
              path: ":agentId/sessions",
            },
            openInbox: { kind: "transport", method: "GET", path: "inbox" },
          },
        },
        "notes",
      ),
    ),
  );
  const handle = await capability.open({ agentId: "amber fox", limit: 20 });
  const response = await handle.fetch(
    new globalThis.Request(
      "https://agent.invalid/session-1/messages?offset=2",
      {
        method: "POST",
        body: "hello",
      },
    ),
  );
  assert.equal(await response.text(), "accepted");
  assert.equal(
    calls[0].url,
    "/agents/amber%20fox/sessions/session-1/messages?limit=20&offset=2",
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(new globalThis.TextDecoder().decode(calls[0].body), "hello");
  await handle.close();
});

test("transport handles forward Fetch requests below their descriptor route with host-owned authority", async (context) => {
  let signal;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(input, "/agent-door/session/sessions?agentId=amber&limit=20");
    assert.equal(init.method, "GET");
    const headers = new globalThis.Headers(init.headers);
    assert.equal(headers.get("X-Oyster-Installation"), "notes");
    assert.equal(headers.get("Authorization"), null);
    assert.equal(headers.get("Accept"), "text/event-stream");
    assert.equal(init.redirect, "error");
    signal = init.signal;
    return new globalThis.Response("event: ready\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const handle = agentSessionRead.schema.parse(
    new RpcStub(
      capabilityHandle(
        {
          id: agentSessionRead.id,
          version: agentSessionRead.version,
          base: "/agent-door/",
          methods: {
            open: { kind: "transport", method: "GET", path: "session" },
            openInbox: { kind: "transport", method: "GET", path: "inbox" },
          },
        },
        "notes",
      ),
    ),
  );
  const transport = await handle.open({ agentId: "amber" });
  const response = await transport.fetch(
    new globalThis.Request(
      "https://agent-session.fungi.invalid/sessions?limit=20",
      {
        headers: {
          "X-Oyster-Installation": "forged",
          Authorization: "untrusted",
          Accept: "text/event-stream",
        },
      },
    ),
  );
  assert.equal(await response.text(), "event: ready\n\n");
  await transport.close();
  assert.equal(signal.aborted, true);
});

test("a descriptor exposes Agar list through the existing GET wire with installation authority", async (context) => {
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(input, "/files/list?path=%2Fnotes&limit=25&offset=0");
    assert.equal(init.method, "GET");
    assert.equal(
      new globalThis.Headers(init.headers).get("X-Oyster-Installation"),
      "notes",
    );
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    return globalThis.Response.json({
      path: "/notes",
      entries: [],
      nextOffset: null,
    });
  });
  const handle = computerList.schema.parse(
    new RpcStub(
      capabilityHandle(
        {
          id: computerList.id,
          version: computerList.version,
          base: "/files/",
          methods: { list: { kind: "json", method: "GET", path: "list" } },
        },
        "notes",
      ),
    ),
  );
  assert.deepEqual(
    await handle.list({ path: "/notes", limit: 25, offset: 0 }),
    {
      path: "/notes",
      entries: [],
      nextOffset: null,
    },
  );
});

test("read handles preserve streamed responses and cancel on close", async (context) => {
  let signal;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(input, "/files/content?path=%2Fdraft.md");
    assert.equal(init.method, "GET");
    assert.equal(
      new globalThis.Headers(init.headers).get("X-Oyster-Installation"),
      "notes",
    );
    signal = init.signal;
    return new globalThis.Response("draft", {
      headers: { "Content-Type": "text/plain" },
    });
  });
  const handle = computerReadFile.schema.parse(
    new RpcStub(
      capabilityHandle(
        {
          id: computerReadFile.id,
          version: computerReadFile.version,
          base: "/files/",
          methods: { open: { kind: "read", method: "GET", path: "content" } },
        },
        "notes",
      ),
    ),
  );
  const reader = await handle.open({ path: "/draft.md" });
  const response = await reader.response();
  assert.equal(await response.text(), "draft");
  assert.equal(response.headers.get("Content-Type"), "text/plain");
  assert.equal(signal.aborted, false);
  await reader.close();
  assert.equal(signal.aborted, true);
});

test("JSON methods preserve POST bodies and void mkdir responses", async (context) => {
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(input, "/files/mkdir");
    assert.equal(init.method, "POST");
    assert.equal(
      new globalThis.Headers(init.headers).get("Content-Type"),
      "application/json",
    );
    assert.equal(
      new globalThis.Headers(init.headers).get("X-Oyster-Installation"),
      "notes",
    );
    assert.deepEqual(JSON.parse(init.body), { path: "/drafts" });
    return new globalThis.Response(null, { status: 204 });
  });
  const handle = new RpcStub(
    capabilityHandle(
      {
        id: computerWriteFile.id,
        version: computerWriteFile.version,
        base: "/files/",
        methods: { mkdir: { kind: "json", method: "POST", path: "mkdir" } },
      },
      "notes",
    ),
  );
  assert.equal(await handle.mkdir({ path: "/drafts" }), undefined);
});

test("write handles send byte-exact PUT content and close aborts their transport", async (context) => {
  const bytes = new Uint8Array([0, 255, 13, 10, 42]);
  let signal;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(input, "/files/content?path=%2Fbytes.bin");
    assert.equal(init.method, "PUT");
    assert.equal(
      new globalThis.Headers(init.headers).get("X-Oyster-Installation"),
      "notes",
    );
    assert.deepEqual(new Uint8Array(init.body), bytes);
    signal = init.signal;
    return new globalThis.Response(null, { status: 204 });
  });
  const handle = computerWriteFile.schema.parse(
    new RpcStub(
      capabilityHandle(
        {
          id: computerWriteFile.id,
          version: computerWriteFile.version,
          base: "/files/",
          methods: {
            open: { kind: "write", method: "PUT", path: "content" },
            mkdir: { kind: "json", method: "POST", path: "mkdir" },
            replace: { kind: "json", method: "POST", path: "replace" },
          },
        },
        "notes",
      ),
    ),
  );
  const writer = await handle.open({ path: "/bytes.bin" });
  assert.equal(
    await writer.write(new globalThis.Blob([bytes]).stream()),
    undefined,
  );
  await writer.close();
  assert.equal(signal.aborted, true);
});

test("local JSON cancellation aborts its fetch without serializing options", async (context) => {
  const controller = new globalThis.AbortController();
  let received;
  context.mock.method(globalThis, "fetch", (url, init) => {
    received = { url, init };
    if (init.signal === undefined)
      return Promise.resolve(globalThis.Response.json({ completed: true }));
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
    });
  });
  const call = capabilityJsonCaller(
    {
      id: "computer.list",
      version: 1,
      base: "/computers/",
      methods: { describe: { kind: "json", method: "POST", path: "describe" } },
    },
    "notes",
  );
  const request = call(
    "describe",
    { name: "workspace" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(received.url, "/computers/describe");
  assert.deepEqual(JSON.parse(received.init.body), { name: "workspace" });
  assert.equal(received.init.headers.get("X-Oyster-Installation"), "notes");
});

test("registered factories adapt local JSON calls into App RPC handles", async (context) => {
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "/computers/list");
    return globalThis.Response.json({ label: "workspace" });
  });
  const descriptor = {
    id: "computer.list",
    version: 1,
    base: "/computers/",
    methods: { list: { kind: "json", method: "GET", path: "list" } },
  };
  const handle = await registeredCapabilityHandle(
    {
      contract: computerList,
      createHandle: async (call) => {
        const description = await call("list");
        class LocalHandle extends RpcTarget {
          name() {
            return description.label;
          }
        }
        return new LocalHandle();
      },
    },
    descriptor,
    "notes",
  );
  const rpc = new RpcStub(handle);
  assert.equal(await rpc.name(), "workspace");
  const call = capabilityJsonCaller(
    {
      ...descriptor,
      methods: {
        read: { kind: "read", method: "GET", path: "content" },
      },
    },
    "notes",
  );
  await assert.rejects(call("read"), { code: "INVALID_ARGUMENT" });
  await assert.rejects(call("missing"), { code: "INVALID_ARGUMENT" });
});

test("Grove read+send+manage grants create a Session through the admitted write transport", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, method: init.method });
    return globalThis.Response.json({ sessionId: "session-one" });
  });
  const registry = agentTransportRegistry([
    agentSessionRead,
    agentSessionWrite,
    agentManage,
  ]);
  const transport = await openAppAgent(registry, { agentId: "agent_one" });
  try {
    const response = await transport.fetch(`${transport.baseUrl}/sessions`, {
      method: "POST",
      body: JSON.stringify({ requestId: "grove-create-one" }),
    });
    assert.deepEqual(await response.json(), { sessionId: "session-one" });
    await transport.fetch(`${transport.baseUrl}/sessions`);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["POST", "GET"],
    );
    assert.equal(calls[0].url, "/agents/agent_one/sessions");
  } finally {
    await transport.close();
  }
});

function agentTransportRegistry(contracts) {
  const unexpected = () => {
    throw new Error("Page transport must not call the host adapter directly");
  };
  const descriptors = agentCapabilities({
    list: unexpected,
    create: unexpected,
    appToolPolicy: unexpected,
    approveAppToolPolicy: unexpected,
    fetch: unexpected,
    inbox: unexpected,
    revision: unexpected,
    visit: unexpected,
  });
  const registry = createCapabilityRegistry();
  for (const contract of contracts) {
    const descriptor = descriptors.find((item) => item.id === contract.id);
    assert.ok(descriptor);
    registry.provide(
      contract,
      contract.schema.parse(new RpcStub(capabilityHandle(descriptor, "grove"))),
    );
  }
  return registry;
}

test("Grove read+send grants record the new Session visit through the write inbox transport", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, method: init.method });
    return new globalThis.Response(null, { status: 204 });
  });
  const transport = await openAppInbox(
    agentTransportRegistry([agentSessionRead, agentSessionWrite]),
  );
  try {
    await transport.fetch(`${transport.baseUrl}/inbox`);
    await transport.fetch(`${transport.baseUrl}/inbox/visits`, {
      method: "POST",
      body: JSON.stringify({ agentId: "agent_one", sessionId: "session-one" }),
    });
    assert.deepEqual(calls, [
      { url: "/member/inbox", method: "GET" },
      { url: "/member/inbox/visits", method: "POST" },
    ]);
  } finally {
    await transport.close();
  }
});

test("read-only Agent and inbox grants never admit POST", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("No POST may reach the network");
  });
  const registry = agentTransportRegistry([agentSessionRead]);
  for (const [transport, path] of [
    [await openAppAgent(registry, { agentId: "agent_one" }), "/sessions"],
    [await openAppInbox(registry), "/inbox/visits"],
  ]) {
    try {
      await assert.rejects(
        transport.fetch(`${transport.baseUrl}${path}`, { method: "POST" }),
        { code: "CAPABILITY_DENIED" },
      );
    } finally {
      await transport.close();
    }
  }
});

test("a browser HTTP 204 visit crosses RPC without disconnecting the Agent inbox", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const bundle = await build({
    stdin: {
      contents: `
        import { newMessagePortRpcSession } from "@fungi.computer/capnweb";
        import { capabilityHandle } from "./src/page/capabilities.ts";
        import { createCapabilityRegistry } from "@fungi.computer/agar";
        import { agentSessionWrite, openAppInbox } from "@fungi.computer/agar/agents";
        const channel = new MessageChannel();
        const descriptor = {id: "agent.send", version: 1, base: "/", methods: {
          openInbox: {kind: "transport", method: "ANY", path: "member"}
        }};
        const host = newMessagePortRpcSession(channel.port1, capabilityHandle(descriptor, "grove"));
        const remote = newMessagePortRpcSession(channel.port2);
        const registry = createCapabilityRegistry();
        registry.provide(agentSessionWrite, agentSessionWrite.schema.parse(remote));
        let transport;
        try {
          transport = await openAppInbox(registry);
          const visit = await transport.fetch(transport.baseUrl + "/inbox/visits", {
            method: "POST", body: JSON.stringify({agentId:"agent_one",sessionId:"session-one"})
          });
          const inbox = await transport.fetch(transport.baseUrl + "/inbox");
          document.body.textContent = JSON.stringify({status:visit.status,bodyNull:visit.body===null,
            receipt:visit.headers.get("x-visit-receipt"),inbox:await inbox.json()});
        } catch (error) {
          document.body.textContent = JSON.stringify({error:error.message});
        } finally {
          await transport?.close();
          remote[Symbol.dispose](); host[Symbol.dispose]();
          channel.port1.close(); channel.port2.close();
        }`,
      resolveDir: new globalThis.URL("..", import.meta.url).pathname,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://oyster.test/**", async (route) => {
      const path = new globalThis.URL(route.request().url()).pathname;
      if (path === "/member/inbox/visits") {
        assert.equal(route.request().method(), "POST");
        assert.equal(
          route.request().headers()["x-oyster-installation"],
          "grove",
        );
        await route.fulfill({
          status: 204,
          headers: { "x-visit-receipt": "recorded" },
        });
      } else if (path === "/member/inbox") {
        await route.fulfill({ json: { connected: true } });
      } else {
        assert.equal(path, "/");
        await route.fulfill({
          contentType: "text/html",
          body: `<body><script type="module">${bundle.outputFiles[0].text}</script></body>`,
        });
      }
    });
    await page.goto("http://oyster.test/");
    await page.waitForFunction(() =>
      globalThis.document.body.textContent.startsWith("{"),
    );
    assert.deepEqual(JSON.parse(await page.locator("body").innerText()), {
      status: 204,
      bodyNull: true,
      receipt: "recorded",
      inbox: { connected: true },
    });
  } finally {
    await browser.close();
  }
});

test("browser typing twenty characters and resizing uses one Oyster admission request", async () => {
  const { build } = await import("esbuild");
  const { chromium } = await import("playwright");
  const config = {
    workbench: false,
    shellModuleUrl: null,
    storage: false,
    appsOpen: false,
    computerId: "workspace",
    authorityVersion: 1,
    commands: [],
    icon: null,
    roles: [],
    installationId: "shed",
    appId: "app_shed",
    releaseId: "rel_shed",
    uiUrl: "/ui/shed/",
    backendUrl: "/backend/",
    methodsUrl: "/methods/",
    capabilities: [computerSlots.terminal],
  };
  const bundle = await build({
    stdin: {
      contents: `import { oysterAppCapabilities } from "./dist/page/mount.js";
        globalThis.sent = [];
        globalThis.WebSocket = class extends EventTarget {
          static OPEN = 1;
          readyState = 0;
          constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
          send(data) { globalThis.sent.push(data); }
          close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
        };
        const config = ${JSON.stringify(config)};
        const controller = new AbortController();
        const capabilities = await oysterAppCapabilities({ config, signal: controller.signal });
        const handle = capabilities.find(({ id }) => id === "computer.terminal").handle;
        const terminal = await handle.open({ cols: 80, rows: 24 });
        const writer = (await terminal.input()).getWriter();
        globalThis.written = 0;
        globalThis.failures = [];
        document.querySelector("textarea").addEventListener("keydown", (event) => {
          if (event.key.length !== 1) return;
          writer.write(new TextEncoder().encode(event.key)).then(() => { globalThis.written += 1; },
            error => { globalThis.failures.push(String(error)); });
        });
        globalThis.resizeTerminal = () => terminal.resize({ cols: 42, rows: 24 });
        globalThis.disposeTerminal = () => { handle[Symbol.dispose](); controller.abort(); };
        globalThis.terminalReady = true;`,
      resolveDir: new globalThis.URL("..", import.meta.url).pathname,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  let admissions = 0;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://oyster.test/**", async (route) => {
      const path = new globalThis.URL(route.request().url()).pathname;
      if (path === "/apps/shed/") {
        admissions += 1;
        assert.equal(route.request().headers().accept, "application/json");
        await route.fulfill({ json: config });
      } else {
        assert.equal(path, "/");
        await route.fulfill({
          contentType: "text/html",
          body: `<textarea aria-label="Terminal input fixture"></textarea><script type="module">${bundle.outputFiles[0].text}</script>`,
        });
      }
    });
    await page.goto("http://oyster.test/");
    await page.waitForFunction(() => globalThis.terminalReady);
    await page
      .getByRole("textbox", { name: "Terminal input fixture" })
      .pressSequentially("abcdefghijklmnopqrst");
    await page.waitForFunction(() => globalThis.written === 20);
    await page.evaluate(() => globalThis.resizeTerminal());
    assert.equal(
      admissions,
      1,
      "Connect admission is shared by all twenty keystrokes and resize",
    );
    assert.deepEqual(await page.evaluate(() => globalThis.failures), []);
    assert.equal(await page.evaluate(() => globalThis.sent.length), 21);
    await page.evaluate(() => globalThis.disposeTerminal());
  } finally {
    await browser.close();
  }
});

test("the declared App-call handle sends only target method JSON through the member route", async (context) => {
  const { appsCall } = await import("@fungi.computer/agar/apps");
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return globalThis.Response.json({ text: "hello" });
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body: { dataset: {} } },
  });
  context.after(() => Reflect.deleteProperty(globalThis, "document"));
  const capabilities = await oysterAppCapabilities({
    config: {
      workbench: false,
      shellModuleUrl: null,
      storage: false,
      appsOpen: false,
      computerId: null,
      authorityVersion: 1,
      commands: [],
      icon: null,
      roles: [],
      installationId: "inkcap",
      appId: "app_inkcap",
      releaseId: "rel_inkcap",
      uiUrl: "/ui/inkcap/",
      backendUrl: "/backend/",
      methodsUrl: "/methods/",
      capabilities: [
        {
          id: "apps.call",
          version: 1,
          base: "/apps/inkcap/calls/",
          methods: {
            call: { kind: "json", method: "POST", path: ":appId/:method" },
          },
        },
      ],
    },
    signal: new globalThis.AbortController().signal,
  });
  const handle = capabilities.find(({ id }) => id === appsCall.id)?.handle;
  assert.ok(handle);
  assert.deepEqual(
    await handle.call("app_bonsai", "files.read", '{"path":"README.md"}'),
    { text: "hello" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/apps/inkcap/calls/app_bonsai/files.read");
  assert.equal(calls[0].init.body, '{"path":"README.md"}');
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.redirect, "error");
});
