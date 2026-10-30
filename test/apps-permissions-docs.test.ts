import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { expect, it } from "vitest";

it("permission-port API docs show callable methods, parameters and their guidance", async () => {
  const docs = await readFile(
    new URL("../docs/api/apps.md", import.meta.url),
    "utf8",
  );

  expect(docs).toMatch(/read\(appKey\): Promise</u);
  expect(docs).toMatch(
    /submit\(\s*appKey,\s*pins,\s*changes,?\s*\): Promise</u,
  );
  expect(docs).toMatch(/\| `appKey`\s+\| `string`/u);
  expect(docs).toMatch(/\| `pins`\s+\|/u);
  expect(docs).toMatch(/\| `changes`\s+\| readonly/u);
  const prose = docs.replace(/\s+/gu, " ");
  expect(prose).toContain(
    "Read the installation's current permissions, whether the caller can edit them, and the available resources.",
  );
  expect(prose).toContain(
    "Submit edited grants with the store generation, authority version and artifact digest. The host checks authorization and freshness before saving.",
  );
});
