import { z } from "zod";
import type { BrowserMemberAction } from "./browser.js";
import {
  CloudBrowserLeaseNotFound,
  CloudBrowserUnavailable,
} from "./errors.js";
import type { BinaryResult } from "./operations.js";

/**
 * The person's live view of a paused cloud-browser lease, shared by both
 * hosts. It is request/response handlers, not a router: each host registers
 * three routes under its own admission (the Hub's Team chain, a standalone
 * Oyster's owner requirement in `authorization.ts`) and passes the door
 * that admission produced. The page never carries a bearer or a CDP URL;
 * every fetch is same-origin and rides the viewer's own session. It forwards
 * only the closed {@link BrowserMemberAction} set, and never reaches the model.
 */

/** One admitted viewer's door into one lease: `Browser.member` already bound to it. */
export type LiveViewDoor = (
  action: BrowserMemberAction,
  signal: AbortSignal,
) => Promise<BinaryResult | null>;

/** The three paths a host serves for one lease, relative to its own origin. */
export type LiveViewPaths = Readonly<{
  /** The page a member opens to watch and steer the lease. */
  view: string;
  /** The current screenshot of the lease's page. */
  frame: string;
  /** Where the page posts the member's clicks and typing. */
  input: string;
}>;

/** The host-relative paths for a lease whose live view is served under `base`. */
export function liveViewPaths(base: string): LiveViewPaths {
  return {
    view: `${base}/view`,
    frame: `${base}/frame`,
    input: `${base}/input`,
  };
}

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("screenshot") }),
  z.strictObject({
    kind: z.literal("click"),
    x: z.number().int().min(0).max(20_000),
    y: z.number().int().min(0).max(20_000),
  }),
  z.strictObject({ kind: z.literal("type"), text: z.string().max(10_000) }),
  z.strictObject({
    kind: z.literal("scroll"),
    deltaX: z.number().int().min(-100_000).max(100_000).default(0),
    deltaY: z.number().int().min(-100_000).max(100_000).default(0),
  }),
  z.strictObject({ kind: z.literal("resume") }),
]);

function failureStatus(cause: unknown): 404 | 502 | 503 {
  if (cause instanceof CloudBrowserLeaseNotFound) return 404;
  if (cause instanceof CloudBrowserUnavailable) return 503;
  return 502;
}

type Reply = Readonly<{ error: string }> | Readonly<{ ok: true }>;

function json(body: Reply, status: number): Response {
  return Response.json(body, { status });
}

/** The handlers for one lease's view, frame and input routes. */
export type LiveView = Readonly<{
  /** The HTML page a member opens to watch and steer the lease. */
  page: () => Response;
  /** The current screenshot of the lease's page. */
  frame: (signal: AbortSignal) => Promise<Response>;
  /** Applies the member's click or typing and answers whether it was accepted. */
  input: (request: Request, signal: AbortSignal) => Promise<Response>;
}>;

/**
 * Build the handlers for one admitted viewer and lease. `report` receives a
 * request body that did not decode, so the host can log it with its own sink.
 */
export function liveView(
  door: LiveViewDoor,
  paths: LiveViewPaths,
  report: (event: "input_body_unavailable", cause: unknown) => void,
): LiveView {
  return {
    page: () =>
      new Response(viewPage(paths), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
    frame: async (signal) => {
      try {
        const frame = await door({ kind: "screenshot" }, signal);
        if (frame === null) return json({ error: "no_frame" }, 502);
        return new Response(new Blob([frame.bytes.slice().buffer]), {
          status: 200,
          headers: {
            "content-type": frame.contentType,
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        return json({ error: "frame_unavailable" }, failureStatus(error));
      }
    },
    input: async (request, signal) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch (cause) {
        report("input_body_unavailable", cause);
        return json({ error: "invalid_action" }, 400);
      }
      const parsed = actionSchema.safeParse(body);
      if (!parsed.success) return json({ error: "invalid_action" }, 400);
      try {
        await door(parsed.data, signal);
        return json({ ok: true }, 200);
      } catch (error) {
        return json({ error: "input_failed" }, failureStatus(error));
      }
    },
  };
}

function viewPage(paths: LiveViewPaths): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Cloud browser</title>
<style>
  :root { --bg: #f6f5f2; --panel: #ffffff; --ink: #1c1b19; --muted: #6a6761; --line: #d9d6cf; --accent: #2f6f4e; --accent-ink: #ffffff; --live: #2f9e63; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161513; --panel: #201f1c; --ink: #ece9e2; --muted: #9a968d; --line: #36342f; --accent: #5cb987; --accent-ink: #10231a; --live: #5cd08f; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font: 15px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 1200px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
  header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; flex: 1; min-width: 12ch; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--live); flex: none; }
  .dot[data-state="idle"] { background: var(--muted); }
  .hint { color: var(--muted); margin: 0; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  .controls input { flex: 1; min-width: 12ch; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: inherit; font: inherit; }
  button { padding: 8px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: inherit; font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  #stage { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: hidden; }
  #frame { display: block; width: 100%; height: auto; cursor: crosshair; }
  #done { padding: 16px; margin: 0; }
</style>
</head>
<body>
<main>
  <header>
    <span class="dot" id="dot" data-state="live"></span>
    <h1>The Agent needs you in this browser</h1>
    <div class="controls"><button class="primary" id="done-button" type="button">Done</button></div>
  </header>
  <p class="hint" id="hint">Click the page to interact, type below, then press Done so the Agent can continue.</p>
  <div class="controls">
    <input id="text" type="text" autocomplete="off" placeholder="Text to type into the focused field" />
    <button id="send" type="button">Send text</button>
  </div>
  <div id="stage"><img id="frame" alt="Live cloud browser" /></div>
</main>
<script>
  const paths = ${JSON.stringify(paths)};
  const img = document.getElementById("frame");
  const dot = document.getElementById("dot");
  let finished = false;
  async function act(action) {
    const response = await fetch(paths.input, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    return response.ok;
  }
  async function refresh() {
    if (finished) return;
    const response = await fetch(paths.frame, { cache: "no-store" });
    dot.dataset.state = response.ok ? "live" : "idle";
    if (!response.ok) return;
    const previous = img.src;
    img.src = URL.createObjectURL(await response.blob());
    if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
  }
  img.addEventListener("click", async (event) => {
    const rect = img.getBoundingClientRect();
    await act({
      kind: "click",
      x: Math.round((event.clientX - rect.left) * (img.naturalWidth / rect.width)),
      y: Math.round((event.clientY - rect.top) * (img.naturalHeight / rect.height)),
    });
    await refresh();
  });
  document.getElementById("send").addEventListener("click", async () => {
    const field = document.getElementById("text");
    if (field.value) await act({ kind: "type", text: field.value });
    field.value = "";
    await refresh();
  });
  document.getElementById("done-button").addEventListener("click", async () => {
    if (!(await act({ kind: "resume" }))) return;
    finished = true;
    dot.dataset.state = "idle";
    document.querySelector("main").innerHTML = '<p id="done">Done. The Agent can drive the browser again.</p>';
  });
  refresh();
  setInterval(refresh, 1000);
</script>
</body>
</html>`;
}
