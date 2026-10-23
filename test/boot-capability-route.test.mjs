import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { test } from "node:test";
import { TextDecoder, TextEncoder } from "node:util";
import { BOOT_CAPABILITY_HEADER } from "../dist/boot-capability.js";
import { serveBootCapability } from "../dist/boot-capability-route.js";

const origin = "https://oyster.example";
const token = Buffer.alloc(32, 0x5a).toString("base64url");
const tokenDigest = createHash("sha256").update(token).digest("hex");
const html = new TextEncoder().encode("<!doctype html><body>candidate</body>");
const digest = `sha256:${createHash("sha256").update(html).digest("hex")}`;
const lease = {
  id: "lease-fixture",
  identity: {
    appId: "app_fixture",
    releaseId: "rel_fixture",
    surfaceId: "host-boot",
  },
  base: "./",
  expiresAt: Date.now() + 20_000,
  assets: [
    {
      path: "/index.html",
      contentType: "text/html; charset=utf-8",
      artifactRef: "artifact:index",
      digest,
      byteLength: html.byteLength,
    },
  ],
};

function bucket(bytes = html, size = bytes.byteLength) {
  return {
    async get(reference) {
      return reference === "artifact:index"
        ? {
            size,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          }
        : null;
    },
  };
}

function capabilities(current = lease) {
  return {
    async resolve(digestValue) {
      return digestValue === tokenDigest ? current : null;
    },
    async issue() {
      throw new Error("not used");
    },
    revoke: () => Promise.resolve(),
  };
}

function request(path, method = "GET", capability = token) {
  const headers =
    capability === null ? {} : { [BOOT_CAPABILITY_HEADER]: capability };
  return new globalThis.Request(`${origin}${path}`, { method, headers });
}

function preflight(
  path,
  requestOrigin = "null",
  method = "GET",
  headers = BOOT_CAPABILITY_HEADER,
) {
  return new globalThis.Request(`${origin}${path}`, {
    method: "OPTIONS",
    headers: {
      origin: requestOrigin,
      "access-control-request-method": method,
      "access-control-request-headers": headers,
    },
  });
}

test("capability navigation scopes the frame, bridge, headers, and exact asset set", async () => {
  const path = `/_boot/${lease.identity.releaseId}/index.html`;
  const parent = await serveBootCapability(request(path), {
    configuredOrigin: origin,
    bucket: bucket(),
    capabilities: capabilities(),
  });
  assert.equal(parent?.status, 200);
  assert.match(
    parent?.headers.get("content-security-policy") ?? "",
    /frame-src https:\/\/oyster\.example\/_boot\/.*\/candidate\//,
  );
  assert.equal(parent?.headers.get("cache-control"), "no-store");
  assert.equal(parent?.headers.get("referrer-policy"), "no-referrer");
  const document = await parent?.text();
  assert.match(document ?? "", /src="\.\/bridge\.js"/);

  const asset = await serveBootCapability(
    request(`/_boot/${lease.identity.releaseId}/candidate/index.html`),
    {
      configuredOrigin: origin,
      bucket: bucket(),
      capabilities: capabilities(),
    },
  );
  assert.equal(asset?.status, 200);
  assert.equal(asset?.headers.get("cache-control"), "no-store");
  assert.equal(asset?.headers.get("referrer-policy"), "no-referrer");
  assert.equal(asset?.headers.get("content-length"), null);
  assert.equal(await asset?.text(), new TextDecoder().decode(html));
});

test("opaque-origin CORS is limited to the capability-header GET preflight and valid assets", async () => {
  const path = `/_boot/${lease.identity.releaseId}/candidate/index.html`;
  const store = capabilities();
  let resolutions = 0;
  const resolve = store.resolve;
  store.resolve = async (digestValue) => {
    resolutions += 1;
    return resolve(digestValue);
  };
  const options = {
    configuredOrigin: origin,
    bucket: bucket(),
    capabilities: store,
  };
  const preflightResponse = await serveBootCapability(preflight(path), options);
  assert.equal(preflightResponse?.status, 204);
  assert.equal(
    preflightResponse?.headers.get("access-control-allow-origin"),
    "null",
  );
  assert.equal(
    preflightResponse?.headers.get("access-control-allow-methods"),
    "GET",
  );
  assert.equal(
    preflightResponse?.headers.get("access-control-allow-headers"),
    BOOT_CAPABILITY_HEADER,
  );
  assert.equal(
    preflightResponse?.headers.get("access-control-allow-credentials"),
    null,
  );
  assert.equal(preflightResponse?.headers.get("cache-control"), "no-store");
  assert.equal(await preflightResponse?.text(), "");
  assert.equal(resolutions, 0, "preflight has no capability token to resolve");

  for (const candidate of [
    preflight(path, origin),
    preflight(path, "null", "POST"),
    preflight(path, "null", "GET", `${BOOT_CAPABILITY_HEADER}, authorization`),
    preflight(`/_boot/${lease.identity.releaseId}/bridge.js`),
  ]) {
    const refused = await serveBootCapability(candidate, options);
    assert.equal(refused?.status, 404);
    assert.equal(refused?.headers.get("access-control-allow-origin"), null);
  }

  const asset = await serveBootCapability(
    new globalThis.Request(`${origin}${path}`, {
      headers: { [BOOT_CAPABILITY_HEADER]: token, origin: "null" },
    }),
    options,
  );
  assert.equal(asset?.status, 200);
  assert.equal(asset?.headers.get("access-control-allow-origin"), "null");
  assert.equal(asset?.headers.get("access-control-allow-credentials"), null);
  assert.equal(asset?.headers.get("vary"), "Origin");

  const invalid = await serveBootCapability(
    new globalThis.Request(`${origin}${path}`, {
      headers: {
        [BOOT_CAPABILITY_HEADER]: Buffer.alloc(32, 0x11).toString("base64url"),
        origin: "null",
      },
    }),
    options,
  );
  assert.equal(invalid?.status, 404);
  assert.equal(invalid?.headers.get("access-control-allow-origin"), null);
});

