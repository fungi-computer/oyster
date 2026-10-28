import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BINDING_LIMITS,
  type BindingLimits,
  type ConversationBinding,
} from "../../src/channels/binding.js";
import { channelIds } from "../../src/channels/ids.js";
import {
  createChannelVisitors,
  visitorBearerSchema,
  type ChannelVisitors,
} from "../../src/channels/visitors.js";

const DAY_MS = 86_400_000;

function webBinding(limits?: BindingLimits): ConversationBinding {
  return {
    bindingId: channelIds.binding.generate(),
    lifecycle: "active",
    selector: {
      provider: "web",
      siteKey: channelIds.site.generate(),
      origins: ["https://example.com"],
    },
    limits,
  };
}

async function withVisitors(
  check: (
    visitors: ChannelVisitors,
    setNow: (time: number) => void,
  ) => Promise<void>,
): Promise<void> {
  const database = new DatabaseSync(":memory:");
  const owner = fromNodeSqlite(database);
  let now = 0;
  try {
    await check(
      createChannelVisitors({
        sql: owner.sql,
        transactionSync: (body) => owner.transactionSync(body),
        now: () => now,
      }),
      (time) => {
        now = time;
      },
    );
  } finally {
    database.close();
  }
}

describe("anonymous web visitor identity in the shared SQLite owner", () => {
  it("enforces the binding's new-party limit before accepting another visitor", async () => {
    await withVisitors(async (visitors) => {
      const binding = webBinding({
        ...DEFAULT_BINDING_LIMITS,
        newPartiesPerHour: 2,
      });
      if (binding.selector.provider !== "web")
        throw new Error("Expected web binding");
      expect(
        (await visitors.mint(binding, binding.selector.siteKey, "one")).kind,
      ).toBe("granted");
      expect(
        (await visitors.mint(binding, binding.selector.siteKey, "two")).kind,
      ).toBe("granted");
      expect(
        await visitors.mint(binding, binding.selector.siteKey, "three"),
      ).toEqual({ kind: "denied", reason: "new_party_limit" });
    });
  });

  it("caps a single address at ten visitors per binding per hour", async () => {
    await withVisitors(async (visitors) => {
      const binding = webBinding({
        ...DEFAULT_BINDING_LIMITS,
        newPartiesPerHour: 20,
      });
      if (binding.selector.provider !== "web")
        throw new Error("Expected web binding");
      for (let i = 0; i < 10; i++) {
        const grant = await visitors.mint(
          binding,
          binding.selector.siteKey,
          "same-address",
        );
        expect(grant.kind).toBe("granted");
      }
      expect(
        await visitors.mint(binding, binding.selector.siteKey, "same-address"),
      ).toEqual({ kind: "denied", reason: "address_limit" });
      expect(
        (
          await visitors.mint(
            binding,
            binding.selector.siteKey,
            "other-address",
          )
        ).kind,
      ).toBe("granted");
    });
  });

  it("rotates a refresh secret and revokes its entire family if reused", async () => {
    await withVisitors(async (visitors) => {
      const binding = webBinding();
      if (binding.selector.provider !== "web")
        throw new Error("Expected web binding");
      const first = await visitors.mint(
        binding,
        binding.selector.siteKey,
        "address",
      );
      if (first.kind !== "granted") throw new Error("Expected first grant");
      expect(
        visitorBearerSchema.safeParse(first.credentials.accessToken).success,
      ).toBe(true);
      expect(
        visitorBearerSchema.safeParse(first.credentials.refreshSecret).success,
      ).toBe(true);
      const second = await visitors.refresh(
        binding,
        first.credentials.refreshSecret,
      );
      if (second.kind !== "granted") throw new Error("Expected refresh grant");
      expect(second.credentials.visitorId).toBe(first.credentials.visitorId);
      expect(second.credentials.refreshSecret).not.toBe(
        first.credentials.refreshSecret,
      );
      expect(
        await visitors.authenticate(
          binding.bindingId,
          second.credentials.accessToken,
        ),
      ).toMatchObject({ visitorId: first.credentials.visitorId });
      expect(
        await visitors.refresh(binding, first.credentials.refreshSecret),
      ).toEqual({ kind: "denied", reason: "refresh_reused" });
      expect(
        await visitors.authenticate(
          binding.bindingId,
          second.credentials.accessToken,
        ),
      ).toBeNull();
      expect(
        await visitors.authenticate(
          binding.bindingId,
          first.credentials.accessToken,
        ),
      ).toBeNull();
    });
  });

  it("binds access and refresh credentials to one web binding", async () => {
    await withVisitors(async (visitors) => {
      const firstBinding = webBinding();
      const secondBinding = webBinding();
      if (
        firstBinding.selector.provider !== "web" ||
        secondBinding.selector.provider !== "web"
      )
        throw new Error("Expected web bindings");
      expect(
        await visitors.mint(
          firstBinding,
          secondBinding.selector.siteKey,
          "address",
        ),
      ).toEqual({ kind: "denied", reason: "unmapped" });
      const first = await visitors.mint(
        firstBinding,
        firstBinding.selector.siteKey,
        "address",
      );
      if (first.kind !== "granted") throw new Error("Expected grant");
      expect(
        await visitors.authenticate(
          firstBinding.bindingId,
          first.credentials.accessToken,
        ),
      ).toMatchObject({ visitorId: first.credentials.visitorId });
      expect(
        await visitors.authenticate(
          secondBinding.bindingId,
          first.credentials.accessToken,
        ),
      ).toBeNull();
      expect(
        await visitors.refresh(secondBinding, first.credentials.refreshSecret),
      ).toEqual({ kind: "denied", reason: "refresh_invalid" });
    });
  });

  it("clamps issued access and refresh tokens to the thirty-day visitor lifetime", async () => {
    await withVisitors(async (visitors, setNow) => {
      const binding = webBinding();
      if (binding.selector.provider !== "web")
        throw new Error("Expected web binding");
      const first = await visitors.mint(
        binding,
        binding.selector.siteKey,
        "address",
      );
      if (first.kind !== "granted") throw new Error("Expected first grant");
      let credentials = first.credentials;
      for (const day of [6, 12, 18, 24]) {
        setNow(day * DAY_MS);
        const refreshed = await visitors.refresh(
          binding,
          credentials.refreshSecret,
        );
        if (refreshed.kind !== "granted")
          throw new Error("Expected refresh before visitor lifetime ends");
        credentials = refreshed.credentials;
      }
      setNow(30 * DAY_MS - 30 * 60_000);
      const last = await visitors.refresh(binding, credentials.refreshSecret);
      if (last.kind !== "granted") throw new Error("Expected final refresh");
      expect(last.credentials.accessExpiresAt).toBe(30 * DAY_MS);
      setNow(30 * DAY_MS);
      expect(
        await visitors.authenticate(
          binding.bindingId,
          last.credentials.accessToken,
        ),
      ).toBeNull();
      expect(
        await visitors.refresh(binding, last.credentials.refreshSecret),
      ).toEqual({ kind: "denied", reason: "refresh_invalid" });
    });
  });
});
