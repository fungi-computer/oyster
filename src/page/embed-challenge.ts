/**
 * The Turnstile check a site can require before it mints a visitor. The
 * embed document carries the public site key only when the owner asked for the
 * check and the host holds its keys; the token goes back with the first mint.
 */
type Turnstile = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
    },
  ): string;
  remove(widgetId: string): void;
};

declare global {
  var turnstile: Turnstile | undefined;
}

const scriptUrl =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstile(): Promise<Turnstile> {
  const loaded = globalThis.turnstile;
  if (loaded !== undefined) return Promise.resolve(loaded);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.addEventListener("load", () => {
      const api = globalThis.turnstile;
      if (api === undefined) reject(new Error("turnstile_unavailable"));
      else resolve(api);
    });
    script.addEventListener("error", () => {
      reject(new Error("turnstile_unavailable"));
    });
    document.head.append(script);
  });
}

/** Show the check over the chat until it passes, then hand back its token. */
export async function requestChallenge(siteKey: string): Promise<string> {
  const api = await loadTurnstile();
  const surface = document.createElement("div");
  surface.setAttribute("aria-label", "Security check");
  surface.className =
    "fixed inset-0 z-10 flex items-center justify-center bg-base-100";
  document.body.append(surface);
  try {
    return await new Promise<string>((resolve, reject) => {
      api.render(surface, {
        sitekey: siteKey,
        callback: resolve,
        "error-callback": () => {
          reject(new Error("turnstile_failed"));
        },
      });
    });
  } finally {
    surface.remove();
  }
}
