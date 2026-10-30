/** One admitted path for external and installation-authored repository writes. */
import {
  appGitPushFactSchema,
  gitPushQuestionSchema,
  gitPushVerdictSchema,
  gitWriterSchema,
  type AppGitPushFact,
  type GitBinding,
  type GitExchangeRequest,
  type GitExchangeResponse,
  type GitPushQuestion,
  type GitPushVerdict,
  type GitRefUpdate,
  type GitWriter,
} from "@fungi.computer/agar/git";
import { gitRepositoryNameSchema } from "@fungi.computer/puffball/git-representation";
import {
  acceptedRefs,
  parseReceivePack,
  refusalReport,
} from "@fungi.computer/agar/git-wire";
import type { HostActor } from "@fungi.computer/puffball/app-method-runtime";
import { defineIdFamily } from "@fungi.computer/cairn/id";

import type { AppDeclaration } from "@fungi.computer/puffball/app";
import type { Installation } from "./apps/installation.js";

/** Installation-scoped storage; transport and credentials stay with its provider adapter. */
export type GitStore = GitBinding;
/** Live host authority, reopened before every provider call. */
export type GitGrants = Readonly<{
  /** Reopen the host authority for this repository and requested scope. */
  admits(
    writer: GitWriter,
    repository: string,
    scope: "read" | "write",
  ): Promise<boolean>;
}>;
/** Reuse the live installation/verified Release rule without opening provider storage. */
export function createInstallationGitAdmission(
  ports: Readonly<{
    currentInstallation(): Promise<Installation | null>;
    declaration(current: Installation): Promise<AppDeclaration | null>;
  }>,
): GitGrants["admits"] {
  return async () => {
    const current = await ports.currentInstallation();
    if (current === null) return false;
    const declaration = await ports.declaration(current);
    return declaration?.capabilities.includes("git.repository") === true;
  };
}

/** Repository rules owned by the selected App; a missing or malformed answer refuses. */
export type GitPolicy = Readonly<{
  /** Ask the selected App to decide every ref update in the whole push. */
  authorize(question: GitPushQuestion): Promise<GitPushVerdict>;
}>;
/** Durable accepted-ref journal; record commits before the provider result is acknowledged. */
export type GitJournal = Readonly<{
  /** Read the last durably accepted hash for a ref, or null if unknown. */
  tip(repository: string, ref: string): Promise<string | null>;
  /** Persist accepted refs and their fact before acknowledging the push. */
  record(fact: AppGitPushFact): Promise<void>;
}>;
/** Host-held read/write path; Apps receive only its installation-authored binding. */
export type AdmittedGit = Readonly<{
  /** Admit an external writer through host authority, App policy and the journal. */
  push(
    writer: Extract<GitWriter, { kind: "actor" }>,
    repository: string,
    request: GitExchangeRequest,
  ): Promise<GitExchangeResponse>;
  /** Recheck host read authority before exchanging provider bytes. */
  read(
    writer: Extract<GitWriter, { kind: "actor" }>,
    repository: string,
    request: GitExchangeRequest,
  ): Promise<GitExchangeResponse>;
  /** Bind installation-authored operations; null attribution is lifecycle-only. */
  binding(onBehalfOf: HostActor | null): GitBinding;
}>;
const ids = defineIdFamily({
  family: "oyster-git-push",
  version: 1,
  kinds: { event: { prefix: "gitpush" } },
});
const ZERO = "0".repeat(40);
const MAX_BYTES = 64 * 1024 * 1024;

