// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { appRegion } from "@fungi.computer/agar/backend";
import { oysterRegionHost } from "../../src/page/region.js";

afterEach(() => vi.unstubAllGlobals());

it("the page opens the Region socket same-origin; the App never names it", async () => {
  const opened: string[] = [];
  class FakeWebSocket extends EventTarget {
    readyState = 1;
    constructor(url: URL) {
      super();
      opened.push(url.href);
    }
    send() {
      // The fixture records only the opened address.
      return undefined;
    }
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const region = appRegion.schema.parse(oysterRegionHost("/apps/notes/region"));
  await region.connect();
  const expected = new URL("/apps/notes/region", window.location.href);
  expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
  expect(opened).toEqual([expected.href]);
});
