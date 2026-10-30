// Oyster's one authorization owner: every requirement kind, decided for
// every principal class, through a served table -- the same path every host
// route takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agent,
  agents,
  app,
  apps,
  authorityOf,
  computer,
  door,
  member,
  owner,
  publicRoute,
  reachesAgent,
  reachesComputer,
  reachesInstallation,
  appToolAccess,
  routes,
  serveDoors,
  serveHost,
  type AuthorityPorts,
} from "../src/authorization.js";
import type { OysterAuthResult } from "../src/host.js";
import type { LiveOysterKey } from "../src/keys.js";

const ownerPrincipal = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
} as const;
const memberPrincipal = {
  actor: { kind: "member", memberId: "guest" },
  role: "member",
} as const;
const agentPrincipal = {
  actor: { kind: "agent", agentId: "agent_a" },
} as const;
const keyPrincipal = (keyId: string) =>
  ({ actor: { kind: "team-key", keyId } }) as const;

// Live keys by id; "revoked" is absent, as the live port reports it.
const liveKeys = new Map<string, LiveOysterKey>(
  Object.entries({
    // Agent A and App "notes" (use), nothing else.
    scoped: {
      keyId: "scoped",
      owner: "owner",
      grantVersion: 1,
      grants: [
        {
          capability: "agents.use",
          targets: { kind: "selected", ids: ["agent_a"] },
        },
        {
          capability: "apps.use",
          targets: { kind: "selected", ids: ["notes"] },
        },
      ],
    },
    // Read-only App "notes".
    reader: {
      keyId: "reader",
      owner: "owner",
      grantVersion: 1,
      grants: [
        {
          capability: "apps.read",
          targets: { kind: "selected", ids: ["notes"] },
        },
      ],
    },
    // The Computer only.
    computer: {
      keyId: "computer",
      owner: "owner",
      grantVersion: 1,
      grants: [{ capability: "computer.use", targets: { kind: "all" } }],
    },
    // A device enrollment key: nothing else.
    enroll: {
      keyId: "enroll",
      owner: "owner",
      grantVersion: 1,
      grants: [{ capability: "machine.enroll", targets: { kind: "all" } }],
    },
  } satisfies Record<string, LiveOysterKey>),
);
const ports: AuthorityPorts = {
  liveKey: (keyId) => Promise.resolve(liveKeys.get(keyId) ?? null),
  appToolPolicy: (actor) =>
    actor.agentId === "agent_a"
      ? { level: "read", revision: "policy:1", grantedBy: "owner" }
      : null,
};

type Who =
  | "owner"
  | "member"
  | "agent"
  | "anonymous"
  | "scoped"
  | "reader"
  | "computer"
  | "enroll"
  | "revoked";
const whos: readonly Who[] = [
  "owner",
  "member",
  "agent",
  "anonymous",
  "scoped",
  "reader",
  "computer",
  "enroll",
  "revoked",
];
/** The fixture's `x-who` header, parsed against the known principal classes. */
function whoOf(header: string | undefined): Who {
  return whos.find((who) => who === header) ?? "anonymous";
}
function authenticate(who: Who): OysterAuthResult {
  switch (who) {
    case "owner":
      return { kind: "admitted", principal: ownerPrincipal };
    case "member":
      return { kind: "admitted", principal: memberPrincipal };
    case "agent":
      return { kind: "admitted", principal: agentPrincipal };
    case "anonymous":
      return { kind: "refused", status: 401 };
    default:
      return { kind: "admitted", principal: keyPrincipal(who) };
  }
}

const notes = { installationId: "notes" } as const;
const board = { installationId: "board" } as const;

