import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../src/standalone");
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : [],
  );

/** Admins approve App permissions like owners; standalone has no admin, so that rule is unchanged there. */
it("standalone Oyster never mints an admin principal", () => {
  const files = sources(root);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files)
    expect(readFileSync(file, "utf8"), file).not.toMatch(
      /role:\s*["']admin["']/,
    );
});
