import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { expect, it } from "vitest";
import {
  appDeclarationSchema,
  type AppApi,
} from "@fungi.computer/puffball/app";
import { parseReleaseId } from "@fungi.computer/puffball";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { release } from "./apps-fixture.js";
import {
  applyInstallationCommand,
  installationCommandSchema,
  installationSchema,
  type InstallationContext,
} from "../src/apps/installation.js";

const readShare: AppApi["methods"][string] = {
  description: "Read a published share",
  input: { type: "object" },
  output: { type: "object", properties: { bytes: { type: "string" } } },
  effect: "read",
  requires: [],
  anonymous: true,
};

function declared(methods: AppApi["methods"]) {
  return Schema.decodeUnknownSync(appDeclarationSchema)({
    capabilities: [],
    handlers: [],
    roles: [],
    api: { methods },
  });
}

it("covers anonymous method names and policy/schema identity in installer authority", async () => {
  const none = await deriveDeclaredOperations(release, declared({}), []);
  const one = await deriveDeclaredOperations(
    release,
    declared({ readShare }),
    [],
  );
  expect(one.digest).not.toBe(none.digest);
  expect(one.anonymousMethods).toEqual([
    {
      name: "readShare",
      digest:
        "sha256:6fc5950e301d39255ab48ed2139d659ec8292d74e189b811c3fea0b65f087136",
    },
  ]);
});

async function installation(
  declaration = declared({ readShare }),
  installationId = "shares",
) {
  const context: InstallationContext = {
    by: { kind: "member", memberId: "owner" },
    role: "owner",
    expectedVersion: null,
    declaration,
    declaredOperations: await deriveDeclaredOperations(
      release,
      declaration,
      [],
    ),
    now: 1000,
    identity: { installationId, instanceId: null },
  };
  const outcome = applyInstallationCommand(
    null,
    {
      kind: "install",
      release,
      releasePin: "pinned",
      grants: "declared",
    },
    context,
  );
  if (Result.isFailure(outcome)) throw new Error(outcome.failure.code);
  return {
    current: outcome.success.next,
    context: {
      ...context,
      expectedVersion: outcome.success.next.authorityVersion,
    },
  };
}

it("never treats declared capability grants or member installation as anonymous consent", async () => {
  const { current, context } = await installation();
  expect(current).toMatchObject({
    approvedAnonymousMethods: [],
    anonymousApproval: null,
  });
  const member = applyInstallationCommand(
    null,
    {
      kind: "install",
      release,
      releasePin: "pinned",
      grants: "none",
    },
    { ...context, role: "member", expectedVersion: null },
  );
  if (Result.isFailure(member)) throw new Error(member.failure.code);
  expect(member.success.next).toMatchObject({
    approvedAnonymousMethods: [],
    anonymousApproval: null,
  });
});

it("approves exact identities only through explicit matching human-owner consent", async () => {
  const { current, context } = await installation();
  const approved = applyInstallationCommand(
    current,
    installationCommandSchema.parse({
      kind: "approve-anonymous",
      methods: context.declaredOperations.anonymousMethods,
    }),
    { ...context, anonymousConsent: { memberId: "owner" } },
  );
  if (Result.isFailure(approved)) throw new Error(approved.failure.code);
  expect(approved.success.next.approvedAnonymousMethods).toEqual([
    {
      name: "readShare",
      digest:
        "sha256:6fc5950e301d39255ab48ed2139d659ec8292d74e189b811c3fea0b65f087136",
    },
  ]);
  expect(approved.success.next.anonymousApproval).toEqual({
    by: { kind: "member", memberId: "owner" },
    at: 1000,
    authorityVersion: 2,
  });
  expect(approved.success.next.approvedGrants).toEqual(current.approvedGrants);
  expect(current.approvedAnonymousMethods).toEqual([]);
});

it("refuses non-owner, Agent, key, CLI and mismatched human consent without changing approvals", async () => {
  const { current, context } = await installation();
  const command = installationCommandSchema.parse({
    kind: "approve-anonymous",
    methods: context.declaredOperations.anonymousMethods,
  });
  const callers: readonly Pick<
    InstallationContext,
    "by" | "role" | "anonymousConsent"
  >[] = [
    { by: { kind: "member", memberId: "owner" }, role: "owner" },
    {
      by: { kind: "member", memberId: "owner" },
      role: "member",
      anonymousConsent: { memberId: "owner" },
    },
    {
      by: { kind: "agent", agentId: "agent" },
      role: "owner",
      anonymousConsent: { memberId: "owner" },
    },
    {
      by: { kind: "team-key", keyId: "cli" },
      role: "owner",
      anonymousConsent: { memberId: "owner" },
    },
    {
      by: { kind: "member", memberId: "owner" },
      role: "owner",
      anonymousConsent: { memberId: "other" },
    },
  ];
  for (const caller of callers) {
    expect(
      applyInstallationCommand(current, command, { ...context, ...caller }),
    ).toEqual(Result.fail({ kind: "refused", code: "not_owner" }));
  }
  expect(current.approvedAnonymousMethods).toEqual([]);
  expect(current.anonymousApproval).toBeNull();
  expect(
    installationCommandSchema.safeParse({
      ...command,
      anonymousConsent: { memberId: "owner" },
    }).success,
  ).toBe(false);
});

