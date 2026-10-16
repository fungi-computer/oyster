import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const configSchema = z.object({
  durable_objects: z.object({
    bindings: z.array(z.object({ class_name: z.string() })),
  }),
  migrations: z.array(
    z.strictObject({
      tag: z.string(),
      new_sqlite_classes: z.array(z.string()),
    }),
  ),
});

const read = (filename: string) =>
  configSchema.parse(
    parse(
      readFileSync(
        fileURLToPath(
          new URL(`../../deploy/${filename}`, import.meta.url).href,
        ),
        "utf8",
      ),
    ),
  );

const filenames = [
  "wrangler.jsonc",
  "wrangler.celld.jsonc",
  "wrangler.contest.jsonc",
];

// Pre-launch history is collapsed: every standalone Worker starts fresh, so
// each config carries one initial tag that creates exactly its bound classes.
describe("standalone Durable Object migrations", () => {
  for (const filename of filenames) {
    it(`${filename} creates every bound class in one initial tag`, () => {
      const { migrations, durable_objects } = read(filename);
      expect(migrations).toHaveLength(1);
      const created = migrations[0]?.new_sqlite_classes ?? [];
      expect(new Set(created).size).toBe(created.length);
      expect([...created].sort()).toEqual(
        [
          ...new Set(
            durable_objects.bindings.map((binding) => binding.class_name),
          ),
        ].sort(),
      );
    });
  }

  it("every standalone config shares the same initial migration", () => {
    const [first, ...rest] = filenames.map((filename) => read(filename));
    for (const config of rest)
      expect(config.migrations).toEqual(first?.migrations);
  });
});
