import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TradingCard } from "@fungi.computer/caps/components/trading-card";
import { Alert } from "@fungi.computer/caps/components/alert";
import { Status } from "@fungi.computer/caps/components/status";
import { Button } from "@fungi.computer/caps/components/button";
import { Input } from "@fungi.computer/caps/components/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@fungi.computer/caps/components/card";
import { fungiFaviconHref } from "@fungi.computer/sigils/favicon";
import {
  permissionScreen,
  type AppPermissionsViewData,
} from "./apps/permissions.js";
import { permissionCatalog } from "./apps/catalog.js";

const docs = "https://docs.fungi.computer";

/** Human-facing states only. API refusals keep their original wire format. */
export type HostPageState =
  | "permissions"
  | "root"
  | "empty"
  | "login"
  | "login-invalid"
  | "key-help"
  | "signing-in"
  | "not-found"
  | "server-error"
  | "access-denied"
  | "desktop-missing";

const copy = {
  permissions: [
    "Choose what this App can do.",
    "Oyster · App permissions",
    "Review the requested access. To decline, return to Apps without saving or confirming a change.",
  ],
  root: [
    "Your Apps, all together.",
    "Oyster · App directory",
    "Open an installed App, or return to your desktop. These Apps belong to this Oyster.",
  ],
  empty: [
    "A little room to grow.",
    "No Apps installed yet.",
    "Your Oyster is running. Install an App to give it something to open.",
  ],
  login: [
    "Welcome.",
    "Your Oyster · sign in",
    "Use the owner key saved with this Oyster. It stays private; it never belongs in a shared link.",
  ],
  "login-invalid": [
    "That key didn’t open it.",
    "Sign-in needs another try",
    "Check that this is the key for this Oyster. Your saved Apps are unchanged.",
  ],
  "key-help": [
    "Let’s find your key.",
    "Owner access",
    "For a local trial, the key is saved in .oyster-owner inside your Oyster project. Open that file privately and paste the key into sign-in.",
  ],
  "signing-in": [
    "Opening your Oyster…",
    "One-time sign-in",
    "This private link signs you in on this computer. It works once. Continue to your Oyster below if it does not open automatically.",
  ],
  "not-found": [
    "Nothing growing here.",
    "404",
    "This address doesn’t point to an available page. Your desktop is a good place to start again.",
  ],
  "server-error": [
    "That didn’t go through.",
    "Oyster · request failed",
    "Oyster couldn’t finish this request. Check its status before retrying a change; the result may still be unknown.",
  ],
  "access-denied": [
    "This App is out of reach.",
    "403 · access unavailable",
    "The current sign-in cannot open this App. Ask its owner for access, or return to your desktop.",
  ],
  "desktop-missing": [
    "Your desktop needs a hand.",
    "Desktop · unavailable",
    "Oyster is running, but your selected desktop is missing, disabled or awaiting approval. See the terminal for the build error if local setup failed.",
  ],
} satisfies Record<HostPageState, readonly [string, string, string]>;

const abilities = {
  permissions: [
    "You choose the access",
    "Check the App and Release below.",
    "Review each permission before saving.",
    "Leave unchanged if you are unsure.",
  ],
  root: [
    "Choose your next App",
    "Open an App from the directory.",
    "Review App access if approval is needed.",
    "Read the quickstart to install another.",
  ],
  empty: [
    "Install your first App",
    "Follow the quickstart for this host.",
    "Build and install your first App.",
    "Return here after installation succeeds.",
  ],
  login: [
    "Unlock this Oyster",
    "Open .oyster-owner in your project.",
    "Paste the key into sign-in.",
    "Keep the key out of shared links.",
  ],
  "login-invalid": [
    "Check the owner key",
    "Use this Oyster’s owner key.",
    "Copy the full key without extra spaces.",
    "Try again or find your key.",
  ],
  "key-help": [
    "Recover owner access",
    "Check your project’s .oyster-owner file.",
    "Paste its key into sign-in.",
    "If it is gone, read recovery steps.",
  ],
  "signing-in": [
    "Finish signing in",
    "Let this single-use link finish.",
    "Continue below if it does not.",
    "Use your saved key if needed.",
  ],
  "not-found": [
    "Find an available page",
    "Return to your Oyster.",
    "Choose an installed App.",
    "Check docs for an old address.",
  ],
  "server-error": [
    "Check before retrying",
    "Check that Oyster is running.",
    "Read the terminal’s diagnostic.",
    "Confirm the result before retrying.",
  ],
  "access-denied": [
    "Find the right access",
    "Check which sign-in you are using.",
    "Ask the owner for App access.",
    "Switch sign-in or return home.",
  ],
  "desktop-missing": [
    "Repair your desktop",
    "Read the terminal’s build error.",
    "Review desktop App access.",
    "Retry the same trial after fixing it.",
  ],
} satisfies Record<HostPageState, readonly [string, string, string, string]>;

