import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// The published example is copied next to worker.ts. A monorepo-only deploy
// config cannot establish that this path works for an npm consumer.
const examplePath = fileURLToPath(
  new URL("../../examples/standalone/wrangler.celld.jsonc", import.meta.url)
    .href,
);
const configSchema = z.looseObject({
  main: z.string(),
  define: z.record(z.string(), z.string()),
  r2_buckets: z.array(
    z.object({ binding: z.string(), bucket_name: z.string() }),
  ),
});

describe("standalone Oyster on celld", () => {
  it("packages a config whose entry and defines work beside worker.ts", () => {
    const errors: ParseError[] = [];
    const config = configSchema.parse(
      parse(readFileSync(examplePath, "utf8"), errors, {
        allowTrailingComma: true,
      }),
    );
    expect(errors).toEqual([]);
    expect(config.main).toBe("worker.ts");
    expect(config.define).toEqual({
      "process.env.NODE_ENV": '"production"',
    });
    expect(config.r2_buckets).toEqual([
      { binding: "RELEASES", bucket_name: "oyster-releases" },
      { binding: "APP_ARTIFACTS", bucket_name: "oyster-media" },
    ]);
    for (const unsupported of [
      "ai",
      "artifacts",
      "browser",
      "containers",
      "images",
      "observability",
      "preview_urls",
      "workers_dev",
    ])
      expect(config).not.toHaveProperty(unsupported);
  });
});
