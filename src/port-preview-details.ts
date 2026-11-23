import { portPreviewEntrySchema } from "./port-preview-entry.js";

/** How long the confirmation waits for the Computer's name before it opens
 * without one. */
const portPreviewDetailsTimeoutMs = 5000;

function statusCause(status: number): string {
  if (status === 401 || status === 403)
    return `you are not signed in as this Oyster's owner (error ${String(status)})`;
  if (status === 404) return "this Computer was not found (error 404)";
  if (status === 429) return "too many requests (error 429)";
  if (status >= 500) return `server error ${String(status)}`;
  return `the server refused the request (error ${String(status)})`;
}

/** Read the Computer's name from the same entry route as JSON. A failure is
 * named once, in plain words, for a toast; it never stops the preview from
 * opening, because the Computer id is already on the page. */
export async function readPortPreviewDetails(
  url: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  } = {},
): Promise<
  | { kind: "loaded"; computerName: string | undefined }
  | { kind: "failed"; message: string }
> {
  const doFetch = options.fetch ?? fetch;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const timeoutMs = options.timeoutMs ?? portPreviewDetailsTimeoutMs;
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimer(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const fail = (
    cause: string,
  ):
    | { kind: "loaded"; computerName: string | undefined }
    | { kind: "failed"; message: string } => ({
    kind: "failed",
    message: `The Computer's name could not load: ${cause}. You can still open the preview.`,
  });
  try {
    const response = await doFetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return fail(statusCause(response.status));
    const parsed = portPreviewEntrySchema.safeParse(await response.json());
    if (!parsed.success)
      return fail("the server sent details Oyster could not read");
    return { kind: "loaded", computerName: parsed.data.computerName };
  } catch (cause) {
    if (state.timedOut)
      return fail(
        `your Oyster did not answer within ${String(Math.round(timeoutMs / 1000))} seconds`,
      );
    if (cause instanceof SyntaxError)
      return fail("the server sent details Oyster could not read");
    return fail("your connection dropped");
  } finally {
    clearTimer(timer);
  }
}