it("rejects undeclared, changed and duplicated identities instead of silently approving them", async () => {
  const { current, context } = await installation();
  for (const method of [
    { name: "otherRead", digest: context.declaredOperations.digest },
    { name: "readShare", digest: context.declaredOperations.digest },
  ]) {
    const command = installationCommandSchema.parse({
      kind: "approve-anonymous",
      methods: [method],
    });
    expect(
      applyInstallationCommand(current, command, {
        ...context,
        anonymousConsent: { memberId: "owner" },
      }),
    ).toEqual(Result.fail({ kind: "refused", code: "not_declared" }));
  }
  const method = context.declaredOperations.anonymousMethods[0];
  if (method === undefined) throw new Error("Missing anonymous method");
  for (const methods of [
    [method, method],
    [
      { ...method, name: "zRead" },
      { ...method, name: "aRead" },
    ],
  ]) {
    expect(
      installationCommandSchema.safeParse({
        kind: "approve-anonymous",
        methods,
      }).success,
    ).toBe(false);
  }
});

async function approvedInstallation(declaration = declared({ readShare })) {
  const { current, context } = await installation(declaration);
  const result = applyInstallationCommand(
    current,
    installationCommandSchema.parse({
      kind: "approve-anonymous",
      methods: context.declaredOperations.anonymousMethods,
    }),
    { ...context, anonymousConsent: { memberId: "owner" } },
  );
  if (Result.isFailure(result)) throw new Error(result.failure.code);
  return {
    current: result.success.next,
    context: {
      ...context,
      expectedVersion: result.success.next.authorityVersion,
    },
  };
}

it("release selection preserves only the exact approved name and policy/schema identity", async () => {
  const { current, context } = await approvedInstallation();
  const upgraded = {
    ...release,
    releaseId: parseReleaseId("rel_upgraded"),
    artifact: {
      ...release.artifact,
      artifactDigest: context.declaredOperations.digest,
    },
  };
  const declaration = declared({ readShare, anotherRead: readShare });
  const selected = applyInstallationCommand(
    current,
    {
      kind: "select-release",
      release: upgraded,
      releasePin: "pinned",
    },
    {
      ...context,
      role: "member",
      declaration,
      declaredOperations: await deriveDeclaredOperations(
        upgraded,
        declaration,
        [],
      ),
    },
  );
  if (Result.isFailure(selected)) throw new Error(selected.failure.code);
  expect(selected.success.next.approvedAnonymousMethods).toEqual(
    current.approvedAnonymousMethods,
  );
  expect(selected.success.next.anonymousApproval).toEqual(
    current.anonymousApproval,
  );
  const changedDeclaration = declared({
    readShare: { ...readShare, output: { type: "string" } },
  });
  const changed = applyInstallationCommand(
    current,
    {
      kind: "select-release",
      release: upgraded,
      releasePin: "pinned",
    },
    {
      ...context,
      role: "member",
      declaration: changedDeclaration,
      declaredOperations: await deriveDeclaredOperations(
        upgraded,
        changedDeclaration,
        [],
      ),
    },
  );
  if (Result.isFailure(changed)) throw new Error(changed.failure.code);
  expect(changed.success.next.approvedAnonymousMethods).toEqual([]);
  expect(changed.success.next.anonymousApproval).toBeNull();
});

it("deletion clears anonymous approval without mutating the previous installation", async () => {
  const { current, context } = await approvedInstallation();
  const deleted = applyInstallationCommand(
    current,
    { kind: "set-status", status: "deleted" },
    context,
  );
  if (Result.isFailure(deleted)) throw new Error(deleted.failure.code);
  expect(deleted.success.next.approvedAnonymousMethods).toEqual([]);
  expect(deleted.success.next.anonymousApproval).toBeNull();
  expect(current.approvedAnonymousMethods).toHaveLength(1);
  expect(current.anonymousApproval).not.toBeNull();
});

