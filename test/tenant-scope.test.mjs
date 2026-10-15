const { Request } = globalThis;
import assert from "node:assert/strict";
import test from "node:test";
import * as Schema from "effect/Schema";
import { tenantIdSchema, defaultTenant } from "../src/tenant.ts";

test("tenant ids are bounded host-minted slugs without the repository separator", () => {
  const parse = Schema.decodeUnknownSync(tenantIdSchema);
  for (const value of ["default", "aa", "a-b", "a1", "z".repeat(40)]) {
    assert.equal(parse(value), value);
  }
  for (const value of [
    "",
    "a",
    "-aa",
    "aa-",
    "aa--bb",
    "Aaa",
    "a.b",
    "a/b",
    "z".repeat(41),
    null,
  ]) {
    assert.throws(() => parse(value));
  }
  assert.equal(defaultTenant, "default");
  assert.equal(parse(defaultTenant), defaultTenant);
});

test("default durable names stay byte-identical and nondefault names cannot overlap them", async () => {
  const { tenantScope } = await import("../src/tenant.ts");
  const names = (scope) => ({
    durable: ["registry", "keys", "webhooks", "git-push", "agents"].map(
      (kind) => scope.durableName(kind),
    ),
    workspace: scope.workspacePrefix,
    computer: scope.computerName("workspace"),
    repository: scope.repositoryPrefix("bonsai"),
  });
  const legacy = tenantScope(defaultTenant, "https://oyster.example");
  assert.deepEqual(names(legacy), {
    durable: ["registry", "keys", "webhooks", "git-push", "agents"],
    workspace: "workspace/",
    computer: "workspace",
    repository: "bonsai--",
  });
  const aa = tenantScope(
    Schema.decodeUnknownSync(tenantIdSchema)("aa"),
    "https://aa.oyster.example",
  );
  const bb = tenantScope(
    Schema.decodeUnknownSync(tenantIdSchema)("bb"),
    "https://bb.oyster.example",
  );
  assert.deepEqual(names(aa), {
    durable: [
      "t.aa.registry",
      "t.aa.keys",
      "t.aa.webhooks",
      "t.aa.git-push",
      "t.aa.agents",
    ],
    workspace: "tenants/aa/workspace/",
    computer: "t.aa.workspace",
    repository: "t.aa--bonsai--",
  });
  assert.deepEqual(names(bb), {
    durable: [
      "t.bb.registry",
      "t.bb.keys",
      "t.bb.webhooks",
      "t.bb.git-push",
      "t.bb.agents",
    ],
    workspace: "tenants/bb/workspace/",
    computer: "t.bb.workspace",
    repository: "t.bb--bonsai--",
  });
  assert.equal(
    legacy.computerName("configured-computer"),
    "configured-computer",
  );
  assert.equal(aa.tenantId, "aa");
  assert.equal(aa.origin, "https://aa.oyster.example");
  // The originally proposed aa--bonsai-- prefix bled into default aa's listing.
  assert.equal(
    (aa.repositoryPrefix("bonsai") + "main").startsWith(
      legacy.repositoryPrefix("aa"),
    ),
    false,
  );
  for (const installation of [
    "a--b",
    "t.aa",
    "../aa",
    "",
    "Aaa",
    "a".repeat(64),
  ]) {
    assert.throws(() => legacy.repositoryPrefix(installation));
    assert.throws(() => aa.repositoryPrefix(installation));
  }
});

test("single-tenant resolution admits only the configured origin and fails closed", async () => {
  const { singleTenant, tenantScope } = await import("../src/tenant.ts");
  const resolver = singleTenant("https://OYSTER.example:443/");
  assert.deepEqual(
    await resolver.resolve(
      new Request("https://oyster.example/apps/bonsai?tenant=aa"),
    ),
    {
      tenantId: "default",
      origin: "https://oyster.example",
    },
  );
  for (const url of [
    "https://aa.oyster.example",
    "http://oyster.example",
    "https://oyster.example:8443",
    "https://unknown.example",
  ]) {
    assert.equal(await resolver.resolve(new Request(url)), null, url);
  }
  for (const origin of [
    "not a URL",
    "ftp://oyster.example",
    "https://user:password@oyster.example",
    "https://oyster.example/path",
    "https://oyster.example/?tenant=aa",
    "https://oyster.example/#fragment",
  ]) {
    assert.throws(() => singleTenant(origin));
    assert.throws(() => tenantScope(defaultTenant, origin));
  }
});

test("implicit tenancy keeps the supplied auth and default scope only at its configured origin", async () => {
  const { implicitTenancy } = await import("../src/tenant.ts");
  let authentications = 0;
  const auth = {
    authenticate: () => {
      authentications += 1;
      return Promise.resolve({ kind: "refused", status: 403 });
    },
    login: () => Promise.resolve(new globalThis.Response("Host login")),
  };
  const tenancy = implicitTenancy("https://OYSTER.example:443/", auth);
  const request = new Request(
    "https://oyster.example/apps/notes?tenant=other",
    {
      method: "POST",
      headers: { "x-forwarded-host": "other.example", "x-tenant-id": "other" },
      body: JSON.stringify({ tenantId: "other" }),
    },
  );
  const resolved = await tenancy.resolve(request);
  assert.equal(
    authentications,
    0,
    "resolution does not authenticate the request",
  );
  assert.equal(resolved.auth, auth);
  assert.equal(resolved.scope.tenantId, defaultTenant);
  assert.equal(resolved.scope.origin, "https://oyster.example");
  assert.equal(resolved.scope.durableName("registry"), "registry");
  assert.equal(resolved.scope.workspacePrefix, "workspace/");
  assert.equal(resolved.scope.repositoryPrefix("notes"), "notes--");
  assert.deepEqual(await resolved.auth.authenticate(request), {
    kind: "refused",
    status: 403,
  });
  assert.equal(await (await resolved.auth.login(request)).text(), "Host login");
  for (const url of [
    "https://other.example",
    "https://other.oyster.example",
    "http://oyster.example",
    "https://oyster.example:8443",
  ]) {
    assert.equal(await tenancy.resolve(new Request(url)), null, url);
  }
  assert.equal(authentications, 1, "refused origins never run authentication");
  assert.throws(() => implicitTenancy("https://oyster.example/path", auth));
});