export type HostPageOptions = Readonly<{
  state: HostPageState;
  title?: string;
  status?: number;
  stylesheets?: readonly string[];
  /** The one-time helper obtains all decorative assets from the live Oyster. */
  oysterUrl?: string;
  /** Reachable installations only; no forbidden App metadata enters the view. */
  apps?: readonly Readonly<{
    id: string;
    name: string;
    accessHref?: string;
  }>[];
  reset?: boolean;
  /** Login only: this browser has signed in to this Oyster before. */
  returning?: boolean;
  /** Login only: the visitor arrived through a one-time link that was already used. */
  usedLink?: boolean;
  /** Only the single-use helper passes a key, in a POST field, never a URL. */
  signIn?: Readonly<{ action: string; key: string }>;
  permissions?: Readonly<{
    config: AppPermissionsViewData;
    script: string;
  }>;
}>;

function link(label: string, href: string, secondary = false): ReactNode {
  return h(
    Button,
    { asChild: true, variant: secondary ? "outline" : "primary" },
    h("a", { href }, label),
  );
}

/** The optional, content-addressed illustration/layout assets. */
async function pageAssets() {
  return (await import("#host-page-assets")).hostPageAssets;
}

/** Serve only qualified build outputs; no filesystem or runtime image tools. */
export async function hostPageAsset(path: string): Promise<Response> {
  const found = Object.values(await pageAssets()).find(
    (asset) => asset.path === path,
  );
  if (!found) return new Response("Not found", { status: 404 });
  const body =
    found.encoding === "base64"
      ? Uint8Array.from(atob(found.source), (character) =>
          character.charCodeAt(0),
        )
      : found.source;
  return new Response(body, {
    headers: {
      "Content-Type": found.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function pageContent(options: HostPageOptions, url: (path: string) => string) {
  const { state, signIn } = options;
  const content: ReactNode[] = [];
  const actions: ReactNode[] = [];
  if (state === "permissions" && options.permissions) {
    const { config } = options.permissions;
    const screen = permissionScreen({
      ...config.permissions,
      resources: config.resources,
      canEdit: config.canEdit,
    });
    content.push(
      h("h2", null, `${config.appName} permissions`),
      h(
        "p",
        { className: "detail" },
        "App: ",
        config.appId,
        h("br"),
        "Installation: ",
        config.installationId,
        h("br"),
        "Release: ",
        h("code", null, config.artifactDigest),
      ),
      h(
        "div",
        { id: "oyster-consent" },
        h(
          "p",
          { role: "status" },
          "Changes apply only after you save or confirm.",
        ),
        h(
          "ul",
          { className: "form-stack" },
          ...config.permissions.declaredOperations.capabilities.map(
            ({ capability }) =>
              h(
                "li",
                { key: capability },
                h(
                  "strong",
                  null,
                  permissionCatalog[capability].label,
                  permissionCatalog[capability].consent === "affordance"
                    ? " · No approval required"
                    : screen.pending.includes(capability)
                      ? " · Needs review"
                      : " · Approved",
                ),
                h("p", null, permissionCatalog[capability].description),
                permissionCatalog[capability].warning
                  ? h("p", null, permissionCatalog[capability].warning)
                  : null,
              ),
          ),
        ),
        h(
          "noscript",
          null,
          h(
            "p",
            null,
            "JavaScript is needed to review and change permissions. No permissions have changed.",
          ),
        ),
        h(
          "div",
          { className: "actions" },
          link("Back to Apps", url("/"), true),
        ),
      ),
    );
    return { content, actions };
  }
  if (state === "login" || state === "login-invalid") {
    content.push(
      h(
        "form",
        { method: "post", action: url("/login"), className: "form-stack" },
        state === "login-invalid"
          ? h(
              "p",
              { className: "error-copy", role: "alert" },
              "The key wasn’t accepted. Please check it and try again.",
            )
          : null,
        state === "login" && options.usedLink === true
          ? h(
              Alert,
              { tone: "warning", role: "status" },
              h(
                "div",
                { className: "notice" },
                h(Status, {
                  glyph: "dot",
                  tone: "warning",
                  "aria-hidden": true,
                }),
                h(
                  "span",
                  null,
                  "This link was already used. Paste the key from ",
                  h("code", null, ".oyster-owner"),
                  " in your Oyster project.",
                ),
              ),
            )
          : null,
        h("label", { htmlFor: "owner-key" }, "Owner key"),
        h(Input, {
          id: "owner-key",
          name: "key",
          type: "password",
          required: true,
          autoComplete: "current-password",
          placeholder: "Paste your owner key",
          "aria-invalid": state === "login-invalid" ? true : undefined,
        }),
        options.usedLink === true
          ? null
          : h(
              "p",
              { className: "helper field-hint" },
              "For a local trial: ",
              h("code", null, ".oyster-owner"),
              " in your Oyster project.",
            ),
        h(
          "div",
          { className: "actions" },
          h(
            Button,
            { type: "submit" },
            state === "login" ? "Sign in" : "Try again",
          ),
          link("Find my key", url("/login/key-help"), true),
        ),
      ),
    );
  } else if (state === "signing-in" && signIn) {
    content.push(
      h(
        "form",
        { method: "post", action: signIn.action, "data-auto-sign-in": true },
        h("input", { type: "hidden", name: "key", value: signIn.key }),
        h(
          "div",
          { className: "actions" },
          h(Button, { type: "submit" }, "Continue to Oyster"),
          link("Having trouble?", url("/login/key-help"), true),
        ),
      ),
    );
  } else if (state === "key-help") {
    content.push(
      h(
        "p",
        { className: "detail" },
        "If the original key is gone, follow the owner recovery instructions. Oyster cannot reveal or reconstruct it. No key reset happens from this page.",
      ),
    );
    actions.push(
      link("Back to sign-in", url("/login")),
      link("Read recovery steps", `${docs}/guides/run-your-own-oyster`, true),
    );
  } else if (
    state === "root" ||
    state === "empty" ||
    state === "desktop-missing"
  ) {
    if (options.reset)
      content.push(
        h(
          "p",
          { className: "detail" },
          "This update reset your installed Apps. Reinstall them with npx @fungi.computer/oyster install-apps.",
        ),
      );
    if (state === "empty")
      content.push(
        h(
          "p",
          { className: "detail" },
          "Install Apps with ",
          h("code", null, "npx @fungi.computer/oyster install-apps"),
          ". Follow the quickstart for your local or hosted Oyster.",
        ),
      );
    if ((options.apps?.length ?? 0) > 0)
      content.push(
        h(
          "div",
          { className: "app-grid" },
          ...(options.apps ?? []).map((app) =>
            h(
              Card,
              { key: app.id, variant: "interactive" },
              h(
                CardHeader,
                null,
                h(
                  CardTitle,
                  null,
                  h(
                    "a",
                    { href: url(`/apps/${encodeURIComponent(app.id)}/`) },
                    app.name,
                  ),
                ),
              ),
              app.accessHref
                ? h(
                    CardContent,
                    null,
                    h("a", { href: url(app.accessHref) }, "App access"),
                  )
                : null,
            ),
          ),
        ),
      );
    if (state === "desktop-missing")
      content.push(
        h(
          "p",
          { className: "detail" },
          "For a local trial, retry the original try command in your terminal with the same project directory and port. If approval was revoked, use App access to review the desktop’s permissions.",
        ),
      );
    actions.push(
      link("Read the quickstart", `${docs}/oyster-quickstart`),
      link("Install an App", `${docs}/agents/build-an-app.md`, true),
    );
  } else {
    if (state === "server-error")
      content.push(
        h(
          "details",
          { className: "detail" },
          h("summary", null, "Show details"),
          h(
            "p",
            null,
            "Diagnostic: REQUEST_FAILED. Check the terminal or host logs for the original error. No credentials are shown here.",
          ),
        ),
      );
    actions.push(
      link(
        state === "server-error" ? "Check Oyster" : "Back to desktop",
        url("/"),
      ),
      link(
        state === "access-denied" ? "Switch sign-in" : "Open the docs",
        state === "access-denied" ? url("/login") : docs,
        true,
      ),
    );
  }
  return { content, actions };
}

function illustration(
  state: HostPageState,
  assetUrl: (name: string) => string | undefined,
): ReactNode {
  const eyebrow = copy[state][1];
  const [ability, ...steps] = abilities[state];
  const keyArt = [
    "permissions",
    "login",
    "login-invalid",
    "key-help",
    "signing-in",
    "access-denied",
  ].includes(state);
  const art = keyArt
    ? "key"
    : state === "not-found"
      ? "offline"
      : "desktop-build";
  return h(TradingCard, {
    name: keyArt
      ? "A little help"
      : art === "offline"
        ? "Page not found"
        : "Room to grow",
    stage: "OYSTER",
    stat: "✦",
    finish: "holo",
    style: { aspectRatio: "auto" },
    art: h(
      "div",
      {
        className: "ink-art",
        "data-ink": assetUrl(`${art}.json`),
        "aria-hidden": true,
      },
      h(
        "picture",
        null,
        h("source", {
          "data-light-plate": assetUrl(`${art}-light.avif`),
          "data-dark-plate": assetUrl(`${art}-dark.avif`),
          media: "(prefers-color-scheme: light)",
          srcSet: assetUrl(`${art}-light.avif`),
        }),
        h("img", {
          className: "ink-fallback",
          src: assetUrl(`${art}-dark.avif`),
          alt: "",
        }),
      ),
      h("div", { className: "ink-live" }),
    ),
    typeLine: state === "not-found" ? "Off the map" : eyebrow,
    move: {
      name: ability,
      children: h(
        "ol",
        { className: "ability-steps" },
        ...steps.map((step) => h("li", { key: step }, step)),
      ),
    },
    setNumber: "Oyster",
    rarity: "✦ Companion",
  });
}

/** One server-rendered Caps composition, usable without styles, art or JS. */
export async function hostPage(options: HostPageOptions): Promise<Response> {
  const { state, title = "Oyster" } = options;
  const [baseHeading, eyebrow, description] = copy[state];
  const heading =
    state === "login" && options.returning === true
      ? "Welcome back."
      : baseHeading;
  const url = (path: string) =>
    options.oysterUrl ? new URL(path, options.oysterUrl).href : path;
  // A failed decorative module must still leave the form and recovery readable.
  let assets: Awaited<ReturnType<typeof pageAssets>>;
  try {
    assets = await pageAssets();
  } catch (cause) {
    console.error("Host page decoration unavailable", cause);
    assets = {};
  }
  const assetUrl = (name: string) => {
    const asset = assets[name];
    return asset ? url(asset.path) : undefined;
  };
  const { content, actions } = pageContent(options, url);
  const body = renderToStaticMarkup(
    h(
      "html",
      { lang: "en" },
      h(
        "head",
        null,
        h("meta", { charSet: "utf-8" }),
        h("meta", {
          name: "viewport",
          content: "width=device-width,initial-scale=1",
        }),
        h("meta", { name: "referrer", content: "no-referrer" }),
        h("title", null, `${heading} · ${title}`),
        h("link", {
          rel: "icon",
          type: "image/svg+xml",
          href: fungiFaviconHref,
        }),
        ...(options.stylesheets ?? []).map((href) =>
          h("link", { key: href, rel: "stylesheet", href: url(href) }),
        ),
        assetUrl("layout.css")
          ? h("link", { rel: "stylesheet", href: assetUrl("layout.css") })
          : null,
      ),
      h(
        "body",
        null,
        h(
          "header",
          { className: "page-header" },
          h(
            "div",
            { className: "brand" },
            "oyster",
            h("small", null, "by fungi.computer"),
          ),
          h(
            "nav",
            { className: "page-nav", "aria-label": "Oyster" },
            h("a", { href: url("/") }, "Your Oyster"),
            h("a", { href: docs }, "Help & docs"),
          ),
        ),
        h(
          "main",
          { className: "stage" },
          h("div", { className: "card-holder" }, illustration(state, assetUrl)),
          h(
            "section",
            { className: "copy", "aria-labelledby": "page-heading" },
            h("p", { className: "eyebrow" }, eyebrow),
            h("h1", { className: "heading", id: "page-heading" }, heading),
            h("p", { className: "description" }, description),
            ...content,
            actions.length
              ? h("div", { className: "actions" }, ...actions)
              : null,
            h(
              "p",
              { className: "helper" },
              state === "login" || state === "login-invalid"
                ? "Your key is sent only to this Oyster."
                : state === "not-found"
                  ? null
                  : h(
                      "a",
                      { href: `${docs}/agents/index.md` },
                      "Hand your LLM the setup guide →",
                    ),
            ),
          ),
        ),
        h(
          "footer",
          { className: "page-footer" },
          h("span", null, "Oyster · A home for your Apps"),
        ),
        assetUrl("host-page.js")
          ? h("script", { type: "module", src: assetUrl("host-page.js") })
          : null,
        options.permissions
          ? h("script", {
              type: "application/json",
              id: "oyster-consent-config",
              dangerouslySetInnerHTML: {
                __html: JSON.stringify(options.permissions.config).replaceAll(
                  "<",
                  "\\u003c",
                ),
              },
            })
          : null,
        options.permissions
          ? h("script", { type: "module", src: options.permissions.script })
          : null,
      ),
    ),
  );
  return new Response(`<!doctype html>${body}`, {
    status: options.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      Vary: "Accept",
    },
  });
}
