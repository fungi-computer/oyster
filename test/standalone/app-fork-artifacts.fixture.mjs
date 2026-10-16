// A minimal stand-in for `@fungi.computer/burrow/cloudflare`'s
// `createCloudflareArtifacts`, substituted by `app-fork.native.mjs`'s module
// resolve hook. It exercises exactly the Artifacts surface
// `forkAppSource`/`recordTemplateSeed` depend on (ensure/fork/recover/read
// the default branch head), backed by one shared in-memory repository map, so
// `StandaloneRegistry.forkApp`/`publishSource` run as compiled, for real,
// without a live Artifacts account or real Git wire protocol.
const repos = new Map();

function info(name) {
  return {
    repository: { id: name, name, defaultBranch: "main" },
    mainHead: repos.get(name),
    disposition: repos.has(name) ? "existing" : "created",
  };
}

/** Seed (or overwrite) a repository's recorded main head, for test setup. */
export function seed(name, mainHead) {
  repos.set(name, mainHead);
}

export function createCloudflareArtifacts() {
  return {
    async ensureRepository(name) {
      if (!repos.has(name)) repos.set(name, "0".repeat(40));
      return { id: name, name, defaultBranch: "main" };
    },
    async readDefaultBranchHead(name) {
      return repos.get(name) ?? null;
    },
    async recoverForkRepository({ repository }) {
      return repos.has(repository) ? info(repository) : null;
    },
    async forkRepository({ repository, expectedMainHead }) {
      if (repos.has(repository)) return info(repository);
      repos.set(repository, expectedMainHead);
      return info(repository);
    },
    async resolveRepository(name) {
      return { id: name, name, defaultBranch: "main" };
    },
    async readBranchHeads(name) {
      const head = repos.get(name);
      return head === undefined ? [] : [head];
    },
    async readRefs(name) {
      const head = repos.get(name);
      return head === undefined
        ? []
        : [{ name: "refs/heads/main", hash: head }];
    },
    exchangeGit() {
      throw new Error("Git wire protocol is not exercised by this fixture");
    },
  };
}
