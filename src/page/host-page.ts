import { mountInkDrawing, type InkDrawing } from "@fungi.computer/sprite/ink";
import * as z from "zod/mini";
import { signOutRefusalSchema } from "../owner-sign-out.js";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, showNotice } from "@fungi.computer/caps/components/toaster";
import "../host-page/styles.css";

const artSchema = z.object({
  width: z.number().check(z.positive()),
  height: z.number().check(z.positive()),
  ink: z.array(z.array(z.number())),
  coral: z.array(z.array(z.number())),
  fills: z.optional(
    z.object({
      ink: z.array(z.array(z.array(z.number()))),
      coral: z.array(z.array(z.array(z.number()))),
    }),
  ),
  dots: z.array(z.number()),
});

const panel = document.querySelector<HTMLElement>("[data-ink]");
const live = panel?.querySelector<HTMLElement>(".ink-live");
if (panel && live && panel.dataset.ink) {
  const plate = panel.querySelector<HTMLSourceElement>("[data-light-plate]");
  const updatePlate = () => {
    if (plate) {
      plate.media = document.documentElement.dataset.theme
        ? ""
        : "(prefers-color-scheme: light)";
      plate.srcset =
        (document.documentElement.dataset.theme === "mocha"
          ? plate.dataset.darkPlate
          : plate.dataset.lightPlate) ?? "";
    }
  };
  updatePlate();
  let drawing: InkDrawing | undefined;
  const controller = new AbortController();
  const redraw = () => {
    updatePlate();
    drawing?.redraw();
  };
  const theme = new MutationObserver(redraw);
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", redraw);
  window.addEventListener(
    "pagehide",
    () => {
      controller.abort();
      theme.disconnect();
      scheme.removeEventListener("change", redraw);
      drawing?.destroy();
      delete panel.dataset.ready;
    },
    { once: true },
  );
  const mount = async () => {
    try {
      const response = await fetch(panel.dataset.ink ?? "", {
        signal: controller.signal,
      });
      if (!response.ok) return;
      const art = artSchema.parse(await response.json());
      drawing = mountInkDrawing(live, {
        art,
        duration: 2.5,
        palette: () => {
          const style = getComputedStyle(panel);
          return {
            ink: style.getPropertyValue("--stipe-sketch-ink").trim(),
            coral: style.getPropertyValue("--color-primary").trim(),
          };
        },
      });
      const canvas = live.querySelector("canvas");
      if (canvas) canvas.style.height = "100%";
      panel.dataset.ready = "true";
    } catch (cause) {
      // Decoration is optional. Keep the approved static plate on any failure.
      if (!controller.signal.aborted)
        console.error(
          "Host page ink unavailable; keeping the static plate",
          cause,
        );
      live.replaceChildren();
      delete panel.dataset.ready;
    }
  };
  void mount();
}

document.querySelector<HTMLFormElement>("[data-auto-sign-in]")?.requestSubmit();

const signOutForm = document.querySelector<HTMLFormElement>(
  "[data-sign-out-everywhere]",
);
const signOutButton = signOutForm?.querySelector<HTMLButtonElement>(
  'button[type="submit"]',
);
/** The refusal's named cause, or "unrecognised" when the body is not one of the server's codes. */
async function refusalCause(
  response: Response,
): Promise<z.infer<typeof signOutRefusalSchema>["error"] | "unrecognised"> {
  try {
    return signOutRefusalSchema.parse(await response.json()).error;
  } catch {
    return "unrecognised";
  }
}

/** Name the real cause of a refused sign-out in plain words, never echoing the server body. */
async function signOutRefusal(response: Response): Promise<string> {
  const { status } = response;
  if (status === 401)
    return "Your sign-in has ended. Sign in again to sign out everywhere.";
  if (status === 403) {
    const cause = await refusalCause(response);
    if (cause === "origin_mismatch")
      return "This request didn't come from your Oyster's page.";
    if (cause === "owner_removed")
      return "You are no longer this Oyster's owner.";
    return "Your Oyster refused to end the sessions (403), so they may still be active.";
  }
  if (status >= 500)
    return `Your Oyster couldn't end the sessions (server error ${String(status)}), so they may still be active.`;
  return `Your Oyster refused to end the sessions (status ${String(status)}), so they may still be active.`;
}

if (signOutForm && signOutButton) {
  const toasterId = "oyster-owner-session-notices";
  let mounted = false;
  const notify = (message: string) => {
    if (!mounted) {
      mounted = true;
      const root = document.createElement("div");
      document.body.append(root);
      createRoot(root).render(createElement(Toaster, { id: toasterId }));
    }
    showNotice({ tone: "error", message }, toasterId);
  };
  // Retain bounded diagnostics without logging exception messages or credentials.
  const reportFailure = (cause: unknown): void => {
    console.error("Owner sign-out request failed", {
      errorKind: cause instanceof Error ? "error" : "non-error",
    });
  };
  const signOut = async () => {
    if (signOutButton.disabled) return;
    signOutButton.disabled = true;
    signOutButton.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(signOutForm.action, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        notify(await signOutRefusal(response));
        return;
      }
      window.location.assign(response.url);
    } catch (cause) {
      reportFailure(cause);
      notify("Could not reach your Oyster to sign out everywhere.");
    } finally {
      signOutButton.disabled = false;
      signOutButton.removeAttribute("aria-busy");
    }
  };
  signOutForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void signOut();
  });
}
