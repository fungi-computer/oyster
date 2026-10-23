import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { emptyAppDeclaration } from "@fungi.computer/puffball/app";
import { approvedInstallation } from "../src/testing/installation.js";
import {
  createInstallationOperations,
  installationOperationsPort,
  type RetainedInstallationCommand,
  type InstallationOperations,
  type InstallationOutcome,
  type InstallationAdmission,
} from "../src/installation-operations.js";
import type { Installation } from "../src/apps/installation.js";
import { installationSchema } from "../src/apps/installation.js";
import { defaultTenant } from "../src/tenant.js";
import { declaration, descriptors, release } from "./apps-fixture.js";

const scope = { tenantId: defaultTenant, origin: "https://oyster.test" };
const admission = {
  requestId: "installation-owner-proof",
  installationId: "notes",
  release,
  actor: { kind: "member" as const, memberId: "owner" },
  intent: "install-or-select" as const,
  origin: "owner-direct" as const,
};
const passedUiCheck = { kind: "passed" as const };
type Executor = (
  command: RetainedInstallationCommand,
  port: InstallationOperations,
) => Promise<InstallationOutcome>;

function fixture(
  execute: Executor,
  scheduleWake: (at: number) => Promise<void> = () => Promise.resolve(),
) {
  const database = new DatabaseSync(":memory:");
  const rows = new Map<string, Installation>();
  const owner = fromNodeSqlite(database);
  let executions = 0;
  let generation = "fixture-generation";
  const make = async () => {
    const runtime = await createInstallationOperations({
      owner,
      registryName: "registry",
      generation: () => generation,
      get: (id) => rows.get(id) ?? null,
      compareAndPut: (next, expected, expectedGeneration) => {
        const current = rows.get(next.installationId);
        if (
          (current?.authority.authorityVersion ?? 0) !== expected ||
          expectedGeneration !== generation
        )
          return Promise.resolve({ ok: false, code: "stale_authority" });
        rows.set(next.installationId, next);
        return Promise.resolve({ ok: true });
      },
      execute: (command) => {
        executions++;
        return execute(command, port);
      },
      scheduleWake,
    });
    const port = installationOperationsPort(
      (request) => runtime.dispatch(request),
      scope,
    );
    return { runtime, port };
  };
  return {
    database,
    rows,
    make,
    executions: () => executions,
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}

async function plan(
  command: RetainedInstallationCommand,
  port: InstallationOperations,
) {
  const next = await approvedInstallation({
    release: command.admission.release,
    declaration: emptyAppDeclaration,
    installationId: command.installationId,
    instanceId: command.instanceId,
  });
  await port.plan(command.admission.requestId, next, true);
  return next;
}

const refuse: Executor = () =>
  Promise.resolve({ state: "refused", status: 409, code: "fixture_refusal" });
const commandCount = (database: DatabaseSync) =>
  z
    .strictObject({ count: z.number() })
    .parse(
      database
        .prepare("SELECT count(*) AS count FROM installation_commands")
        .get(),
    ).count;

it("deletes settled journal entries at 90 days but always retains the latest settled entry per installation", async () => {
  const settledAt = Date.UTC(2026, 0, 1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(settledAt);
  const state = fixture(refuse);
  try {
    const { runtime, port } = await state.make();
    const first = { ...admission, requestId: "z-retention-first" };
    const latest = { ...admission, requestId: "a-retention-latest" };
    await port.admit(first);
    await runtime.tick();
    await port.admit(latest);
    await runtime.tick();

    clock.mockReturnValue(settledAt + 90 * 24 * 60 * 60 * 1_000 - 1);
    await runtime.tick();
    expect(
      await port.read(first.requestId, first.installationId),
    ).toMatchObject({
      state: "refused",
      code: "fixture_refusal",
    });

    clock.mockReturnValue(settledAt + 90 * 24 * 60 * 60 * 1_000);
    await runtime.tick();
    expect(await port.read(first.requestId, first.installationId)).toBeNull();
    expect(
      await port.read(latest.requestId, latest.installationId),
    ).toMatchObject({ state: "refused", code: "fixture_refusal" });
    // Retention deletes storage, rather than only hiding an expired receipt.
    expect(commandCount(state.database)).toBe(1);
    expect(state.executions()).toBe(2);
    // Watchdog still owns the old job ID; replay cannot strand a new pending row.
    await expect(port.admit(first)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await port.read(first.requestId, first.installationId)).toBeNull();
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it("re-arms idle journal expiry from durable state after reopening without polling the latest pin", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const wakes: number[] = [];
  const state = fixture(refuse, (at) => {
    wakes.push(at);
    return Promise.resolve();
  });
  try {
    const { runtime, port } = await state.make();
    await port.admit({ ...admission, requestId: "idle-first" });
    await runtime.tick();
    await port.admit({ ...admission, requestId: "idle-latest" });
    await runtime.tick();
    const reopened = await state.make();
    wakes.length = 0;
    await reopened.runtime.tick();
    expect(wakes).toEqual([Date.UTC(2026, 3, 1)]);

    clock.mockReturnValue(Date.UTC(2026, 3, 1));
    wakes.length = 0;
    await reopened.runtime.tick();
    expect(await reopened.port.read("idle-first", "notes")).toBeNull();
    expect(await reopened.port.read("idle-latest", "notes")).toMatchObject({
      state: "refused",
    });
    expect(wakes).toEqual([]);
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it("pins each installation's latest settlement while a newer command is still pending, without restarting the old deadline", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const state = fixture(async (command, port) => {
    if (command.admission.requestId === "notes-pending") {
      expect(await port.read("notes-latest", "notes")).toMatchObject({
        state: "refused",
      });
      expect(await port.load("notes-pending")).toMatchObject({
        admission: { requestId: "notes-pending" },
      });
    }
    return refuse(command, port);
  });
  try {
    const { runtime, port } = await state.make();
    for (const input of [
      { ...admission, requestId: "notes-old" },
      { ...admission, requestId: "notes-latest" },
      { ...admission, installationId: "books", requestId: "books-latest" },
    ]) {
      await port.admit(input);
      await runtime.tick();
    }
    await port.admit({ ...admission, requestId: "notes-pending" });
    clock.mockReturnValue(Date.UTC(2026, 3, 2));
    await runtime.tick();
    expect(await port.read("notes-old", "notes")).toBeNull();
    expect(await port.read("books-latest", "books")).toMatchObject({
      state: "refused",
    });
    // Superseding the old pin after its own 90 days makes it due immediately.
    await runtime.tick();
    expect(await port.read("notes-latest", "notes")).toBeNull();
    expect(await port.read("notes-pending", "notes")).toMatchObject({
      state: "refused",
    });
    expect(await port.read("books-latest", "books")).toMatchObject({
      state: "refused",
    });
    expect(state.executions()).toBe(4);
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it("starts journal retention at settlement, not at an old command's admission", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const state = fixture(refuse);
  try {
    const { runtime, port } = await state.make();
    await port.admit({ ...admission, requestId: "slow-first" });
    clock.mockReturnValue(Date.UTC(2026, 3, 2));
    await runtime.tick();
    await port.admit({ ...admission, requestId: "slow-latest" });
    await runtime.tick();
    clock.mockReturnValue(Date.UTC(2026, 6, 1) - 1);
    await runtime.tick();
    expect(await port.read("slow-first", "notes")).toMatchObject({
      state: "refused",
    });
    clock.mockReturnValue(Date.UTC(2026, 6, 1));
    await runtime.tick();
    expect(await port.read("slow-first", "notes")).toBeNull();
    expect(await port.read("slow-latest", "notes")).toMatchObject({
      state: "refused",
    });
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it("bounds each indexed deletion batch and continues after owner recreation without imposing an admission quota", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const state = fixture(refuse);
  try {
    const { runtime, port } = await state.make();
    for (let index = 0; index < 35; index++) {
      await port.admit({ ...admission, requestId: `batch-${String(index)}` });
      await runtime.tick();
    }
    expect(commandCount(state.database)).toBe(35);
    const plan = z
      .array(
        z.strictObject({
          id: z.number().int(),
          parent: z.number().int(),
          notused: z.number().int(),
          detail: z.string(),
        }),
      )
      .parse(
        state.database
          .prepare(
            `EXPLAIN QUERY PLAN SELECT request_id,installation_id,settled_at,retention_due_at,provisional_outcome
              FROM installation_commands WHERE retention_due_at<=?
              ORDER BY retention_due_at,rowid LIMIT ?`,
          )
          .all(Date.UTC(2026, 3, 1), 16),
      );
    expect(
      plan.some(({ detail }) =>
        /SEARCH .*installation_commands_retention/u.test(detail),
      ),
    ).toBe(true);
    expect(plan.some(({ detail }) => /\bSCAN\b/u.test(detail))).toBe(false);
    clock.mockReturnValue(Date.UTC(2026, 3, 1));
    await runtime.tick();
    expect(commandCount(state.database)).toBe(19);
    const reopened = await state.make();
    await reopened.runtime.tick();
    expect(commandCount(state.database)).toBe(3);
    await reopened.runtime.tick();
    expect(commandCount(state.database)).toBe(1);
    expect(await reopened.port.read("batch-34", "notes")).toMatchObject({
      state: "refused",
    });
    expect(state.executions()).toBe(35);
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it.each(["unreadable", "request identity mismatch"])(
  "refuses a corrupt expiry candidate (%s) and atomically preserves the whole batch",
  async (fault) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    const state = fixture(refuse);
    try {
      const { runtime, port } = await state.make();
      for (const requestId of [
        "corrupt-first",
        "corrupt-second",
        "corrupt-latest",
      ]) {
        await port.admit({ ...admission, requestId });
        await runtime.tick();
      }
      if (fault === "unreadable")
        state.database
          .prepare(
            "UPDATE installation_commands SET command=? WHERE request_id=?",
          )
          .run('{"corrupt":true}', "corrupt-second");
      else
        state.database
          .prepare(
            "UPDATE installation_commands SET command=json_set(command,'$.operation.requestId',?) WHERE request_id=?",
          )
          .run("another-valid-request-id", "corrupt-second");
      const corrupted = state.database
        .prepare("SELECT command FROM installation_commands WHERE request_id=?")
        .get("corrupt-second");
      clock.mockReturnValue(Date.UTC(2026, 3, 1));
      await expect(runtime.tick()).rejects.toMatchObject({
        code: "stored_operation_invalid",
      });
      expect(commandCount(state.database)).toBe(3);
      expect(await port.read("corrupt-first", "notes")).toMatchObject({
        state: "refused",
      });
      expect(
        state.database
          .prepare(
            "SELECT command FROM installation_commands WHERE request_id=?",
          )
          .get("corrupt-second"),
      ).toEqual(corrupted);
      if (fault === "unreadable")
        await expect(
          port.read("corrupt-second", "notes"),
        ).rejects.toMatchObject({
          code: "stored_operation_invalid",
        });
      expect(await port.read("corrupt-latest", "notes")).toMatchObject({
        state: "refused",
      });
    } finally {
      clock.mockRestore();
      state.database.close();
    }
  },
);

it("rolls back a failed native deletion batch and retries only when the existing owner is driven again", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const wakes: number[] = [];
  const state = fixture(refuse, (at) => {
    wakes.push(at);
    return Promise.resolve();
  });
  try {
    const { runtime, port } = await state.make();
    for (const requestId of [
      "delete-first",
      "delete-second",
      "delete-latest",
    ]) {
      await port.admit({ ...admission, requestId });
      await runtime.tick();
    }
    state.database.exec(`CREATE TRIGGER fail_retention_delete
      BEFORE DELETE ON installation_commands WHEN OLD.request_id='delete-second'
      BEGIN SELECT RAISE(ABORT, 'retention deletion fault'); END`);
    clock.mockReturnValue(Date.UTC(2026, 3, 1));
    wakes.length = 0;
    await expect(runtime.tick()).rejects.toThrow("retention deletion fault");
    expect(commandCount(state.database)).toBe(3);
    expect(wakes).toEqual([]);
    state.database.exec("DROP TRIGGER fail_retention_delete");
    const reopened = await state.make();
    await reopened.runtime.tick();
    expect(commandCount(state.database)).toBe(1);
    expect(await reopened.port.read("delete-latest", "notes")).toMatchObject({
      state: "refused",
    });
    expect(state.executions()).toBe(3);
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it("rolls back the previous latest pin together with failed terminal compaction", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const state = fixture(refuse);
  try {
    const { runtime, port } = await state.make();
    await port.admit({ ...admission, requestId: "pin-first" });
    await runtime.tick();
    await port.admit({ ...admission, requestId: "pin-second" });
    state.database.exec(`CREATE TRIGGER fail_pin_transfer
      BEFORE UPDATE OF command ON installation_commands
      WHEN OLD.request_id='pin-second' AND json_extract(NEW.command,'$.kind')='settled'
      BEGIN SELECT RAISE(ABORT, 'pin transfer fault'); END`);
    await expect(runtime.tick()).rejects.toThrow();
    expect(
      z
        .strictObject({
          settled_at: z.number(),
          retention_due_at: z.null(),
        })
        .parse(
          state.database
            .prepare(
              "SELECT settled_at,retention_due_at FROM installation_commands WHERE request_id=?",
            )
            .get("pin-first"),
        ),
    ).toEqual({
      settled_at: Date.UTC(2026, 0, 1),
      retention_due_at: null,
    });
    expect(await port.load("pin-second")).toMatchObject({
      operation: { state: "pending" },
    });
    state.database.exec("DROP TRIGGER fail_pin_transfer");
    clock.mockReturnValue(Date.UTC(2026, 3, 2));
    const reopened = await state.make();
    await reopened.runtime.tick();
    await reopened.runtime.tick();
    expect(await reopened.port.read("pin-first", "notes")).toBeNull();
    expect(await reopened.port.read("pin-second", "notes")).toMatchObject({
      state: "unconfirmed",
      outcome: "interrupted",
    });
    expect(state.executions()).toBe(2);
  } finally {
    clock.mockRestore();
    state.database.close();
  }
});

it("compacts settled replacement payloads without forgetting replay identity or making terminal history executable", async () => {
  let preparedBytes = 0;
  const reordered: InstallationAdmission = {
    ...admission,
    actor: { memberId: admission.actor.memberId, kind: admission.actor.kind },
    release: {
      artifact: admission.release.artifact,
      releaseId: admission.release.releaseId,
      appId: admission.release.appId,
    },
  };
  const state = fixture(async (command, port) => {
    const installation = installationSchema.parse({
      ...(await approvedInstallation({
        release: command.admission.release,
        declaration,
        descriptors,
        installationId: command.installationId,
        instanceId: command.instanceId,
      })),
      authority: {
        ...command.baseline?.authority,
        authorityVersion: 2,
      },
    });
    await port.plan(command.admission.requestId, installation, true);
    await port.commit(command.admission.requestId, passedUiCheck);
    const row = z
      .strictObject({ bytes: z.number() })
      .parse(
        state.database
          .prepare(
            "SELECT length(CAST(command AS BLOB)) AS bytes FROM installation_commands WHERE request_id=?",
          )
          .get(command.admission.requestId),
      );
    preparedBytes = row.bytes;
    return {
      state: "succeeded",
      installation,
      creation: command.creation,
      uiCheck: passedUiCheck,
    };
  });
  try {
    state.rows.set(
      "notes",
      await approvedInstallation({
        release,
        declaration,
        descriptors,
        installationId: "notes",
        instanceId: null,
      }),
    );
    const { runtime, port } = await state.make();
    const pending = await port.admit(admission);
    expect(await port.admit(reordered)).toEqual(pending);
    await runtime.tick();
    const row = z
      .strictObject({
        command: z.string(),
        provisional_outcome: z.string().nullable(),
      })
      .parse(
        state.database
          .prepare(
            "SELECT command, provisional_outcome FROM installation_commands WHERE request_id=?",
          )
          .get(admission.requestId),
      );
    const stored: unknown = JSON.parse(row.command);
    expect(stored).not.toHaveProperty("baseline");
    expect(stored).not.toHaveProperty("plan");
    expect(stored).not.toHaveProperty("operation.installation");
    expect(stored).not.toHaveProperty("admission");
    expect(stored).toHaveProperty("inputDigest");
    expect(row.provisional_outcome).toBeNull();
    expect(new TextEncoder().encode(row.command).byteLength).toBeLessThan(
      preparedBytes,
    );
    const result = await port.read(admission.requestId, "notes");
    expect(result).toMatchObject({
      state: "succeeded",
      creation: "replacement",
    });
    expect(await port.admit(admission)).toEqual(result);
    expect(await port.admit(reordered)).toEqual(result);
    await expect(
      port.admit({ ...admission, origin: "workflow" }),
    ).rejects.toMatchObject({ code: "request_conflict" });
    expect(await port.load(admission.requestId)).toBeNull();
    await runtime.tick();
    expect(state.executions()).toBe(1);
    expect(
      state.database
        .prepare("SELECT count(*) AS count FROM installation_commands")
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    state.database.close();
  }
});

it.each(["advanced", "missing", "generation"] as const)(
  "keeps original success evidence without hydrating %s canonical state",
  async (change) => {
    const state = fixture(async (command, port) => {
      const installation = await plan(command, port);
      await port.commit(command.admission.requestId, passedUiCheck);
      return {
        state: "succeeded",
        installation,
        creation: command.creation,
        uiCheck: passedUiCheck,
      };
    });
    try {
      const { runtime, port } = await state.make();
      await port.admit(admission);
      await runtime.tick();
      const original = await port.read(admission.requestId, "notes");
      if (original?.state !== "succeeded" || original.installation === null)
        throw new Error("Exact completion missing");
      expect(original.reference.authorityVersion).toBe(1);
      if (change === "missing") state.rows.delete("notes");
      else if (change === "generation")
        state.setGeneration("recreated-generation");
      else
        state.rows.set(
          "notes",
          installationSchema.parse({
            ...original.installation,
            authority: {
              ...original.installation.authority,
              authorityVersion: 2,
            },
          }),
        );
      const historical = { ...original, installation: null };
      expect(await port.read(admission.requestId, "notes")).toEqual(historical);
      expect(await port.admit(admission)).toEqual(historical);
      expect(await port.load(admission.requestId)).toBeNull();
      expect(state.executions()).toBe(1);
    } finally {
      state.database.close();
    }
  },
);

it("rolls back terminal compaction with Watchdog settlement and keeps pending recovery evidence", async () => {
  const state = fixture(async (command, port) => {
    const installation = await plan(command, port);
    await port.commit(command.admission.requestId, passedUiCheck);
    return {
      state: "succeeded",
      installation,
      creation: command.creation,
      uiCheck: passedUiCheck,
    };
  });
  try {
    const { runtime, port } = await state.make();
    await port.admit(admission);
    state.database.exec(`
      CREATE TRIGGER reject_terminal_compaction
      BEFORE UPDATE OF command ON installation_commands
      WHEN json_extract(NEW.command, '$.kind') = 'settled'
      BEGIN SELECT RAISE(ABORT, 'terminal compaction fault'); END
    `);
    await expect(runtime.tick()).rejects.toThrow();
    expect(await port.read(admission.requestId, "notes")).toMatchObject({
      state: "pending",
    });
    expect(await port.load(admission.requestId)).toMatchObject({
      plan: { prepared: true, uiCheck: passedUiCheck },
      operation: { state: "pending" },
    });
    const row = z
      .strictObject({ provisional_outcome: z.string() })
      .parse(
        state.database
          .prepare(
            "SELECT provisional_outcome FROM installation_commands WHERE request_id=?",
          )
          .get(admission.requestId),
      );
    const provisional: unknown = JSON.parse(row.provisional_outcome);
    expect(provisional).toMatchObject({ state: "succeeded" });
    state.database.exec("DROP TRIGGER reject_terminal_compaction");
    const reopened = await state.make();
    await reopened.runtime.tick();
    expect(
      await reopened.port.read(admission.requestId, "notes"),
    ).toMatchObject({
      state: "unconfirmed",
      outcome: "interrupted",
    });
    expect(await reopened.port.load(admission.requestId)).toBeNull();
    expect(state.executions()).toBe(1);
  } finally {
    state.database.close();
  }
});

it("reopens the exact prepared pending command before settlement without reducing a newer baseline", async () => {
  const recovered: RetainedInstallationCommand[] = [];
  const state = fixture((command) => {
    recovered.push(command);
    return Promise.resolve({
      state: "unconfirmed",
      outcome: "outcome_unknown",
    });
  });
  try {
    const first = await state.make();
    await first.port.admit(admission);
    const accepted = await first.port.load(admission.requestId);
    if (accepted === null) throw new Error("Accepted command missing");
    const installation = await plan(accepted, first.port);
    await first.port.commit(admission.requestId, passedUiCheck);
    const prepared = await first.port.load(admission.requestId);
    expect(prepared).toMatchObject({
      baseline: null,
      plan: { installation, prepared: true, uiCheck: passedUiCheck },
      operation: { state: "pending" },
    });
    const reopened = await state.make();
    expect(await reopened.port.load(admission.requestId)).toEqual(prepared);
    expect(
      await reopened.port.commit(admission.requestId, passedUiCheck),
    ).toEqual({ ok: true });
    expect(state.rows.get("notes")?.authority.authorityVersion).toBe(1);
    await reopened.runtime.tick();
    expect(recovered).toEqual([prepared]);
    expect(
      await reopened.port.read(admission.requestId, "notes"),
    ).toMatchObject({
      state: "unconfirmed",
      outcome: "outcome_unknown",
    });
    expect(await reopened.port.load(admission.requestId)).toBeNull();
  } finally {
    state.database.close();
  }
});

it.each([
  ["plan", "navigation_failed"],
  ["operation", "navigation_failed"],
  ["plan", "preflight_status"],
  ["operation", "preflight_status"],
])(
  "refuses obsolete preview %s UI predicate %s with a typed republish instruction",
  async (location, failedPredicate) => {
    const state = fixture(async (command, port) => {
      const next = await plan(command, port);
      await port.commit(command.admission.requestId, passedUiCheck);
      return {
        state: "succeeded",
        installation: next,
        creation: "fresh",
        uiCheck: passedUiCheck,
      };
    });
    try {
      const { runtime, port } = await state.make();
      await port.admit(admission);
      if (location === "plan") {
        const command = await port.load(admission.requestId);
        if (command === null) throw new Error("Pending command missing");
        await plan(command, port);
        await port.commit(admission.requestId, passedUiCheck);
        expect((await port.load(admission.requestId))?.plan?.prepared).toBe(
          true,
        );
      } else {
        await runtime.tick();
        expect(await port.load(admission.requestId)).toBeNull();
      }
      const uiCheck = {
        kind: "failed",
        code: "ui_mount_failed",
        diagnostics: {
          failedPredicate,
          finalUrlPath: "out-of-scope",
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          droppedCount: 0,
        },
      };
      // JSON left by an earlier preview, not an alternate accepted contract.
      state.database
        .prepare(
          "UPDATE installation_commands SET command=json_set(command, ?, json(?)) WHERE request_id=?",
        )
        .run(
          `$.${location}.uiCheck`,
          JSON.stringify(uiCheck),
          admission.requestId,
        );
      const { command: stored } = z
        .strictObject({ command: z.string() })
        .parse(
          state.database
            .prepare(
              "SELECT command FROM installation_commands WHERE request_id=?",
            )
            .get(admission.requestId),
        );
      const refusal = {
        code: "stored_operation_invalid",
        message:
          "Stored installation operation is incompatible or invalid; republish this standalone preview.",
      };
      await expect(
        port.read(admission.requestId, "notes"),
      ).rejects.toMatchObject(refusal);
      await expect(port.load(admission.requestId)).rejects.toMatchObject(
        refusal,
      );
      await expect(port.admit(admission)).rejects.toMatchObject(refusal);
      // Refusal neither translates old data nor reruns the browser/executor.
      expect(state.executions()).toBe(location === "plan" ? 0 : 1);
      expect(
        state.database
          .prepare(
            "SELECT command FROM installation_commands WHERE request_id=?",
          )
          .get(admission.requestId),
      ).toEqual({ command: stored });
    } finally {
      state.database.close();
    }
  },
);

it("refuses an obsolete provisional result before exposing a pending operation", async () => {
  const state = fixture(() =>
    Promise.resolve({ state: "unconfirmed", outcome: "outcome_unknown" }),
  );
  try {
    const { port } = await state.make();
    await port.admit(admission);
    const command = await port.load(admission.requestId);
    if (command === null) throw new Error("Accepted command missing");
    const installation = await plan(command, port);
    const obsolete = JSON.stringify({
      state: "succeeded",
      installation,
      creation: "fresh",
      uiCheck: {
        kind: "failed",
        code: "ui_mount_failed",
        diagnostics: {
          failedPredicate: "navigation_failed",
          finalUrlPath: "out-of-scope",
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          droppedCount: 0,
        },
      },
    });
    state.database
      .prepare(
        "UPDATE installation_commands SET provisional_outcome=? WHERE request_id=?",
      )
      .run(obsolete, admission.requestId);
    await expect(port.read(admission.requestId, "notes")).rejects.toMatchObject(
      {
        code: "stored_operation_invalid",
      },
    );
    await expect(port.admit(admission)).rejects.toMatchObject({
      code: "stored_operation_invalid",
    });
    expect(state.executions()).toBe(0);
    expect(
      state.database
        .prepare(
          "SELECT provisional_outcome FROM installation_commands WHERE request_id=?",
        )
        .get(admission.requestId),
    ).toEqual({ provisional_outcome: obsolete });
  } finally {
    state.database.close();
  }
});

it("keeps a committed selection pending until its executor supplies exact application evidence", async () => {
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const state = fixture(async (command, port) => {
    const next = await plan(command, port);
    expect(
      await port.commit(command.admission.requestId, passedUiCheck),
    ).toEqual({
      ok: true,
    });
    entered.resolve(undefined);
    await gate.promise;
    return {
      state: "succeeded",
      installation: next,
      creation: "fresh",
      uiCheck: passedUiCheck,
    };
  });
  const { runtime, port } = await state.make();
  let running: Promise<unknown> | undefined;
  try {
    expect((await port.admit(admission)).state).toBe("pending");
    running = runtime.tick();
    await entered.promise;
    expect(state.rows.get("notes")?.authority.authorityVersion).toBe(1);
    expect((await port.read(admission.requestId, "notes"))?.state).toBe(
      "pending",
    );
    gate.resolve(undefined);
    await running;
    const result = await port.read(admission.requestId, "notes");
    expect(result?.state).toBe("succeeded");
    if (result?.state !== "succeeded" || result.installation === null)
      throw new Error("Exact completion missing");
    expect(result.creation).toBe("fresh");
    expect(result.installation.authority.authorityVersion).toBe(1);
    expect(await port.admit(admission)).toEqual(result);
    await runtime.tick();
    expect(state.executions()).toBe(1);
  } finally {
    gate.resolve(undefined);
    await running;
    state.database.close();
  }
});

it("retains a typed apply refusal even when its selection was already committed", async () => {
  const state = fixture(async (command, port) => {
    await plan(command, port);
    await port.commit(command.admission.requestId, passedUiCheck);
    return { state: "refused", status: 422, code: "ui_mount_failed" };
  });
  try {
    const { runtime, port } = await state.make();
    await port.admit(admission);
    await runtime.tick();
    expect(state.rows.has("notes")).toBe(true);
    expect(await port.read(admission.requestId, "notes")).toMatchObject({
      state: "refused",
      status: 422,
      code: "ui_mount_failed",
    });
  } finally {
    state.database.close();
  }
});

it("fences a late success when newer authority replaced its committed selection", async () => {
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const state = fixture(async (command, port) => {
    const next = await plan(command, port);
    await port.commit(command.admission.requestId, passedUiCheck);
    entered.resolve(undefined);
    await gate.promise;
    return {
      state: "succeeded",
      installation: next,
      creation: "fresh",
      uiCheck: passedUiCheck,
    };
  });
  let running: Promise<unknown> | undefined;
  try {
    const { runtime, port } = await state.make();
    await port.admit(admission);
    running = runtime.tick();
    await entered.promise;
    const current = state.rows.get("notes");
    if (current === undefined) throw new Error("Committed selection missing");
    state.rows.set(
      "notes",
      installationSchema.parse({
        ...current,
        authority: {
          ...current.authority,
          authorityVersion: current.authority.authorityVersion + 1,
        },
      }),
    );
    gate.resolve(undefined);
    await running;
    expect(await port.read(admission.requestId, "notes")).toMatchObject({
      state: "unconfirmed",
      outcome: "outcome_unknown",
    });
    expect(state.rows.get("notes")?.authority.authorityVersion).toBe(2);
  } finally {
    gate.resolve(undefined);
    await running;
    state.database.close();
  }
});

it("retains exact correlation and remints a tombstone only for the POST intent", async () => {
  const state = fixture(() =>
    Promise.resolve({ state: "unconfirmed", outcome: "outcome_unknown" }),
  );
  try {
    const retired = installationSchema.parse({
      ...(await approvedInstallation({
        release,
        declaration: emptyAppDeclaration,
        installationId: "notes",
        instanceId: null,
      })),
      status: "deleted",
    });
    state.rows.set("notes", retired);
    const { port } = await state.make();
    const accepted = await port.admit({
      ...admission,
      intent: "install-or-remint",
    });
    expect(accepted.installationId).not.toBe("notes");
    expect((await port.load(admission.requestId))?.creation).toBe("reminted");
    expect(await port.read(admission.requestId, "notes")).toEqual(accepted);
    expect(
      await port.read(admission.requestId, accepted.installationId),
    ).toEqual(accepted);
    expect(await port.read(admission.requestId, "other")).toBeNull();
    await expect(
      port.admit({
        ...admission,
        installationId: "other",
        intent: "install-or-remint",
      }),
    ).rejects.toMatchObject({ code: "request_conflict" });
    const selected = await port.admit({
      ...admission,
      requestId: "select-retired",
    });
    expect(selected.installationId).toBe("notes");
    expect((await port.load("select-retired"))?.baseline).toEqual(retired);
    expect(state.rows.get("notes")).toEqual(retired);
  } finally {
    state.database.close();
  }
});

it.each(["success", "refusal"] as const)(
  "keeps disappeared work interrupted despite a late %s",
  async (late) => {
    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const state = fixture(async (command, port) => {
      const next = await plan(command, port);
      await port.commit(command.admission.requestId, passedUiCheck);
      entered.resolve(undefined);
      await gate.promise;
      return late === "success"
        ? {
            state: "succeeded",
            installation: next,
            creation: "fresh",
            uiCheck: passedUiCheck,
          }
        : { state: "refused", status: 422, code: "ui_mount_failed" };
    });
    let running: Promise<unknown> | undefined;
    try {
      const old = await state.make();
      await old.port.admit(admission);
      // Capture the late claim rejection immediately, rather than leaving an
      // unhandled rejection while a new owner reconciles it.
      running = old.runtime.tick().then(
        () => ({ kind: "settled" }),
        (error: unknown) => ({ kind: "rejected", error }),
      );
      await entered.promise;
      const fresh = await state.make();
      await fresh.runtime.tick();
      expect(await fresh.port.read(admission.requestId, "notes")).toMatchObject(
        {
          state: "unconfirmed",
          outcome: "interrupted",
        },
      );
      expect(state.rows.get("notes")?.authority.authorityVersion).toBe(1);
      expect(state.executions()).toBe(1);
      gate.resolve(undefined);
      expect(await running).toMatchObject({
        kind: "rejected",
        error: { cause: "settlement_rejected" },
      });
      expect(await fresh.port.read(admission.requestId, "notes")).toMatchObject(
        {
          state: "unconfirmed",
          outcome: "interrupted",
        },
      );
    } finally {
      gate.resolve(undefined);
      await running;
      state.database.close();
    }
  },
);

it("does not admit a command if its durable wake could not be armed", async () => {
  const failure = new Error("Durable storage alarm unavailable");
  const state = fixture(
    () => Promise.resolve({ state: "unconfirmed", outcome: "outcome_unknown" }),
    () => Promise.reject(failure),
  );
  try {
    const { port } = await state.make();
    await expect(port.admit(admission)).rejects.toBe(failure);
    expect(await port.read(admission.requestId, "notes")).toBeNull();
    expect(await port.load(admission.requestId)).toBeNull();
    expect(state.rows.size).toBe(0);
    expect(state.executions()).toBe(0);
  } finally {
    state.database.close();
  }
});

it("lets a Workflow reuse its baseline approval but never plan a new one", async () => {
  const workflow = {
    ...admission,
    requestId: "workflow-owner-proof",
    origin: "workflow" as const,
  };
  const refusals: unknown[] = [];
  const state = fixture(async (command, port) => {
    // The owner's install reduction would approve install-consent grants.
    const granting = await approvedInstallation({
      release: command.admission.release,
      declaration,
      descriptors,
      installationId: command.installationId,
      instanceId: command.instanceId,
    });
    expect(granting.authority.approvedGrants.length).toBeGreaterThan(0);
    await port
      .plan(command.admission.requestId, granting, true)
      .catch((cause: unknown) => refusals.push(cause));
    return { state: "refused", status: 409, code: "needs_consent" };
  });
  try {
    const { runtime, port } = await state.make();
    await port.admit(workflow);
    await runtime.tick();
    expect(refusals).toEqual([
      expect.objectContaining({ code: "needs_consent" }),
    ]);
    expect(await port.load(workflow.requestId)).toBeNull();
    expect(await port.read(workflow.requestId, "notes")).toMatchObject({
      state: "refused",
      code: "needs_consent",
    });
    expect(state.rows.has("notes")).toBe(false);
  } finally {
    state.database.close();
  }
  const reuse = fixture(async (command, port) => {
    const next = await plan(command, port);
    await port.commit(command.admission.requestId, passedUiCheck);
    return {
      state: "succeeded",
      installation: next,
      creation: "fresh",
      uiCheck: passedUiCheck,
    };
  });
  try {
    const { runtime, port } = await reuse.make();
    await port.admit(workflow);
    await runtime.tick();
    expect((await port.read(workflow.requestId, "notes"))?.state).toBe(
      "succeeded",
    );
  } finally {
    reuse.database.close();
  }
});

it("refuses a replay that changes the retained install origin", async () => {
  const state = fixture(() => Promise.withResolvers<never>().promise);
  try {
    const { port } = await state.make();
    await port.admit(admission);
    await expect(
      port.admit({ ...admission, origin: "workflow" }),
    ).rejects.toMatchObject({ code: "request_conflict" });
  } finally {
    state.database.close();
  }
});
