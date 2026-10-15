import * as Schema from "effect/Schema";

/** How an admitted capability method is exposed to the App. */
export const capabilityMethodKindSchema = Schema.Literals([
  "json",
  "transport",
  "read",
  "write",
]);

/** The four supported capability method kinds. */
export type CapabilityMethodKind = Schema.Schema.Type<
  typeof capabilityMethodKindSchema
>;

const httpMethods = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
] as const;
/** The HTTP operation exposed by one capability method on an Oyster page. */
export const capabilityMethodSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("transport"),
    method: Schema.Literals([...httpMethods, "ANY"]),
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals(["json", "read", "write"]),
    method: Schema.Literals(httpMethods),
    path: Schema.String,
  }),
]);

/** The serializable part of a capability admitted to an installation's page. */
export const capabilityDescriptorSchema = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  base: Schema.String,
  methods: Schema.Record(Schema.String, capabilityMethodSchema),
});

/** A page descriptor carries routing, never the authority to use a capability. */
export type CapabilityDescriptor = Schema.Schema.Type<
  typeof capabilityDescriptorSchema
>;

/** A UI-only member deputy. Its operation joins the ordinary installation consent owner. */
export const appCallsDescriptor = {
  id: "apps.call",
  permission: "apps.call",
  version: 1,
  base: "/apps/",
  methods: {
    call: {
      kind: "json",
      method: "POST",
      path: ":caller/calls/:appId/:method",
    },
  },
} as const satisfies CapabilityDescriptor & { permission: "apps.call" };