it("never transfers anonymous approval to a renamed or no longer anonymous method", async () => {
  const { current, context } = await approvedInstallation();
  for (const declaration of [
    declared({ renamedRead: readShare }),
    declared({
      readShare: {
        description: readShare.description,
        input: readShare.input,
        output: readShare.output,
        effect: readShare.effect,
        requires: readShare.requires,
      },
    }),
    declared({}),
  ]) {
    const result = applyInstallationCommand(
      current,
      { kind: "select-release", release, releasePin: "pinned" },
      {
        ...context,
        declaration,
        declaredOperations: await deriveDeclaredOperations(
          release,
          declaration,
          [],
        ),
      },
    );
    if (Result.isFailure(result)) throw new Error(result.failure.code);
    expect(result.success.next.approvedAnonymousMethods).toEqual([]);
    expect(result.success.next.anonymousApproval).toBeNull();
  }
});

it("revokes explicitly and refuses approval against a stale installation snapshot", async () => {
  const { current, context } = await approvedInstallation();
  const command = installationCommandSchema.parse({
    kind: "approve-anonymous",
    methods: [],
  });
  const trustedContext = {
    ...context,
    anonymousConsent: { memberId: "owner" },
  };
  const revoked = applyInstallationCommand(current, command, trustedContext);
  if (Result.isFailure(revoked)) throw new Error(revoked.failure.code);
  expect(revoked.success.next.approvedAnonymousMethods).toEqual([]);
  expect(revoked.success.next.anonymousApproval).toBeNull();
  expect(
    applyInstallationCommand(current, command, {
      ...trustedContext,
      expectedVersion: current.authorityVersion - 1,
    }),
  ).toEqual(Result.fail({ kind: "refused", code: "stale_authority" }));
  expect(
    applyInstallationCommand(current, command, {
      ...trustedContext,
      declaredOperations: {
        ...context.declaredOperations,
        digest: release.artifact.artifactDigest,
      },
    }),
  ).toEqual(Result.fail({ kind: "refused", code: "stale_authority" }));
});

it("refuses stored anonymous authority without a matching human approval receipt", async () => {
  const { current } = await approvedInstallation();
  expect(
    installationSchema.safeParse({ ...current, anonymousApproval: null })
      .success,
  ).toBe(false);
  if (current.anonymousApproval === null) throw new Error("Missing approval");
  expect(
    installationSchema.safeParse({
      ...current,
      anonymousApproval: {
        ...current.anonymousApproval,
        by: { kind: "team-key", keyId: "cli" },
      },
    }).success,
  ).toBe(false);
  expect(
    installationSchema.safeParse({
      ...current,
      anonymousApproval: {
        ...current.anonymousApproval,
        authorityVersion: current.authorityVersion + 1,
      },
    }).success,
  ).toBe(false);
});

it("lets only an owner revoke anonymous consent without an interactive approval", async () => {
  const { current, context } = await approvedInstallation();
  const command = installationCommandSchema.parse({
    kind: "approve-anonymous",
    methods: [],
  });
  expect(
    applyInstallationCommand(current, command, { ...context, role: "member" }),
  ).toEqual(Result.fail({ kind: "refused", code: "not_owner" }));
  const revoked = applyInstallationCommand(current, command, {
    ...context,
    by: { kind: "team-key", keyId: "owner-cli" },
  });
  if (Result.isFailure(revoked)) throw new Error(revoked.failure.code);
  expect(revoked.success.next.approvedAnonymousMethods).toEqual([]);
  expect(revoked.success.next.anonymousApproval).toBeNull();
  expect(revoked.success.next.authorityVersion).toBe(
    current.authorityVersion + 1,
  );
});

it("lets an owner narrow exact approved identities without consent and preserves the human receipt", async () => {
  const { current, context } = await approvedInstallation(
    declared({ anotherRead: readShare, readShare }),
  );
  const command = installationCommandSchema.parse({
    kind: "approve-anonymous",
    methods: current.approvedAnonymousMethods.filter(
      (method) => method.name === "readShare",
    ),
  });
  const narrowed = applyInstallationCommand(current, command, {
    ...context,
    by: { kind: "team-key", keyId: "owner-cli" },
  });
  if (Result.isFailure(narrowed)) throw new Error(narrowed.failure.code);
  expect(
    narrowed.success.next.approvedAnonymousMethods.map((method) => method.name),
  ).toEqual(["readShare"]);
  expect(narrowed.success.next.anonymousApproval).toEqual(
    current.anonymousApproval,
  );
  expect(narrowed.success.next.authorityVersion).toBe(
    current.authorityVersion + 1,
  );
  expect(
    applyInstallationCommand(
      narrowed.success.next,
      {
        kind: "approve-anonymous",
        methods: current.approvedAnonymousMethods,
      },
      { ...context, expectedVersion: narrowed.success.next.authorityVersion },
    ),
  ).toEqual(Result.fail({ kind: "refused", code: "not_owner" }));
});

