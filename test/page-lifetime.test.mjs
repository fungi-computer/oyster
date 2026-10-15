import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPageLifetime } from "../src/page/lifetime.ts";

test("pagehide aborts and disposes independent child mounts once, including a late async extension", () => {
  const page = new globalThis.EventTarget();
  const lifetime = createPageLifetime(page);
  const child = new globalThis.AbortController();
  let releases = 0;
  lifetime.own(() => {
    child.abort();
    releases += 1;
  });
  page.dispatchEvent(new globalThis.Event("pagehide"));
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(child.signal.aborted, true);
  assert.equal(releases, 1);
  lifetime.dispose();
  assert.equal(releases, 1);
  let lateRelease = false;
  lifetime.own(() => {
    lateRelease = true;
  });
  assert.equal(lateRelease, true);
});
