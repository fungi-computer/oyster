import { mountInkDrawing, type InkDrawing } from "@fungi.computer/sprite/ink";
import * as z from "zod/mini";
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
