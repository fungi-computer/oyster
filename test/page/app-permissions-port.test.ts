import { expect, it, vi } from "vitest";
import { createOysterAppPermissionsPort } from "../../src/page/app-permissions-port.js";
import { appPermissionPageSchema } from "../../src/apps/permissions.js";

it("a missing canonical permission read is unavailable, not an unconfirmed write", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 })),
  );
  try {
    expect(await createOysterAppPermissionsPort().read("retired")).toBe(
      "unavailable",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  { status: 200, expected: "accepted" },
  { status: 409, expected: "stale" },
  { status: 403, expected: "refused" },
  { status: 404, expected: "unavailable" },
  { status: 503, expected: "unconfirmed" },
])(
  "$status permission writes are $expected (server failure is not definitive refusal)",
  async ({ status, expected }) => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", http);
    try {
      const result = await createOysterAppPermissionsPort().submit(
        "probe",
        {
          storeGeneration: "generation",
          authorityVersion: 1,
          artifactDigest: appPermissionPageSchema.shape.artifactDigest.parse(
            `sha256:${"a".repeat(64)}`,
          ),
        },
        [{ capability: "agent.send", grant: null }],
      );
      expect(http).toHaveBeenCalledOnce();
      expect(result).toBe(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