/** Fixed order: host grant, Workflow ceiling, App policy, provider exchange, durable journal. */
export function createAdmittedGit(
  ports: Readonly<{
    installationId: string;
    store: GitStore;
    grants: GitGrants;
    policy: GitPolicy;
    journal: GitJournal;
    /** Host-held invocation closure, checked after asynchronous authority admission. */
    beforeProvider?: (() => void) | undefined;
  }>,
): AdmittedGit {
  const { store, grants, policy, journal } = ports;
  async function admit(
    writer: GitWriter,
    repository: string,
    scope: "read" | "write",
  ) {
    gitRepositoryNameSchema.parse(repository);
    gitWriterSchema.parse(writer);
    if (
      writer.kind === "installation" &&
      writer.installationId !== ports.installationId
    )
      throw new Error("Git installation authority mismatch");
    if (!(await grants.admits(writer, repository, scope)))
      throw new Error("Git host grant refused");
    ports.beforeProvider?.();
  }
  const refusal = (
    updates: readonly GitRefUpdate[],
    capabilities: readonly string[],
    verdict: GitPushVerdict & { allowed: false },
  ): GitExchangeResponse => ({
    status: 200,
    headers: {
      "content-type": "application/x-git-receive-pack-result",
      "cache-control": "no-store",
    },
    body: refusalReport(verdict, updates, capabilities),
  });
  async function exchange(
    writer: GitWriter,
    repository: string,
    request: GitExchangeRequest,
  ): Promise<GitExchangeResponse> {
    if (request.service !== "receive-pack") {
      await admit(writer, repository, "read");
      return store.exchange(repository, request);
    }
    if (request.phase === "advertise") {
      await admit(writer, repository, "write");
      return store.exchange(repository, request);
    }
    if (request.body === null || request.body.byteLength > MAX_BYTES)
      throw new Error("Invalid or oversized Git push");
    const parsed = parseReceivePack(request.body);
    if (parsed.kind === "invalid")
      return {
        status: 400,
        headers: {},
        body: new TextEncoder().encode(`Invalid Git push: ${parsed.reason}`),
      };
    if (parsed.kind === "probe") {
      // Git's pre-flight for a chunked push asks only whether a write would
      // be admitted; the pack follows in the next request.
      await admit(writer, repository, "write");
      return {
        status: 200,
        headers: {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-store",
        },
        body: new Uint8Array(),
      };
    }
    const { updates, capabilities } = parsed;
    await admit(writer, repository, "write");
    if (writer.kind === "actor") {
      const outside =
        writer.workflow === undefined
          ? []
          : updates.filter(
              ({ ref }) => !writer.workflow?.branches.includes(ref),
            );
      if (outside.length > 0)
        return refusal(updates, capabilities, {
          allowed: false,
          refused: outside.map(({ ref }) => ({
            ref,
            message: "outside the Workflow branch grant",
          })),
        });
      const question = gitPushQuestionSchema.parse({
        repository,
        writer,
        updates,
      });
      const verdict = gitPushVerdictSchema.parse(
        await policy.authorize(question),
      );
      if (!verdict.allowed) return refusal(updates, capabilities, verdict);
    }
    const unexplained: { ref: string; journaled: string | null }[] = [];
    for (const { ref, before } of updates) {
      const tip = await journal.tip(repository, ref);
      if ((before === ZERO ? null : before) !== tip)
        unexplained.push({ ref, journaled: tip });
    }
    // Reopen the grant after asynchronous App/journal work, immediately before I/O.
    await admit(writer, repository, "write");
    const response = await store.exchange(repository, request);
    if (response.status < 200 || response.status >= 300) return response;
    const accepted = acceptedRefs(
      response.body,
      capabilities.includes("side-band") ||
        capabilities.includes("side-band-64k"),
    );
    const moved = updates.filter(({ ref }) => accepted.has(ref));
    if (moved.length > 0) {
      const fact = appGitPushFactSchema.parse({
        repository,
        writer,
        updates: moved,
        eventId: ids.event.generate(),
      });
      const unknownMoves = unexplained.filter(({ ref }) => accepted.has(ref));
      if (unknownMoves.length > 0) fact.unexplained = unknownMoves;
      await journal.record(fact);
    }
    return response;
  }
  return {
    push: exchange,
    async read(writer, repository, request) {
      if (request.service !== "upload-pack")
        throw new Error("Git read cannot push");
      await admit(writer, repository, "read");
      return store.exchange(repository, request);
    },
    binding(onBehalfOf) {
      const writer: GitWriter = {
        kind: "installation",
        installationId: ports.installationId,
        onBehalfOf,
      };
      return {
        async create(name, options) {
          await admit(writer, name, "write");
          return store.create(name, options);
        },
        async fork(source, target, options) {
          await admit(writer, source, "read");
          await admit(writer, target, "write");
          return store.fork(source, target, options);
        },
        async cloneUrl(name) {
          await admit(writer, name, "read");
          return store.cloneUrl(name);
        },
        async info(name) {
          await admit(writer, name, "read");
          return store.info(name);
        },
        async delete(name) {
          await admit(writer, name, "write");
          return store.delete(name);
        },
        async log(name, options) {
          await admit(writer, name, "read");
          return store.log(name, options);
        },
        async readCommit(name, hash) {
          await admit(writer, name, "read");
          return store.readCommit(name, hash);
        },
        async readTree(name, hash) {
          await admit(writer, name, "read");
          return store.readTree(name, hash);
        },
        async readBlob(name, hash) {
          await admit(writer, name, "read");
          return store.readBlob(name, hash);
        },
        async refs(name) {
          await admit(writer, name, "read");
          return store.refs(name);
        },
        exchange: (name, request) => exchange(writer, name, request),
      };
    },
  };
}
