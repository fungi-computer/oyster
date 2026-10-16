import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import { defineAppGill } from "@fungi.computer/agar/gills";
import { z } from "zod";

type GillFacet = { rows: SqlStorage };
export const backend = defineAppBackend<GillFacet>({
  methods: {
    entries: defineAppMethod({
      description: "Read the saved widget rows",
      effect: "read",
      requires: [],
      input: z.strictObject({ limit: z.literal(2) }),
      output: z.array(z.strictObject({ title: z.string() })),
      handler: (_input, facet) =>
        facet.rows
          .exec<{ title: string }>("SELECT title FROM saved_rows")
          .toArray(),
    }),
  },
  gills: [
    defineAppGill({
      id: "saved",
      title: "Saved rows",
      source: "entries",
      limit: 2,
      sizes: ["S", "M", "L"],
      watch: { storage: "widget-changed" },
      input: ({ limit }) => ({ limit }),
      rows: (raw) => ({
        viewId: "saved",
        title: "Saved rows",
        state: "full",
        rows: z
          .array(z.strictObject({ title: z.string() }))
          .parse(raw)
          .map((row) => ({ id: "saved-row", title: row.title })),
      }),
    }),
  ],
});
