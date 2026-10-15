import { createRoot } from "react-dom/client";
import * as Schema from "effect/Schema";
import { AppGrid } from "@fungi.computer/caps/blocks/launcher-grid";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { Button } from "@fungi.computer/caps/components/button";
import { Sigil, isSigilName } from "@fungi.computer/sigils";

declare const OYSTER_SHELL_STYLES: string;

// This page ships its own tiny bundle (see scripts/build-page.mjs): only
// @fungi.computer/caps/styles.css is inlined as OYSTER_SHELL_STYLES, and
// Caps' Tailwind build only generates classes it finds referenced inside
// its own src/ tree. Utility and Tourtois-chrome class names written here
// never resolve to any rule, so the top bar renders with no height, no
// gutter and no flex layout at all. This page's own literal CSS, scoped to
// its own class names and built on Caps' theme tokens, is the only styling
// that actually reaches this bundle.
const PAGE_STYLES = `
  .oyster-public-bar {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    height: 2rem;
    min-height: 2rem;
    padding-inline: var(--spacing-lg, 1rem);
    gap: var(--spacing-sm, 0.5rem);
    background: var(--color-base-200);
    color: var(--color-base-content);
    box-shadow:
      inset 0 1px 0 color-mix(in oklab, white 24%, transparent),
      inset 0 -1px 0
        color-mix(in oklab, var(--color-base-content) 14%, var(--color-base-200));
    font-size: 0.75rem;
  }
  .oyster-public-title {
    font-weight: 750;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .oyster-public-spacer {
    flex: 1 1 auto;
  }
  .oyster-public-apps {
    padding: var(--spacing-xl, 1.5rem);
  }
  .oyster-public-apps .caps-app-grid {
    width: fit-content;
    max-width: 100%;
  }
`;

const configSchema = Schema.Struct({
  title: Schema.String,
  apps: Schema.Array(
    Schema.Struct({
      href: Schema.String,
      displayName: Schema.String,
      icon: Schema.NullOr(Schema.String),
    }),
  ),
});
const configElement = document.getElementById("oyster-public-config");
const root = document.getElementById("oyster-public-home");
if (configElement === null || root === null)
  throw new Error("Public home configuration missing");
const config = Schema.decodeUnknownSync(Schema.fromJsonString(configSchema))(
  configElement.textContent,
);
const styles = document.createElement("style");
styles.textContent = OYSTER_SHELL_STYLES;
document.head.append(styles);
const pageStyles = document.createElement("style");
pageStyles.textContent = PAGE_STYLES;
document.head.append(pageStyles);
const appearance = matchMedia("(prefers-color-scheme: dark)");
const setTheme = () => {
  document.documentElement.dataset.theme = appearance.matches
    ? "mocha"
    : "latte";
};
setTheme();
appearance.addEventListener("change", setTheme);
createRoot(root).render(
  <>
    <header className="oyster-public-bar">
      <strong className="oyster-public-title">{config.title}</strong>
      <span className="oyster-public-spacer" />
      <Button asChild variant="ghost" size="sm">
        <a href="/login">Owner sign in</a>
      </Button>
    </header>
    <div className="oyster-public-apps">
      {config.apps.length === 0 ? (
        <EmptyState
          variant="hint"
          title="No public Apps available"
          description="Public Apps appear here."
        />
      ) : (
        <AppGrid
          aria-label="Public Apps"
          size="lg"
          items={config.apps.map((app) => ({
            id: app.href,
            label: app.displayName,
            icon: (
              <Sigil
                name={
                  app.icon !== null && isSigilName(app.icon)
                    ? app.icon
                    : "installApps"
                }
              />
            ),
            onSelect: () => {
              window.location.assign(app.href);
            },
          }))}
        />
      )}
    </div>
  </>,
);
