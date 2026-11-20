import { bodyLimit } from "hono/body-limit";

/**
 * Refuse a request body over `maxSize` bytes while it is read, with a 413.
 * Content-Length is not trusted: a chunked body is counted as it arrives and
 * never buffered past the limit. Pass the result as a route's options.
 */
export const bodyAtMost = (maxSize: number, error = "Request too large") => ({
  middleware: [
    bodyLimit({
      maxSize,
      onError: () => Response.json({ error }, { status: 413 }),
    }),
  ],
});