await test("one decision table: who reaches which Agent, App and Computer", async () => {
  type Reach = Readonly<{
    agentA: boolean;
    agentB: boolean;
    computer: boolean;
    notesRead: boolean;
    notesUse: boolean;
    boardRead: boolean;
  }>;
  const expected = {
    owner: {
      agentA: true,
      agentB: true,
      computer: true,
      notesRead: true,
      notesUse: true,
      boardRead: true,
    },
    member: {
      agentA: false,
      agentB: false,
      computer: true,
      notesRead: true,
      notesUse: true,
      boardRead: true,
    },
    agent: {
      agentA: false,
      agentB: false,
      computer: false,
      notesRead: true,
      notesUse: false,
      boardRead: true,
    },
    scoped: {
      agentA: true,
      agentB: false,
      computer: false,
      notesRead: true,
      notesUse: true,
      boardRead: false,
    },
    reader: {
      agentA: false,
      agentB: false,
      computer: false,
      notesRead: true,
      notesUse: false,
      boardRead: false,
    },
    computer: {
      agentA: false,
      agentB: false,
      computer: true,
      notesRead: false,
      notesUse: false,
      boardRead: false,
    },
    enroll: {
      agentA: false,
      agentB: false,
      computer: false,
      notesRead: false,
      notesUse: false,
      boardRead: false,
    },
    revoked: {
      agentA: false,
      agentB: false,
      computer: false,
      notesRead: false,
      notesUse: false,
      boardRead: false,
    },
  } satisfies Record<Exclude<Who, "anonymous">, Reach>;
  // An anonymous request has no authority at all: no requirement but a
  // public route or a door admits it (asserted below).
  for (const who of whos) {
    if (who === "anonymous") continue;
    const result = authenticate(who);
    assert.equal(result.kind, "admitted", who);
    const authority = await authorityOf(result.principal, ports);
    assert.deepEqual(
      {
        agentA: reachesAgent(authority, "agent_a"),
        agentB: reachesAgent(authority, "agent_b"),
        computer: reachesComputer(authority),
        notesRead: await reachesInstallation(authority, notes, "read", ports),
        notesUse: await reachesInstallation(authority, notes, "use", ports),
        boardRead: await reachesInstallation(authority, board, "read", ports),
      },
      expected[who],
      who,
    );
  }
  // Only keys and Agents carry tool policy; the App gate decides members by role.
  const scoped = await authorityOf(keyPrincipal("scoped"), ports);
  assert.equal((await appToolAccess(scoped, "notes", ports))?.level, "write");
  assert.equal(await appToolAccess(scoped, "board", ports), null);
  const reader = await authorityOf(keyPrincipal("reader"), ports);
  assert.equal((await appToolAccess(reader, "notes", ports))?.level, "read");
  const ownerAuthority = await authorityOf(ownerPrincipal, ports);
  assert.equal(await appToolAccess(ownerAuthority, "notes", ports), null);
});

const table = routes()
  .get("/asset", publicRoute("fixture asset"), () => new Response("asset"))
  .post("/signed", door("fixture signature"), () => new Response("door"))
  .get(
    "/owner",
    owner("direct-or-app"),
    (_c, { origin }) => new Response(origin),
  )
  .get("/owner-direct", owner("direct"), () => new Response("direct"))
  .get("/member", member(), () => new Response("member"))
  .get("/app", app(), (_c, { principal }) => new Response(principal.actor.kind))
  .get("/apps", apps(), async (_c, { reaches }) =>
    Response.json([await reaches(notes), await reaches(board)]),
  )
  .all(
    "/agents/:agentId/*",
    agent(),
    (_c, { agentId }) => new Response(agentId),
  )
  .get("/agents", agents(), async (_c, { reaches }) =>
    Response.json([await reaches("agent_a"), await reaches("agent_b")]),
  )
  .get("/computer", computer(), () => new Response("computer"));

const served = serveHost(
  table,
  (request) =>
    Promise.resolve(
      authenticate(whoOf(request.headers.get("x-who") ?? undefined)),
    ),
  ports,
);
const status = async (
  who: Who,
  path: string,
  headers: Record<string, string> = {},
) =>
  (
    await served.request(`https://oyster.test${path}`, {
      method: path === "/signed" ? "POST" : "GET",
      headers: { "x-who": who, ...headers },
    })
  ).status;

await test("each requirement admits exactly its principals", async () => {
  const cases = {
    "/asset": whos,
    "/signed": whos,
    "/owner": ["owner"],
    "/owner-direct": ["owner"],
    "/member": ["owner", "member"],
    "/app": [
      "owner",
      "member",
      "agent",
      "scoped",
      "reader",
      "computer",
      "enroll",
      "revoked",
    ],
    "/apps": [
      "owner",
      "member",
      "agent",
      "scoped",
      "reader",
      "computer",
      "enroll",
      "revoked",
    ],
    "/agents/agent_a/sessions": ["owner", "scoped"],
    "/agents/agent_b/sessions": ["owner"],
    "/agents": [
      "owner",
      "member",
      "agent",
      "scoped",
      "reader",
      "computer",
      "enroll",
      "revoked",
    ],
    "/computer": ["owner", "member", "computer"],
  } satisfies Record<string, readonly Who[]>;
  for (const [path, admitted] of Object.entries(cases))
    for (const who of whos) {
      const got = await status(who, path);
      const allowed: readonly Who[] = admitted;
      if (allowed.includes(who)) assert.equal(got, 200, `${who} ${path}`);
      else
        assert.ok(
          got === 401 || got === 403,
          `${who} ${path} => ${String(got)}`,
        );
    }
});