it("drops anonymous consent after a description-only release change", async () => {
  const { current, context } = await approvedInstallation();
  const declaration = declared({
    readShare: {
      ...readShare,
      description: "Read the shared published workflow",
    },
  });
  const selected = applyInstallationCommand(
    current,
    {
      kind: "select-release",
      release,
      releasePin: "pinned",
    },
    {
      ...context,
      declaration,
      declaredOperations: await deriveDeclaredOperations(
        release,
        declaration,
        [],
      ),
    },
  );
  if (Result.isFailure(selected)) throw new Error(selected.failure.code);
  expect(selected.success.next.approvedAnonymousMethods).toEqual([]);
  expect(selected.success.next.anonymousApproval).toBeNull();
});

it("retains an older anonymous receipt after a capability grant update", async () => {
  const { current, context } = await approvedInstallation();
  const updated = applyInstallationCommand(
    current,
    { kind: "set-grants", grants: "declared" },
    context,
  );
  if (Result.isFailure(updated)) throw new Error(updated.failure.code);
  expect(updated.success.next.authorityVersion).toBe(
    current.authorityVersion + 1,
  );
  expect(updated.success.next.anonymousApproval).toEqual(
    current.anonymousApproval,
  );
  expect(updated.success.next.anonymousApproval?.authorityVersion).toBeLessThan(
    updated.success.next.authorityVersion,
  );
  expect(installationSchema.safeParse(updated.success.next).success).toBe(true);
});

it("approves a disabled installation and refreshes explicit consent for the same set", async () => {
  const { current, context } = await installation();
  const disabled = applyInstallationCommand(
    current,
    { kind: "set-status", status: "disabled" },
    context,
  );
  if (Result.isFailure(disabled)) throw new Error(disabled.failure.code);
  const command = installationCommandSchema.parse({
    kind: "approve-anonymous",
    methods: context.declaredOperations.anonymousMethods,
  });
  const approved = applyInstallationCommand(disabled.success.next, command, {
    ...context,
    expectedVersion: disabled.success.next.authorityVersion,
    anonymousConsent: { memberId: "owner" },
    now: 2000,
  });
  if (Result.isFailure(approved)) throw new Error(approved.failure.code);
  expect(approved.success.next.status).toBe("disabled");
  expect(approved.success.next.anonymousApproval?.at).toBe(2000);
  const refreshed = applyInstallationCommand(approved.success.next, command, {
    ...context,
    expectedVersion: approved.success.next.authorityVersion,
    anonymousConsent: { memberId: "owner" },
    now: 3000,
  });
  if (Result.isFailure(refreshed)) throw new Error(refreshed.failure.code);
  expect(refreshed.success.next.status).toBe("disabled");
  expect(refreshed.success.next.approvedAnonymousMethods).toEqual(
    approved.success.next.approvedAnonymousMethods,
  );
  expect(refreshed.success.next.authorityVersion).toBe(
    approved.success.next.authorityVersion + 1,
  );
  expect(refreshed.success.next.anonymousApproval).toEqual({
    by: { kind: "member", memberId: "owner" },
    at: 3000,
    authorityVersion: refreshed.success.next.authorityVersion,
  });
});

it("refuses reinstalling a deleted id and starts a new installation without anonymous consent", async () => {
  const { current, context } = await approvedInstallation();
  const deleted = applyInstallationCommand(
    current,
    { kind: "set-status", status: "deleted" },
    context,
  );
  if (Result.isFailure(deleted)) throw new Error(deleted.failure.code);
  expect(
    applyInstallationCommand(
      deleted.success.next,
      {
        kind: "install",
        release,
        releasePin: "pinned",
        grants: "declared",
      },
      { ...context, expectedVersion: deleted.success.next.authorityVersion },
    ),
  ).toEqual(Result.fail({ kind: "refused", code: "unavailable" }));
  const fresh = await installation(context.declaration, "new-shares");
  expect(fresh.current.installationId).toBe("new-shares");
  expect(fresh.current.approvedAnonymousMethods).toEqual([]);
  expect(fresh.current.anonymousApproval).toBeNull();
});
