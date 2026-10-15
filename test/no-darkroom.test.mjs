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

test("Oyster composes a media slot without depending on Darkroom", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const dependencies of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ]) {
    assert.equal(dependencies?.["@fungi.computer/darkroom"], undefined);
  }
  for (const file of await files(new URL("../src", import.meta.url).pathname)) {
    assert.equal(
      (await readFile(file, "utf8")).includes("@fungi.computer/darkroom"),
      false,
      file,
    );
  }
});
