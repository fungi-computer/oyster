/** Run a nested repository without inheriting the caller's Git checkout. */
export function repositoryEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

/** Git environment for one authenticated Artifacts fetch; caller validates token. */
export function artifactsGitEnvironment(token: string): NodeJS.ProcessEnv {
  const excludedEnvironmentNames = new Set([
    "GIT_CURL_VERBOSE",
    "CLOUDFLARE_API_TOKEN",
    "ARTIFACTS_API_TOKEN",
    "ARTIFACTS_REPO_TOKEN",
    "ARTIFACTS_TOKEN",
  ]);
  const environment = Object.fromEntries(
    Object.entries(repositoryEnvironment()).filter(
      ([name]) =>
        !name.startsWith("GIT_TRACE") && !excludedEnvironmentNames.has(name),
    ),
  );
  return {
    ...environment,
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.extraHeader",
    GIT_CONFIG_VALUE_1: `Authorization: Bearer ${token}`,
    GIT_CONFIG_KEY_2: "http.followRedirects",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_COUNT: "3",
    GIT_TRACE: "0",
    GIT_TRACE_CURL: "0",
  };
}

/** Credential-free private route used by the hosted Publisher Git client. */
export function hostedArtifactsGitRemote(
  endpoint: string,
  repository: string,
): string {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(repository))
    throw new Error("Artifacts repository is invalid");
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch (cause) {
    throw new Error("Publisher endpoint is invalid", { cause });
  }
  const localHttp =
    base.protocol === "http:" &&
    (base.hostname === "localhost" || base.hostname === "127.0.0.1");
  if (
    (base.protocol !== "https:" && !localHttp) ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0
  )
    throw new Error("Publisher endpoint is invalid");
  return new URL(
    `/v1/artifacts/git/${encodeURIComponent(repository)}.git`,
    base,
  ).toString();
}
