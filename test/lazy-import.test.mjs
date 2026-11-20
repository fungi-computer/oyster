import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLazily } from "../dist/lazy-import.js";

test("a lazily loaded module that fails to load names itself and keeps the cause", async () => {
  const cause = new Error("Cannot find module './host-page.js'");
  await assert.rejects(
    loadLazily(() => Promise.reject(cause), "Oyster's host page renderer"),
    (failure) => {
      assert.ok(failure instanceof Error);
      assert.equal(
        failure.message,
        "Oyster's host page renderer failed to load",
      );
      assert.equal(failure.cause, cause);
      return true;
    },
  );
});

test("a lazily loaded module that loads is returned as it is", async () => {
  const loaded = { render: () => "page" };
  assert.equal(await loadLazily(() => Promise.resolve(loaded), "x"), loaded);
});
