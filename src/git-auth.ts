/** Credential parsing never logs the presented header or its decoding error. */
/** A Workflow Git pass presented as `Authorization: Bearer` starts with this. */
export const workflowGitPassPrefix = "wgp.";
/** A build job's clone pass starts with this; only the host's egress presents it. */
export const buildGitPassPrefix = "obp.";

export function presentedGitKey(
  request: Request,
):
  | Readonly<{ kind: "key"; value: string }>
  | Readonly<{ kind: "absent" | "invalid" }> {
  const header = request.headers.get("Authorization");
  if (header === null) return { kind: "absent" };
  if (header.startsWith("Bearer ")) {
    const value = header.slice(7).trim();
    return value ? { kind: "key", value } : { kind: "invalid" };
  }
  if (!header.startsWith("Basic ")) return { kind: "invalid" };
  try {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(":");
    const value = colon === -1 ? "" : decoded.slice(colon + 1);
    return value ? { kind: "key", value } : { kind: "invalid" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidCharacterError")
      return { kind: "invalid" };
    throw error;
  }
}