await test("owner consent never rides an App-mediated request", async () => {
  const mediated = { "X-Oyster-Installation": "notes" };
  assert.equal(await status("owner", "/owner-direct", mediated), 403);
  const response = await served.request("https://oyster.test/owner", {
    headers: { "x-who": "owner", ...mediated },
  });
  assert.equal(await response.text(), "app");
});

await test("an anonymous request reaches only public routes and doors", async () => {
  for (const path of ["/app", "/apps", "/member", "/agents", "/computer"])
    assert.equal(await status("anonymous", path), 401, path);
  assert.equal(await status("anonymous", "/asset"), 200);
  const browser = await served.request("https://oyster.test/owner", {
    headers: { Accept: "text/html" },
  });
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get("Location"), "/login");
});

await test("collections show a key only its granted items", async () => {
  const listed = async (who: Who, path: string) =>
    (
      await served.request(`https://oyster.test${path}`, {
        headers: { "x-who": who },
      })
    ).json();
  assert.deepEqual(await listed("owner", "/agents"), [true, true]);
  assert.deepEqual(await listed("scoped", "/agents"), [true, false]);
  assert.deepEqual(await listed("revoked", "/agents"), [false, false]);
  assert.deepEqual(await listed("reader", "/apps"), [true, false]);
  assert.deepEqual(await listed("enroll", "/apps"), [false, false]);
});

await test("an undeclared route is not served, and the table names every route", async () => {
  assert.equal(await status("owner", "/undeclared"), 404);
  const declared = table.declarations();
  assert.equal(declared.length, 10);
  for (const route of declared) assert.ok(route.requirement.kind.length > 0);
  assert.deepEqual(
    declared
      .filter((route) => route.requirement.reason !== undefined)
      .map((route) => route.path),
    ["/asset", "/signed"],
  );
});

await test("a door table refuses any route that needs a principal", async () => {
  const doors = serveDoors(
    routes()
      .post("/hook", door("fixture signature"), () => new Response("hook"))
      .get("/owner", owner("direct-or-app"), () => new Response("owner")),
  );
  assert.equal(
    (await doors.request("https://oyster.test/hook", { method: "POST" }))
      .status,
    200,
  );
  assert.equal((await doors.request("https://oyster.test/owner")).status, 401);
});

await test("middleware runs only after the requirement admits", async () => {
  let ran = 0;
  const guarded = serveHost(
    routes().get(
      "/owner",
      owner("direct-or-app"),
      () => new Response("owner"),
      {
        middleware: [
          async (_context, next) => {
            ran += 1;
            await next();
          },
        ],
      },
    ),
    (request) =>
      Promise.resolve(
        authenticate(whoOf(request.headers.get("x-who") ?? undefined)),
      ),
    ports,
  );
  assert.equal(
    (
      await guarded.request("https://oyster.test/owner", {
        headers: { "x-who": "scoped" },
      })
    ).status,
    403,
  );
  assert.equal(ran, 0);
  assert.equal(
    (
      await guarded.request("https://oyster.test/owner", {
        headers: { "x-who": "owner" },
      })
    ).status,
    200,
  );
  assert.equal(ran, 1);
});

await test("a header hook adds headers to the finished response and nothing else", async () => {
  const table = routes()
    .get("/asset", publicRoute("fixture asset"), () => new Response("asset"))
    .get("/owner", owner("direct"), () => new Response("owner"));
  const seen: number[] = [];
  const served = serveHost(
    table,
    () => Promise.resolve<OysterAuthResult>({ kind: "refused", status: 401 }),
    ports,
    {
      headers: [
        (response) => {
          seen.push(response.status);
          // A view's headers are a copy: changing them changes nothing served.
          response.headers.set("X-Ignored", "yes");
          return { "X-Decorated": "yes" };
        },
      ],
    },
  );
  const asset = await served.request("https://oyster.test/asset");
  assert.equal(await asset.text(), "asset");
  assert.equal(asset.headers.get("X-Decorated"), "yes");
  assert.equal(asset.headers.get("X-Ignored"), null);
  // The hook runs after the requirement refused, on that refusal.
  const refused = await served.request("https://oyster.test/owner");
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("X-Decorated"), "yes");
  assert.deepEqual(seen, [200, 401]);
});
