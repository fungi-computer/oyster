import { describe, expect, it } from "vitest";
import type { OysterAuth } from "../../src/host.js";
import type { TenantPrincipal } from "../../src/tenant.js";
import { standaloneComputerSelection } from "../../src/standalone/computer-fleet.js";

const owner: TenantPrincipal = {
  actor: { kind: "member", memberId: "owner" },
  role: "owner",
};

function fixture() {
  const reads: { memberId: string; computerId: string }[] = [];
  let currentOwner = true;
  let selected = "default-a";
  const registry = {
    selectedComputer: () => Promise.resolve(selected),
    computerFleet: (
      memberId: string,
      request: Parameters<
        Parameters<typeof standaloneComputerSelection>[0]["computerFleet"]
      >[1],
    ) => {
      if (request.operation !== "resolve")
        throw new Error("Window selection only resolves admitted context");
      reads.push({ memberId, computerId: request.computerId });
      return Promise.resolve(
        !currentOwner
          ? { error: "owner_required" }
          : request.computerId === "unknown"
            ? null
            : {
                computerId: request.computerId,
              },
      );
    },
  };
  const incoming = (principal: TenantPrincipal, computerId: string) => {
    const auth: OysterAuth = {
      resolve: () => Promise.resolve(principal),
      authenticate: () => Promise.resolve({ kind: "admitted", principal }),
    };
    const url = new URL("https://oyster.test/apps/inkcap/");
    url.searchParams.set("computerId", computerId);
    return { request: new Request(url), auth };
  };
  return {
    registry,
    incoming,
    reads,
    reassign: () => {
      currentOwner = false;
    },
    select: (computerId: string) => {
      selected = computerId;
    },
  };
}

describe("standalone window Computer admission", () => {
  it("reads A and B through the admitted owner without changing the host default", async () => {
    const f = fixture();
    const a = await standaloneComputerSelection(
      f.registry,
      f.incoming(owner, "a"),
    );
    const b = await standaloneComputerSelection(
      f.registry,
      f.incoming(owner, "b"),
    );
    f.select("default-c");
    expect([a, b]).toEqual(["a", "b"]);
    expect(f.reads).toEqual([
      { memberId: "owner", computerId: "a" },
      { memberId: "owner", computerId: "b" },
    ]);
    expect(await f.registry.selectedComputer()).toBe("default-c");
  });

  it("keeps the existing default for HTTP without a target and for non-HTTP callers", async () => {
    const f = fixture();
    expect(await standaloneComputerSelection(f.registry)).toBe("default-a");
    const incoming = f.incoming(owner, "a");
    incoming.request = new Request("https://oyster.test/apps/inkcap/");
    expect(await standaloneComputerSelection(f.registry, incoming)).toBe(
      "default-a",
    );
    expect(f.reads).toEqual([]);
  });

  it.each<TenantPrincipal>([
    { actor: { kind: "member", memberId: "member" }, role: "member" },
    { actor: { kind: "team-key", keyId: "named-key" } },
  ])(
    "does not turn a non-owner hint into fleet authority: $actor.kind",
    async (principal) => {
      const f = fixture();
      await expect(
        standaloneComputerSelection(f.registry, f.incoming(principal, "b")),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.reads).toEqual([]);
    },
  );

  it("refuses a foreign or missing Computer through owner-admitted resolution", async () => {
    const f = fixture();
    await expect(
      standaloneComputerSelection(f.registry, f.incoming(owner, "unknown")),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rechecks the current owner at the fleet boundary after credential admission", async () => {
    const f = fixture();
    f.reassign();
    await expect(
      standaloneComputerSelection(f.registry, f.incoming(owner, "b")),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses malformed selection without reading the fleet", async () => {
    const f = fixture();
    await expect(
      standaloneComputerSelection(f.registry, f.incoming(owner, "")),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.reads).toEqual([]);
  });

  it("refuses ambiguous targets instead of silently choosing the first", async () => {
    const f = fixture();
    const incoming = f.incoming(owner, "a");
    const url = new URL(incoming.request.url);
    url.searchParams.append("computerId", "b");
    incoming.request = new Request(url);
    await expect(
      standaloneComputerSelection(f.registry, incoming),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.reads).toEqual([]);
  });
});
