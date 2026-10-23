/** Local native proof configuration, consumed unchanged by Wrangler and the fixture test. */
export function grantConsentConfig(root, origin) {
  return {
    name: "oyster-grant-rpc-proof",
    main: `${root}test/grant-consent.worker.fixture.ts`,
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    vars: { OYSTER_ORIGIN: origin },
    r2_buckets: [{ binding: "RELEASES", bucket_name: "proof-releases" }],
    durable_objects: {
      bindings: [
        { name: "REGISTRY", class_name: "OysterRegistry" },
        { name: "INSTANCES", class_name: "OysterInstance" },
        { name: "APPROVAL_BARRIER", class_name: "ApprovalBarrier" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: [
          "OysterRegistry",
          "OysterInstance",
          "ApprovalBarrier",
        ],
      },
    ],
  };
}
