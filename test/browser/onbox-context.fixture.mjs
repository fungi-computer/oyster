/* global AbortSignal, URL, Response */
import { onboxBrowserSessions } from "../../src/browser/sessions.ts";
import { CloudBrowserUpstreamError } from "../../src/browser/errors.ts";
import { attachPage, navigatePage } from "../../src/browser/page.ts";

export default {
  async fetch(request, env) {
    const sessions = onboxBrowserSessions(env.ONBOX_BROWSER_ORIGIN);
    const signal = AbortSignal.timeout(20_000);
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode === "ready") return Response.json({ ready: true });
    if (mode === "absent") {
      try {
        await sessions.create({ keepAliveMs: 10_000 }, signal);
        throw new Error("Missing Chromium unexpectedly created a context");
      } catch (error) {
        if (
          !(error instanceof CloudBrowserUpstreamError) ||
          error.op !== "onbox.connect"
        )
          throw error;
        return Response.json({ refused: true });
      }
    }
    if (mode === "restart") {
      const id = new URL(request.url).searchParams.get("stale");
      if (!id) throw new Error("Missing stale browser context");
      let staleRejected = false;
      try {
        const stale = await sessions.connect(id, signal);
        stale.close();
      } catch (error) {
        if (
          !(error instanceof CloudBrowserUpstreamError) ||
          error.op !== "onbox.connect"
        )
          throw error;
        staleRejected = true;
      }
      const closed = await sessions.release(id, signal);
      const fresh = await sessions.create({ keepAliveMs: 10_000 }, signal);
      await sessions.release(fresh, signal);
      return Response.json({ staleRejected, closed, fresh: fresh !== id });
    }
    const first = await sessions.create({ keepAliveMs: 10_000 }, signal);
    const second = await sessions.create({ keepAliveMs: 10_000 }, signal);
    try {
      const read = async (id, cookie) => {
        const client = await sessions.connect(id, signal);
        try {
          const page = await attachPage(client);
          await navigatePage(page, new URL(env.PAGE_ORIGIN), 5_000);
          const sessionId = page.cdpSessionId;
          if (cookie)
            await client.call(
              "Network.setCookie",
              { name: "isolation", value: cookie, url: env.PAGE_ORIGIN },
              { sessionId },
            );
          const title = await client.call(
            "Runtime.evaluate",
            { expression: "document.title", returnByValue: true },
            { sessionId },
          );
          const cookies = await client.call(
            "Network.getCookies",
            { urls: [env.PAGE_ORIGIN] },
            { sessionId },
          );
          return {
            title: title.result.value,
            cookies: cookies.cookies
              .filter((entry) => entry.name === "isolation")
              .map((entry) => entry.value),
          };
        } finally {
          client.close();
        }
      };
      const firstCookies = await read(first, "first");
      const secondCookies = await read(second, "second");
      const firstAgain = await read(first);
      return Response.json({
        separate: first !== second,
        firstCookies,
        secondCookies,
        firstAgain,
        stale: first,
      });
    } finally {
      await sessions.release(second, signal);
      await sessions.confirmClosed(second, Date.now() + 2_000);
      // Keep first alive until Chromium exits so restart probes a real stale id.
    }
  },
};
