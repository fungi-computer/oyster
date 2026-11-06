import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, CardContent } from "@fungi.computer/caps/components/card";

const docs = "https://docs.fungi.computer";
const step = (title: string, ...content: string[]) =>
  h(
    "li",
    null,
    h("h2", null, title),
    ...content.map((text) => h("p", null, text)),
  );

// This is an ordinary installed App. Keep the readiness script when editing it.
export const helloPage =
  "<!doctype html>" +
  renderToStaticMarkup(
    h(
      "html",
      { lang: "en", "data-theme": "latte" },
      h(
        "head",
        null,
        h("meta", { charSet: "utf-8" }),
        h("meta", {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        }),
        h("title", null, "Hello · Your first Oyster App"),
        h("link", { rel: "stylesheet", href: "./lesson.css" }),
      ),
      h(
        "body",
        null,
        h(
          "main",
          null,
          h("p", { className: "eyebrow" }, "Oyster · Your first App"),
          h("h1", null, "Hello from my first Oyster App"),
          h(
            "p",
            { className: "intro" },
            "You have a working App on your own computer. Make one small change and see it here.",
          ),
          h(
            Card,
            null,
            h(
              CardContent,
              null,
              h(
                "ol",
                null,
                step(
                  "Open the source",
                  "In your Oyster project, open hello-app/bundle/index.html in your editor. This page is yours to change.",
                ),
                step(
                  "Make it yours",
                  "Change the heading above to something you wrote. Keep the main.js script at the bottom: it tells Oyster this App is ready.",
                ),
                step(
                  "Commit your edit",
                  "Save the file, then commit it in the hello-app Git repository. Oyster builds committed source; unsaved or uncommitted edits will not appear.",
                ),
                step(
                  "Restart and open Hello",
                  "Press Ctrl-C in the terminal running your trial. From your Oyster project folder, run the command below. Open the new sign-in link and choose Hello again.",
                ),
              ),
              h(
                "pre",
                null,
                h("code", null, "npx @fungi.computer/oyster try ."),
              ),
            ),
          ),
          h(
            "nav",
            { "aria-label": "Next steps" },
            h(
              "a",
              {
                href: docs + "/agents/build-an-app.md",
                target: "_blank",
                rel: "noreferrer",
              },
              "Get the exact edit commands",
            ),
            h(
              "a",
              {
                href: docs + "/guides/run-your-own-oyster/#deploy-it",
                target: "_blank",
                rel: "noreferrer",
              },
              "Read the hosting guide",
            ),
          ),
          h(
            "p",
            { className: "note" },
            "This local trial needs no account or payment. Cloud hosting needs your own account and paid resources; the guide explains those before you deploy.",
          ),
        ),
        h("script", { type: "module", src: "./main.js" }),
      ),
    ),
  );

// Layout and typography only. Caps owns the Card styles.
export const helloLayout = `
html { --font-sans: "Nunito", sans-serif; --font-mono: "Maple Mono", monospace; --font-display: var(--font-sans); }
body { margin: 0; font-family: var(--font-sans); color: var(--color-base-content); background: var(--color-base-100); }
main { max-width: 760px; margin: auto; padding: clamp(20px, 5vw, 56px); }
h1 { font-size: clamp(28px, 5vw, 44px); line-height: 1.15; margin: 12px 0; overflow-wrap: anywhere; }
h2 { font-size: 18px; margin: 0 0 6px; }
p { line-height: 1.6; }
ol { list-style: decimal; padding-inline-start: 24px; display: grid; gap: 20px; }
li p { margin: 0; }
pre { overflow: auto; padding: 12px 0; font-family: var(--font-mono); }
nav { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
nav a { text-decoration: underline; padding-block: 10px; }
.eyebrow { font-family: var(--font-mono); font-size: 12px; }
.intro { font-size: 18px; margin-bottom: 28px; }
.note { margin-top: 16px; font-size: 14px; }
`;
