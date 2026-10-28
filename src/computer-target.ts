/** The query parameter that carries a window's Computer routing hint. */
export const computerTargetParam = "computerId";

/** Serialize a window's routing hint. The server must admit it through the live
 * owner and fleet before constructing that request's workspace. */
export function computerTargetUrl(path: string, computerId?: string): string {
  if (computerId === undefined) return path;
  const url = new URL(path, "https://oyster.invalid");
  url.searchParams.set(computerTargetParam, computerId);
  return url.pathname + url.search;
}