test("unknown, expired, wrong-release paths, and traversal representations are refused", async () => {
  const unknown = await serveBootCapability(
    request(
      `/_boot/${lease.identity.releaseId}/index.html`,
      "GET",
      Buffer.alloc(32, 0x11).toString("base64url"),
    ),
    {
      configuredOrigin: origin,
      bucket: bucket(),
      capabilities: capabilities(),
    },
  );
  assert.equal(unknown?.status, 404);

  const expired = await serveBootCapability(
    request(`/_boot/${lease.identity.releaseId}/candidate/index.html`),
    {
      configuredOrigin: origin,
      bucket: bucket(),
      capabilities: capabilities({ ...lease, expiresAt: Date.now() - 1 }),
    },
  );
  assert.equal(expired?.status, 404);

  for (const path of [
    `/_boot/rel_other/candidate/old-release.js`,
    `/_boot/${lease.identity.releaseId}/candidate/%2e%2e/old-release.js`,
  ]) {
    const refused = await serveBootCapability(request(path), {
      configuredOrigin: origin,
      bucket: bucket(),
      capabilities: capabilities(),
    });
    assert.equal(refused?.status, 404);
  }
});

test("missing, wrong, revoked, expired, foreign-release, and malformed paths share the same typed 404", async () => {
  const candidates = [
    [
      request(`/_boot/${lease.identity.releaseId}/index.html`, "GET", null),
      capabilities(),
    ],
    [
      request(
        `/_boot/${lease.identity.releaseId}/index.html`,
        "GET",
        Buffer.alloc(32, 0x11).toString("base64url"),
      ),
      capabilities(),
    ],
    [
      request(`/_boot/${lease.identity.releaseId}/index.html`),
      capabilities(null),
    ],
    [
      request(`/_boot/${lease.identity.releaseId}/index.html`),
      capabilities({ ...lease, expiresAt: Date.now() - 1 }),
    ],
    [request("/_boot/rel_other/index.html"), capabilities()],
    [request("/_boot//index.html"), capabilities()],
  ];
  const responses = await Promise.all(
    candidates.map(([candidate, store]) =>
      serveBootCapability(candidate, {
        configuredOrigin: origin,
        bucket: bucket(),
        capabilities: store,
      }),
    ),
  );
  const refusals = await Promise.all(
    responses.map(async (response) => ({
      status: response?.status,
      body: await response?.text(),
      cacheControl: response?.headers.get("cache-control"),
      referrerPolicy: response?.headers.get("referrer-policy"),
    })),
  );
  assert.deepEqual(
    new Set(refusals.map((item) => item.status)),
    new Set([404]),
  );
  assert.equal(new Set(refusals.map((item) => item.body)).size, 1);
  assert.equal(new Set(refusals.map((item) => item.cacheControl)).size, 1);
  assert.equal(new Set(refusals.map((item) => item.referrerPolicy)).size, 1);
  assert.equal(refusals[0].cacheControl, "no-store");
  assert.equal(refusals[0].referrerPolicy, "no-referrer");
});

test("streaming integrity rejects tampered and truncated bytes at EOF", async () => {
  const tampered = new Uint8Array(html);
  tampered[0] ^= 1;
  for (const body of [
    bucket(tampered),
    bucket(html.subarray(0, html.byteLength - 4), html.byteLength),
  ]) {
    const response = await serveBootCapability(
      request(`/_boot/${lease.identity.releaseId}/candidate/index.html`),
      {
        configuredOrigin: origin,
        bucket: body,
        capabilities: capabilities(),
      },
    );
    assert.equal(response?.status, 200);
    await assert.rejects(response?.arrayBuffer());
  }
});

test("non-GET, query-bearing, and wrong-origin capability requests are refused", async () => {
  for (const candidate of [
    request(`/_boot/${lease.identity.releaseId}/index.html`, "POST"),
    request(`/_boot/${lease.identity.releaseId}/index.html?unexpected=1`),
    new globalThis.Request(
      `https://other.example/_boot/${lease.identity.releaseId}/index.html`,
      { headers: { [BOOT_CAPABILITY_HEADER]: token } },
    ),
  ]) {
    const response = await serveBootCapability(candidate, {
      configuredOrigin: origin,
      bucket: bucket(),
      capabilities: capabilities(),
    });
    assert.ok(response !== null);
    assert.notEqual(response.status, 200);
  }
});

test("the configured origin is https, or http only on loopback, as the boot check opens it", async () => {
  const path = `/_boot/${lease.identity.releaseId}/index.html`;
  for (const loopback of [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ]) {
    const response = await serveBootCapability(
      new globalThis.Request(loopback + path, {
        headers: { [BOOT_CAPABILITY_HEADER]: token },
      }),
      {
        configuredOrigin: loopback,
        bucket: bucket(),
        capabilities: capabilities(),
      },
    );
    assert.equal(response?.status, 200, loopback);
  }
  for (const refused of ["http://oyster.example", "http://10.0.0.1:8787"]) {
    const response = await serveBootCapability(
      new globalThis.Request(refused + path, {
        headers: { [BOOT_CAPABILITY_HEADER]: token },
      }),
      {
        configuredOrigin: refused,
        bucket: bucket(),
        capabilities: capabilities(),
      },
    );
    assert.equal(response?.status, 404, refused);
  }
});
