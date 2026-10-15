import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  CenteredCard,
  CardHeader,
  CardTitle,
  CardContent,
} from "@fungi.computer/caps/components/card";
import { Field, Form, FormFooter } from "@fungi.computer/caps/components/field";
import { Checkbox } from "@fungi.computer/caps/components/checkbox";
import { Button } from "@fungi.computer/caps/components/button";
import * as Schema from "effect/Schema";
import {
  capabilityLabels,
  installationConsentSchema,
} from "../installation-consent.js";

declare const OYSTER_SHELL_STYLES: string;
const element = document.getElementById("oyster-consent-config");
const root = document.getElementById("oyster-consent");
if (element === null || root === null)
  throw new Error("Consent configuration missing");
const config = Schema.decodeUnknownSync(
  Schema.fromJsonString(installationConsentSchema),
)(element.textContent);
const styles = document.createElement("style");
styles.textContent = OYSTER_SHELL_STYLES;
document.head.append(styles);
const appearance = matchMedia("(prefers-color-scheme: dark)");
const setTheme = () => {
  document.documentElement.dataset.theme = appearance.matches
    ? "mocha"
    : "latte";
};
setTheme();
appearance.addEventListener("change", setTheme);

function Consent() {
  const [selected, setSelected] = useState(
    new Set(
      config.capabilities
        .filter((row) => row.approved)
        .map((row) => row.request.capability),
    ),
  );
  const [version, setVersion] = useState(config.authorityVersion);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<Readonly<{ cause: unknown }> | null>(
    null,
  );
  async function save() {
    setSaving(true);
    setMessage("");
    setFailure(null);
    try {
      const response = await fetch(
        `/api/installations/${encodeURIComponent(config.installationId)}/grants`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authorityVersion: version,
            artifactDigest: config.artifactDigest,
            command: {
              kind: "set-grants",
              grants: config.capabilities
                .filter((row) => selected.has(row.request.capability))
                .map((row) => row.request),
            },
          }),
        },
      );
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? "This App changed. Reload to review its current permissions."
            : "Permissions could not be saved. Try again.",
        );
        return;
      }
      const installation = Schema.decodeUnknownSync(
        Schema.Struct({
          authorityVersion: installationConsentSchema.fields.authorityVersion,
        }),
      )(await response.json());
      setVersion(installation.authorityVersion);
      setMessage("Permissions saved");
    } catch (cause) {
      setFailure({ cause });
    } finally {
      setSaving(false);
    }
  }
  return (
    <CenteredCard>
      <CardHeader>
        <CardTitle>{config.appName} permissions</CardTitle>
        <p>
          {config.installationId} · {config.appId}
        </p>
      </CardHeader>
      <CardContent>
        <p>
          Choose what this App can do on your Oyster. Only you can approve its
          permissions.
        </p>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {config.capabilities.map((row) => (
            <Field
              key={row.request.capability}
              label={capabilityLabels[row.request.capability]}
              orientation="inline"
              description={`${row.description} Scope: ${row.scope}.`}
            >
              <Checkbox
                disabled={saving}
                checked={selected.has(row.request.capability)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(row.request.capability);
                  else next.delete(row.request.capability);
                  setSelected(next);
                }}
              />
            </Field>
          ))}
          {config.capabilities.length === 0 && (
            <p>This App requests no permissions.</p>
          )}
          <p role="status" aria-live="polite">
            {failure === null
              ? message
              : failure.cause instanceof TypeError
                ? "Permissions could not be saved. Check your connection and try again."
                : "The approval response could not be read. Reload before trying again."}
          </p>
          <FormFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save permissions"}
            </Button>
            <Button asChild variant="ghost">
              <a href="/">Back to Apps</a>
            </Button>
          </FormFooter>
        </Form>
      </CardContent>
    </CenteredCard>
  );
}
createRoot(root).render(<Consent />);
