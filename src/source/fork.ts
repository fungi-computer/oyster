import { parseSourceRevision, type AppId } from "@fungi.computer/puffball";
import type { TeamAppPublisherRegistry } from "@fungi.computer/puffball/publisher";
import type { Artifacts } from "@fungi.computer/burrow";
import { templateRepositoryForApp } from "./template-repository.js";
import type { PublisherTemplateSeedReceipts } from "./seed-receipt.js";

export type AppSourceForkResult =
  | Readonly<{ kind: "forked"; appId: string; repository: string }>
  | Readonly<{ kind: "unauthorized" | "conflict" | "provider_unavailable" }>;

/** Fork a verified first-party template source into a Team-owned Artifacts
 * repository (named by the host) and register it as its own App, recovering
 * an existing fork idempotently. The
 * native Artifacts fork is asynchronous; `artifacts.forkRepository` already
 * owns waiting for it to become ready. */
export async function forkAppSource(
  input: Readonly<{
    teamId: string;
    platformAppId: AppId;
    appId: AppId;
    /** The destination Artifacts repository's full provider name. */
    repository: string;
  }>,
  ports: Readonly<{
    registry: Pick<TeamAppPublisherRegistry, "read" | "register">;
    artifacts: Pick<
      Artifacts,
      "recoverForkRepository" | "readDefaultBranchHead" | "forkRepository"
    >;
    receipts: Pick<PublisherTemplateSeedReceipts, "read">;
  }>,
): Promise<AppSourceForkResult> {
  const { teamId, platformAppId, appId, repository } = input;
  const { registry, artifacts, receipts } = ports;
  const platform = await registry.read(platformAppId);
  if (
    platform.kind !== "found" ||
    platform.registration.source.provider !== "artifacts" ||
    platform.registration.source.repository !==
      templateRepositoryForApp(platformAppId)
  )
    return { kind: "unauthorized" };
  const template = platform.registration.source.repository;
  let fork = await artifacts.recoverForkRepository({ template, repository });
  if (fork === null) {
    const head = await artifacts.readDefaultBranchHead(template);
    if (head === null) return { kind: "provider_unavailable" };
    const seedReceipt = await receipts.read(
      platformAppId,
      parseSourceRevision(`git:${head}`),
    );
    if (seedReceipt === null) return { kind: "conflict" };
    fork = await artifacts.forkRepository({
      template,
      repository,
      expectedMainHead: head,
    });
  }
  if (fork.repository.name !== repository) return { kind: "conflict" };
  const forkRevision = parseSourceRevision(`git:${fork.mainHead}`);
  if ((await receipts.read(platformAppId, forkRevision)) === null)
    return { kind: "conflict" };
  const registration = await registry.register({
    appId,
    teamId,
    source: { provider: "artifacts", repository, branch: "main" },
    templateSeed: { appId: platformAppId, revision: forkRevision },
  });
  if (registration.kind === "conflict") return { kind: "conflict" };
  return { kind: "forked", appId, repository };
}
