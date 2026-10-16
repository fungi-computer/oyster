import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { URL } from "node:url";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(directory, entry.name))
          : [join(directory, entry.name)],
      ),
    )
  ).flat();
}

test("Oyster's media slot composes without Darkroom; only the standalone host brings it", async () => {
  const source = new URL("../src", import.meta.url).pathname;
  const standalone = join(source, "standalone");
  const users = [];
  for (const file of await files(source))
    if ((await readFile(file, "utf8")).includes("@fungi.computer/darkroom"))
      users.push(file);
  // The slot itself, and everything else in Oyster, stays catalog-free.
  assert.deepEqual(
    users.filter((file) => !file.startsWith(`${standalone}/`)),
    [],
  );
  // The standalone host composes Darkroom's media into that slot, so it is
  // the one reason the package depends on Darkroom at all.
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.dependencies?.["@fungi.computer/darkroom"] !== undefined,
    users.length > 0,
  );
  for (const dependencies of [
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ])
    assert.equal(dependencies?.["@fungi.computer/darkroom"], undefined);
});
