import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import { grantConsentConfig } from "./grant-consent-config.fixture.mjs";

const { Request } = globalThis;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers")
      return {
        url: import.meta
          .resolve("@fungi.computer/oyster/testing/workers-runtime"),
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import("./grant-consent.worker.fixture.ts");
hooks.deregister();

test("native consent config supplies the selected origin before the fixture handles login", async () => {
  const origin = "http://127.0.0.1:42137";
  const config = grantConsentConfig(
    new URL("../", import.meta.url).pathname,
    origin,
  );
  const request = new Request(`${origin}/login`);
  assert.equal(new URL(request.url).origin, origin);
  const response = await worker.fetch(request, {
    ...config.vars,
    OYSTER_OWNER_KEY: "fixture-only-owner-key-not-a-secret",
  });
  assert.equal(response.status, 200);
});
