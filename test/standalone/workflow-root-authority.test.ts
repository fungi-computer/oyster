import { expect, it } from "vitest";
import { compile } from "@fungi.computer/braid";
import { createTenancy } from "@fungi.computer/oyster/tenancy";
import { memoryRegistry } from "@fungi.computer/oyster/tenancy/registry";
import { subdomain } from "@fungi.computer/oyster/tenancy/resolve";
import { createStandaloneWorkflowRootAuthority } from "../../src/standalone/workflow-root-authority.js";

it("captures a Computer-free run from the actual canonical registry owner and refuses a suspended tenant", async () => {
  const registry = memoryRegistry();
  const tenant = await registry.create({
    handle: "root",
    origin: "https://root.oyster.test",
    domains: ["root.oyster.test"],
    owner: { provider: "fixture", subject: "owner" },
  });
  const tenancy = createTenancy({
    registry,
    resolve: subdomain("oyster.test"),
    auth: [],
  });
  const ownerId = tenant.owners[0];
  if (ownerId === undefined) throw new Error("Missing owner");
  const unused = (): never => {
    throw new Error("A transform run needs no App/Git/Computer admission");
  };
  let agentPolicy: {
    level: "read" | "write";
    revision: string;
    grantedBy: string;
  } | null = { level: "write", revision: "agent_one:1", grantedBy: ownerId };
  const authority = createStandaloneWorkflowRootAuthority({
    shared: {
      tenantId: tenant.id,
      tenancy,
      async owner() {
        const member = await tenancy.memberById(tenant.id, ownerId);
        return member?.actor.kind === "member" &&
          "role" in member &&
          member.role === "owner"
          ? {
              actor: member.actor,
              role: member.role,
              membershipVersion: member.membershipVersion,
            }
          : null;
      },
    },
    host: {
      auth: { resolve: unused },
      artifacts: { get: unused, put: unused },
      installations: { get: unused },
    },
    libraryInstallationId: "library",
    catalogHost: { admitLibrary: unused, catalogForLibrary: unused },
    agentToolPolicy: (agentId) =>
      Promise.resolve(agentId === "agent_one" ? agentPolicy : null),
    // No key run in this fixture; every key is unknown.
    keyLive: () => Promise.resolve(null),
  });
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Computer-free",
      apps: {},
      input: { type: "object" },
      nodes: [
        {
          id: "done",
          kind: "transform",
          fields: { value: { literal: "done" } },
        },
      ],
      edges: [],
      output: { value: { node: "done", port: "value" } },
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error("Fixture did not compile");
  const preparation = {
    initiatedBy: { kind: "member" as const, memberId: ownerId },
    source: "manual" as const,
    computerId: null,
    plan: compiled.plan,
  };
  expect(await authority.resolve(preparation)).toEqual({
    kind: "admitted",
    actor: preparation.initiatedBy,
    ceiling: { nodes: [], nodeGitAccess: [] },
  });
  expect(
    await authority.resolve({
      ...preparation,
      initiatedBy: { kind: "member", memberId: "other-owner" },
    }),
  ).toMatchObject({ kind: "refused" });
  const agentRun = {
    initiatedBy: {
      kind: "agent" as const,
      agentId: "agent_one",
      sessionId: "session_one",
      grantorMemberId: ownerId,
    },
    source: "agent" as const,
    libraryInstallationId: "library",
    computerId: null,
    plan: compiled.plan,
  };
  // An Agent run acts as the grantor who approved its App tools.
  expect(await authority.resolve(agentRun)).toEqual({
    kind: "admitted",
    actor: { kind: "member", memberId: ownerId },
    ceiling: { nodes: [], nodeGitAccess: [] },
  });
  expect(
    await authority.resolve({
      ...agentRun,
      initiatedBy: { ...agentRun.initiatedBy, agentId: "agent_other" },
    }),
  ).toMatchObject({ kind: "refused" });
  agentPolicy = { level: "read", revision: "agent_one:2", grantedBy: ownerId };
  expect(await authority.resolve(agentRun)).toMatchObject({ kind: "refused" });
  agentPolicy = null;
  expect(await authority.resolve(agentRun)).toMatchObject({ kind: "refused" });
  await registry.setStatus(tenant.id, "suspended");
  expect(await authority.resolve(preparation)).toMatchObject({
    kind: "refused",
  });
});
