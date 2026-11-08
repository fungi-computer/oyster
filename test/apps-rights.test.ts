import { expect, it } from "vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { appDeclarationSchema } from "@fungi.computer/puffball/app";
import { applyGrantCommand } from "../src/apps/installation.js";
import { deriveDeclaredOperations } from "../src/apps/operations.js";
import { appRightStates } from "../src/page/app-rights.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

const principal = {
  actor: { kind: "member" as const, memberId: "owner" },
  role: "owner" as const,
};

it("reports each declared right as granted, and a newly declared one as missing until approved", async () => {
  const declaredOperations = await deriveDeclaredOperations(
    release,
    declaration,
    descriptors,
  );
  const installed = applyGrantCommand(
    null,
    { kind: "install" },
    {
      principal,
      expectedVersion: null,
      declaration,
      declaredOperations,
      now: 1,
    },
  );
  if (Result.isFailure(installed)) throw new Error(installed.failure.code);
  expect(
    appRightStates({
      permissions: { authority: installed.success, declaredOperations },
    }),
  ).toEqual({
    "computer.readFile": "granted",
    "computer.writeFile": "granted",
  });

  const upgraded = Schema.decodeUnknownSync(appDeclarationSchema)({
    ...declaration,
    capabilities: [...declaration.capabilities, "computer.execute"],
    backend: {
      bindings: [{ name: "COMPUTER", operations: ["read", "write", "exec"] }],
    },
  });
  const snapshot = await deriveDeclaredOperations(
    release,
    upgraded,
    descriptors,
  );
  const selected = applyGrantCommand(
    installed.success,
    { kind: "select-release" },
    {
      principal,
      expectedVersion: 1,
      declaration: upgraded,
      declaredOperations: snapshot,
      now: 2,
    },
  );
  if (Result.isFailure(selected)) throw new Error(selected.failure.code);
  expect(
    appRightStates({
      permissions: {
        authority: selected.success,
        declaredOperations: snapshot,
      },
    }),
  ).toMatchObject({
    "computer.readFile": "granted",
    "computer.execute": "missing",
  });
});
