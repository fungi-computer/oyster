/** Run a nested repository without inheriting the caller's Git checkout. */
export function repositoryEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

/** Git environment carrying host-held request headers (credentials) only in
 * Git's own config environment: never argv, a URL or a trace. */
export function authenticatedGitEnvironment(
  headers: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
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
  for (const [name, value] of Object.entries(headers))
    if (!/^[A-Za-z0-9-]+$/u.test(name) || /[\r\n\0]/u.test(value))
      throw new Error("Git request header is invalid");
  // An empty first value resets any inherited extra headers.
  const config: (readonly [string, string])[] = [
    ["http.extraHeader", ""],
    ...Object.entries(headers).map(
      ([name, value]) => ["http.extraHeader", `${name}: ${value}`] as const,
    ),
    ["http.followRedirects", "false"],
  ];
  return {
    ...environment,
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(index)}`, key],
        [`GIT_CONFIG_VALUE_${String(index)}`, value],
      ]),
    ),
    GIT_CONFIG_COUNT: String(config.length),
    GIT_TRACE: "0",
    GIT_TRACE_CURL: "0",
  };
}

/** Git environment for one authenticated Artifacts fetch; caller validates token. */
export function artifactsGitEnvironment(token: string): NodeJS.ProcessEnv {
  return authenticatedGitEnvironment({ Authorization: `Bearer ${token}` });
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
