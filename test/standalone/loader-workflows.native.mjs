import { log, error } from "node:console";
import assert from "node:assert/strict";

import { buildAppDeclaration } from "@fungi.computer/agar/backend-declaration";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { contentDigest } from "@fungi.computer/braid";
import { runListItemSchema } from "@fungi.computer/workflows-wire";
import { workflowNativeFixture, until } from "./workflow-native.fixture.mjs";
import { appBackend as workflowsBackend } from "../../../../apps/trellis/backend/methods.ts";
import workflowsMetadata from "../../../../apps/trellis/package.json" with { type: "json" };
const workflowsDeclaration = buildAppDeclaration(
  workflowsBackend,
  workflowsMetadata.fungi.app,
);
const fixture = await workflowNativeFixture({
  main: "loader-workflows-root.fixture.ts",
  oysterOrigin: "https://oyster.test",
  installationMilliseconds: 60_000,
  configure(config) {
    config.services = [
      ...(config.services ?? []),
      {
        binding: "CANONICAL_ROOT",
        service: config.name,
        entrypoint: "CanonicalRoot",
      },
    ];
    // Local maintained rate bindings; production is closed without operator policy.
    config.ratelimits = [
      {
        name: "WORKFLOW_WEBHOOK_HOST_RATE",
        namespace_id: "901",
        simple: { limit: 100, period: 60 },
      },
      {
        name: "WORKFLOW_WEBHOOK_BINDING_RATE",
        namespace_id: "902",
        simple: { limit: 100, period: 60 },
      },
    ];
  },
});
const {
  config,
  origin,
  auth,
  provider,
  runtime,
  call,
  approve,
  installFirstParty,
} = fixture;
try {
  await installFirstParty("trellis", workflowsDeclaration);
  await approve("trellis");
  const draft = {
    definition: {
      format: "fungi.workflow/v1",
      title: "Native saved copy",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
      triggers: [
        {
          id: "clock",
          on: "schedule",
          cron: { expression: "0 0 * * *", timeZone: "UTC" },
          input: {},
        },
        { id: "hook", on: "webhook", input: {} },
      ],
    },
    layout: {},
  };
  const gitBefore = provider.requests.length;
  const saved = await call("trellis", "saveDraft", {
    workflowId: "pond",
    expectedRevision: 0,
    draft,
  });
  assert.deepEqual(saved, { kind: "saved", revision: 1 });
  const updated = {
    ...draft,
    definition: { ...draft.definition, title: "Second native saved copy" },
  };
  const second = await call("trellis", "saveDraft", {
    workflowId: "pond",
    expectedRevision: 1,
    draft: updated,
  });
  assert.deepEqual(second, { kind: "saved", revision: 2 });
  const stale = await call("trellis", "saveDraft", {
    workflowId: "pond",
    expectedRevision: 1,
    draft,
  });
  assert.deepEqual(stale, {
    kind: "conflict",
    current: { ...updated, revision: 2 },
  });
  assert.equal(
    provider.requests.length,
    gitBefore,
    "draft row saves and stale revision CAS perform zero Git requests",
  );
  log(
    `PASS Workflows saveDraft twice ${runtime}: real backend, revisions 1/2, stale CAS preserves row, zero Git requests`,
  );
  const publication = await call("trellis", "publishWorkflow", {
    workflowId: "pond",
    expectedRevision: 2,
  });
  const published =
    publication.kind === "publishing"
      ? await until(
          () =>
            call("trellis", "publicationStatus", {
              workflowId: "pond",
              publicationId: publication.publicationId,
            }),
          (value) => value.kind !== "publishing",
          "real Trellis publication completion",
        )
      : publication;
  assert.equal(published.kind, "published", JSON.stringify(published));
  const document = await call("trellis", "loadWorkflow", {
    workflowId: "pond",
    at: { commit: published.commit },
  });
  assert.deepEqual(document.definition, updated.definition);
  assert.ok(
    provider.requests.length > gitBefore,
    "the real publisher wrote Git before indexing its immutable publication",
  );
  const target = {
    workflowId: "pond",
    commit: published.commit,
    triggerId: "clock",
    bindings: {},
  };
  const armed = await call("trellis", "arm", target);
  assert.equal(armed.kind, "armed", JSON.stringify(armed));
  log(
    `PASS ${runtime}: actual Trellis publication/index and same-installation Git/Artifacts/Instance schedule admission`,
  );
  // Only after the existing producer and live trigger owner have succeeded
  // does this assertion name the missing external-webhook behavior.
  const webhook = await globalThis.fetch(
    `${origin}/api/installations/trellis/workflows/webhooks`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "create",
        target: {
          ...target,
          installationId: "trellis",
          triggerId: "hook",
          digest: await contentDigest(document.definition),
        },
        computerId: config.vars.OYSTER_COMPUTER_ID,
        verifier: "github",
      }),
    },
  );
  assert.equal(webhook.status, 200, "published Workflow webhook control");
  assert.equal(webhook.headers.get("cache-control"), "no-store");
  const disclosure = z
    .strictObject({
      kind: z.literal("created"),
      bindingId: z.string().min(1),
      installationId: z.literal("trellis"),
      secret: z.string().min(1),
    })
    .parse(await webhook.json());
  log(
    `PASS ${runtime}: published Workflow owner creates a no-store webhook disclosure`,
  );
  const body = "{}";
  const signature = createHmac("sha256", disclosure.secret)
    .update(body)
    .digest("hex");
  const deliver = () =>
    globalThis.fetch(
      `${origin}/api/installations/trellis/workflows/webhooks/${disclosure.bindingId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Delivery": "b2d64a8a-9890-4d91-a38b-000000000001",
          "X-Hub-Signature-256": `sha256=${signature}`,
        },
        body,
      },
    );
  const readRuns = async () =>
    z
      .array(runListItemSchema)
      .parse(await call("trellis", "listRuns", { workflowId: "pond" }));
  const accepted = await deliver();
  const runs = await until(
    readRuns,
    (rows) => rows.some((row) => row.triggerId === "hook"),
    "native webhook starts its durable Braid run",
  );
  const [run] = runs.filter((row) => row.triggerId === "hook");
  assert.equal(run.source, "event");
  assert.equal(run.commit, published.commit);
  await until(
    () => call("trellis", "runStatus", { runId: run.runId }),
    (status) => status.status === "complete",
    "native webhook run completes in its real engine",
  );
  assert.equal(runs.filter((row) => row.triggerId === "hook").length, 1);
  log(
    `Observed ${runtime}: recovery completed one signed-delivery run after native wake acknowledgement loss; HTTP ${accepted.status}`,
  );
  assert.equal(
    accepted.status,
    202,
    "durable signed admission survives a lost native wake acknowledgement",
  );
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  const receipt = z
    .strictObject({ accepted: z.literal(true), deliveryId: z.string().min(1) })
    .parse(await accepted.json());
  // Restart the actual local Worker over its own persisted state. A replay
  // must retain the same run, not manufacture another engine or reservation.
  await fixture.restart();
  const replay = await deliver();
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("cache-control"), "no-store");
  assert.deepEqual(await replay.json(), receipt);
  const replayed = (await readRuns()).filter((row) => row.triggerId === "hook");
  assert.deepEqual(
    replayed.map((row) => row.runId),
    [run.runId],
  );
  log(
    `PASS ${runtime}: lost native wake acknowledgement remains accepted; recovery completes one Braid run; restart/replay preserves delivery and run identity`,
  );
} catch (cause) {
  error(fixture.diagnostics());
  throw cause;
} finally {
  await fixture.close();
}
