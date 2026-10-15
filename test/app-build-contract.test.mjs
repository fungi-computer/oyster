import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";

test("the Worker build contract cannot import Node build execution", async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL("../src/build-contract.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
    conditions: ["workerd", "worker", "browser"],
    write: false,
    metafile: true,
    treeShaking: false,
  });
  const inputs = Object.entries(result.metafile.inputs);
  assert.ok(inputs.some(([path]) => path.endsWith("build/effect.ts")));
  for (const [path, input] of inputs) {
    assert.doesNotMatch(
      path,
      /(?:local-build|definition-emission|snapshot-package-store|git-environment)\./,
    );
    for (const dependency of input.imports) {
      assert.doesNotMatch(
        dependency.path,
        /^(?:node:)?(?:fs|child_process)(?:\/|$)|^esbuild(?:\/|$)|executor/,
      );
    }
  }
});
