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
        fileURLToPath(new URL(`../../${filename}`, import.meta.url).href),
        "utf8",
      ),
    ),
  );

// Published 0.4.1 (5a403046b2), 0.5.0 (b367a858bf), and 0.6.0
// (962b22496b) shipped this twelve-class oyster-v1. The CTO's live read
// confirmed oyster-contest has the same applied tag and class set.
const publishedOysterV1 = [
  "StandaloneTenants",
  "OysterMcp",
  "OysterRegistry",
  "StandaloneWorkflowRuns",
  "StandaloneInstance",
  "ComputerDO",
  "OysterKeys",
  "OysterWebhooks",
  "StandaloneAgent",
  "AgentDirectory",
  "MachineLinkDO",
  "MediaOperationDO",
];

// The published plain standalone example does not bind MachineLinkDO; it is
// not the live twelve-class oyster-contest Worker.
const configs = [
  { path: "deploy/wrangler.jsonc", machineLink: true },
  { path: "deploy/wrangler.celld.jsonc", machineLink: true },
  { path: "deploy/wrangler.contest.jsonc", machineLink: true },
  { path: "examples/standalone/wrangler.celld.jsonc", machineLink: true },
  { path: "examples/standalone/wrangler.jsonc", machineLink: false },
];

describe("standalone Durable Object migrations", () => {
  for (const { path, machineLink } of configs) {
    it(`${path} preserves applied tags and migrates every bound class`, () => {
      const { migrations, durable_objects } = read(path);
      expect(migrations).toEqual([
        {
          tag: "oyster-v1",
          new_sqlite_classes: machineLink
            ? publishedOysterV1
            : publishedOysterV1.filter((name) => name !== "MachineLinkDO"),
        },
      ]);
      const created = migrations.flatMap(
        (migration) => migration.new_sqlite_classes,
      );
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
});
