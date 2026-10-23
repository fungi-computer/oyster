import { createRoot } from "react-dom/client";
import { Fragment, useState } from "react";
import {
  CenteredCard,
  CardHeader,
  CardTitle,
  CardContent,
} from "@fungi.computer/caps/components/card";
import { Field, Form, FormFooter } from "@fungi.computer/caps/components/field";
import { Checkbox } from "@fungi.computer/caps/components/checkbox";
import { Button } from "@fungi.computer/caps/components/button";
import { installationSchema } from "../apps/installation.js";
import { permissionCatalog } from "../apps/catalog.js";
import {
  appPermissionPageSchema,
  permissionScreen,
  draftOf,
  editPermissions,
  planGrantChange,
  rebaseDraft,
} from "../apps/permissions.js";

declare const OYSTER_SHELL_STYLES: string;
const element = document.getElementById("oyster-consent-config");
const root = document.getElementById("oyster-consent");
if (element === null || root === null)
  throw new Error("Consent configuration missing");
const config = appPermissionPageSchema.parse(JSON.parse(element.textContent));
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
  const [view, setView] = useState(config);
  const [draft, setDraft] = useState(() =>
    draftOf(config.permissions.authority),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<Readonly<{ cause: unknown }> | null>(
    null,
  );
  const screen = permissionScreen({
    ...view.permissions,
    resources: [],
    canEdit: true,
  });
  const columns = screen.groups.flatMap((group) => [
    ...group.columns,
    ...group.switches,
  ]);
  async function save() {
    const changes = planGrantChange(view.permissions.authority, draft);
    if (changes.length === 0) {
      setMessage("No permission changes");
      return;
    }
    setSaving(true);
    setMessage("");
    setFailure(null);
    const path =
      "/api/installations/" +
      encodeURIComponent(view.installationId) +
      "/grants";
    try {
      const response = await fetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeGeneration: view.storeGeneration,
          authorityVersion: view.permissions.authority.authorityVersion,
          artifactDigest: view.artifactDigest,
          command: { kind: "change-grants", changes },
        }),
      });
      if (response.status === 409) {
        const refreshed = await fetch(path, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!refreshed.ok) {
          setMessage(
            "This App is no longer available. Reload before trying again.",
          );
          return;
        }
        const current = appPermissionPageSchema.parse(await refreshed.json());
        setDraft(
          rebaseDraft(
            draft,
            view.permissions.authority,
            current.permissions.authority,
          ),
        );
        setView(current);
        setMessage(
          "This App changed. Review your changes against its current permissions before saving again.",
        );
        return;
      }
      if (!response.ok) {
        setMessage("Permissions could not be saved. Try again.");
        return;
      }
      const installation = installationSchema.parse(await response.json());
      setView({
        ...view,
        permissions: { ...view.permissions, authority: installation.authority },
      });
      setDraft(draftOf(installation.authority));
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
        <CardTitle>{view.appName} permissions</CardTitle>
        <p>
          {view.installationId} · {view.appId}
        </p>
      </CardHeader>
      <CardContent>
        <p>
          Choose what this App can access. Unchanged permissions keep their
          existing operations and resource limits.
        </p>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {columns.map((column) => (
            <Fragment key={column.capability}>
              <Field
                label={column.label}
                orientation="inline"
                description={column.description}
              >
                <Checkbox
                  disabled={
                    saving ||
                    permissionCatalog[column.capability].consent ===
                      "affordance"
                  }
                  checked={
                    permissionCatalog[column.capability].consent ===
                      "affordance" || draft.get(column.capability) != null
                  }
                  onChange={(event) => {
                    setDraft(
                      editPermissions(
                        draft,
                        {
                          kind: "switch",
                          capability: column.capability,
                          on: event.target.checked,
                        },
                        view.permissions.declaredOperations,
                      ),
                    );
                  }}
                />
              </Field>
              {column.warning !== null && <p>{column.warning}</p>}
            </Fragment>
          ))}
          {columns.length === 0 && <p>This App requests no permissions.</p>}
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
