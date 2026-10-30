import { createRoot } from "react-dom/client";
import {
  CenteredCard,
  CardHeader,
  CardTitle,
  CardContent,
} from "@fungi.computer/caps/components/card";
import { Button } from "@fungi.computer/caps/components/button";
import { appPermissionPageSchema } from "../apps/permissions.js";
import {
  AppPermissionsView,
  type PermissionLeaveState,
} from "./app-permissions.js";
import { createOysterAppPermissionsPort } from "./app-permissions-port.js";
import { bootstrapIsolatedPageTheme } from "./isolated-page-theme.js";

declare const OYSTER_SHELL_STYLES: string;
const element = document.getElementById("oyster-consent-config");
const root = document.getElementById("oyster-consent");
if (element === null || root === null)
  throw new Error("Consent configuration missing");
const config = appPermissionPageSchema.parse(JSON.parse(element.textContent));
const styles = document.createElement("style");
styles.textContent = OYSTER_SHELL_STYLES;
document.head.append(styles);
bootstrapIsolatedPageTheme();

const framed = window.parent !== window;
if (framed) {
  // The embedding Settings section owns page padding and scrolling.
  document.documentElement.style.minHeight = "0";
  document.body.style.minHeight = "0";
}
function notify(event: "accepted" | "state", state: PermissionLeaveState) {
  if (framed)
    window.parent.postMessage(
      { type: "oyster.permissions", event, state },
      window.location.origin,
    );
}

const editor = (
  <AppPermissionsView
    port={createOysterAppPermissionsPort()}
    appKey={config.installationId}
    onAccepted={() => {
      notify("accepted", "clean");
      return Promise.resolve();
    }}
    onStateChange={(state) => {
      notify("state", state);
    }}
  />
);

createRoot(root).render(
  framed ? (
    <main style={{ display: "flow-root" }}>{editor}</main>
  ) : (
    <CenteredCard>
      <CardHeader>
        <CardTitle>{config.appName} permissions</CardTitle>
        <p>
          {config.installationId} · {config.appId}
        </p>
      </CardHeader>
      <CardContent>
        {editor}
        <Button asChild variant="ghost">
          <a href="/">Back to Apps</a>
        </Button>
      </CardContent>
    </CenteredCard>
  ),
);
