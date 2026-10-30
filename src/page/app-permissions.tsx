import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@fungi.computer/caps/components/button";
import { Card, CardContent } from "@fungi.computer/caps/components/card";
import { Checkbox } from "@fungi.computer/caps/components/checkbox";
import { DataList, DataRow } from "@fungi.computer/caps/components/data-list";
import { Form, FormFooter } from "@fungi.computer/caps/components/field";
import { IconCheckbox } from "@fungi.computer/caps/components/icon-checkbox";
import { Status } from "@fungi.computer/caps/components/status";
import {
  Display,
  ScreenCell,
  ScreenCells,
} from "@fungi.computer/caps/components/surface";
import { Sigil } from "@fungi.computer/sigils";
import { permissionCatalog } from "../apps/catalog.js";
import {
  draftOf,
  editPermissions,
  permissionScreen,
  planGrantChange,
  rebaseDraft,
  type AppPermissionsPort,
  type AppPermissionsViewData,
  type PermissionColumn,
  type PermissionDraft,
  type PermissionEdit,
} from "../apps/permissions.js";

/** The shared editor's host navigation guard, not an approval decision. */
export type PermissionLeaveState = "clean" | "dirty" | "pending" | "uncertain";

export type AppPermissionsViewProps = Readonly<{
  port: AppPermissionsPort;
  appKey: string;
  onAccepted?: () => Promise<void>;
  onStateChange?: (state: PermissionLeaveState) => void;
}>;

/** One editor; each App owns its draft and pending-request lifetime on reuse. */
export function AppPermissionsView(props: AppPermissionsViewProps) {
  return <PermissionEditor key={props.appKey} {...props} />;
}

function PermissionEditor({
  port,
  appKey,
  onAccepted,
  onStateChange,
}: AppPermissionsViewProps) {
  const [view, setView] = useState<AppPermissionsViewData | null>(null);
  const [draft, setDraft] = useState<PermissionDraft>(new Map());
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [retired, setRetired] = useState(false);
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const legendId = useId();
  const retire = useCallback(() => {
    setRetired(true);
    setUncertain(false);
    setMessage("This App is no longer available. Reload before trying again.");
  }, []);
  useEffect(() => {
    mounted.current = true;
    let current = true;
    setLoadError(false);
    void port.read(appKey).then(
      (next) => {
        if (!current) return;
        if (next === "unavailable") {
          retire();
          return;
        }
        setView(next);
        setDraft(draftOf(next.permissions.authority));
      },
      () => {
        if (current) setLoadError(true);
      },
    );
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [port, appKey, reload, retire]);
  const changes =
    view === null ? [] : planGrantChange(view.permissions.authority, draft);
  const leaveState: PermissionLeaveState = saving
    ? "pending"
    : retired
      ? "clean"
      : uncertain
        ? "uncertain"
        : changes.length > 0
          ? "dirty"
          : "clean";
  useEffect(() => onStateChange?.(leaveState), [onStateChange, leaveState]);

  async function refreshAfterAcceptance() {
    try {
      await onAccepted?.();
      if (!mounted.current) return;
      setRefreshNeeded(false);
      setMessage("Permissions saved.");
    } catch (cause) {
      console.error("App permissions surrounding-screen refresh failed", cause);
      if (!mounted.current) return;
      setRefreshNeeded(true);
      setMessage(
        "Permissions saved. The surrounding screen could not refresh.",
      );
    }
  }

  async function retryRefresh() {
    setSaving(true);
    try {
      await refreshAfterAcceptance();
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function save() {
    const isMounted = () => mounted.current;
    if (view === null || saving || retired || !view.canEdit) return;
    setSaving(true);
    setRefreshNeeded(false);
    setMessage(null);
    try {
      if (!uncertain) {
        const result = await port.submit(
          appKey,
          {
            storeGeneration: view.storeGeneration,
            authorityVersion: view.permissions.authority.authorityVersion,
            artifactDigest: view.artifactDigest,
          },
          changes,
        );
        if (!isMounted()) return;
        if (result === "unavailable") {
          retire();
          return;
        }
        if (result === "unconfirmed") {
          setUncertain(true);
          setMessage(
            "The change could not be confirmed. Review current permissions before trying again.",
          );
          return;
        }
        if (result === "refused") {
          setMessage(
            "This permission change was refused. No approval was confirmed.",
          );
          return;
        }
        if (result === "accepted") {
          // A failed read after a successful write must not replay the old draft.
          setUncertain(true);
          const next = await port.read(appKey);
          if (!isMounted()) return;
          if (next === "unavailable") {
            retire();
            return;
          }
          setView(next);
          setDraft(draftOf(next.permissions.authority));
          setUncertain(false);
          await refreshAfterAcceptance();
          return;
        }
      }
      const next = await port.read(appKey);
      if (!isMounted()) return;
      if (next === "unavailable") {
        retire();
        return;
      }
      setView(next);
      setDraft(
        rebaseDraft(
          draft,
          view.permissions.authority,
          next.permissions.authority,
        ),
      );
      setUncertain(false);
      setMessage(
        "Current permissions loaded. Review your edits before saving again.",
      );
    } catch (cause) {
      console.error("App permissions could not be confirmed", cause);
      if (isMounted()) {
        setUncertain(true);
        setMessage(
          "The change could not be confirmed. Review current permissions before trying again.",
        );
      }
    } finally {
      if (isMounted()) setSaving(false);
    }
  }

  if (loadError)
    return (
      <div role="alert">
        Permissions could not be loaded.
        <Button
          type="button"
          onClick={() => {
            setReload((value) => value + 1);
          }}
        >
          Retry permissions
        </Button>
      </div>
    );
  if (view === null)
    return <p role="status">{retired ? message : "Loading permissions…"}</p>;
  const authority = {
    ...view.permissions.authority,
    approvedGrants: [...draft].flatMap(([capability, grant]) =>
      grant === null
        ? []
        : [{ capability, capabilityApproved: true as const, ...grant }],
    ),
  };
  const screen = permissionScreen({
    ...view.permissions,
    authority,
    resources: view.resources,
    canEdit: view.canEdit,
  });
  const baseline = permissionScreen({
    ...view.permissions,
    resources: view.resources,
    canEdit: view.canEdit,
  });
  const disabled = !screen.canEdit || saving || uncertain || retired;
  const edit = (change: PermissionEdit) => {
    setDraft((current) =>
      editPermissions(current, change, view.permissions.declaredOperations),
    );
  };
  const shell = screen.groups
    .flatMap((group) => group.switches)
    .find((column) => column.capability === "team.workbenchHost");
  const shellChanged = changes.some(
    (change) => change.capability === "team.workbenchHost",
  );
  const groups = screen.groups.filter((group) => group.id !== "shell");
  const pending = baseline.pending.filter(
    (capability) => capability !== "team.workbenchHost",
  );
  return (
    <Form
      style={{ maxWidth: "46rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!screen.canEdit && <p>Only an owner can change these permissions.</p>}
      {pending.length > 0 && (
        <p>
          Needs approval:{" "}
          {pending
            .map((capability) => permissionCatalog[capability].label)
            .join(", ")}
        </p>
      )}
      {shell !== undefined && (
        <ShellPermissionRow
          column={shell}
          changed={shellChanged}
          otherChanges={changes.length > 1}
          disabled={disabled}
          onToggle={() => {
            edit({
              kind: "switch",
              capability: "team.workbenchHost",
              on: !shell.on,
            });
          }}
          onCancel={() => {
            setDraft((current) =>
              new Map(current).set(
                "team.workbenchHost",
                draftOf(view.permissions.authority).get("team.workbenchHost") ??
                  null,
              ),
            );
          }}
        />
      )}
      {groups.length > 0 && (
        <Display size="sm" aria-label={`${view.appName} permissions`}>
          <ScreenCells appearance="compact">
            {groups.map((group) => (
              <section key={group.id} aria-label={`${group.id} permissions`}>
                <h3>{group.id}</h3>
                {group.rows.map((row) => (
                  <ScreenCell
                    key={
                      row.resource === "all"
                        ? "all"
                        : `${row.resource.kind}:${row.resource.id}`
                    }
                    appearance="compact"
                    icon={
                      <Sigil
                        name={
                          group.scope === "computer" ? "computer" : "listAgents"
                        }
                      />
                    }
                    legend={row.label}
                  >
                    {row.cells.map((cell) => {
                      const column = group.columns.find(
                        (item) => item.capability === cell.capability,
                      );
                      if (column === undefined) return null;
                      return (
                        <IconCheckbox
                          key={cell.capability}
                          appearance="compact"
                          icon={<Sigil name={column.sigil} />}
                          caption={column.caption}
                          label={`${row.label}: ${column.label}`}
                          aria-describedby={`${legendId}-${cell.capability}`}
                          checked={cell.state !== "off"}
                          disabled={disabled || cell.state === "via-all"}
                          onChange={(event) => {
                            edit(
                              row.resource === "all"
                                ? {
                                    kind: "all",
                                    capability: cell.capability,
                                    on: event.target.checked,
                                  }
                                : {
                                    kind: "resource",
                                    capability: cell.capability,
                                    resource: row.resource,
                                    on: event.target.checked,
                                  },
                            );
                          }}
                        />
                      );
                    })}
                  </ScreenCell>
                ))}
                {group.switches.map((column) => (
                  <ScreenCell
                    key={column.capability}
                    appearance="compact"
                    legend={column.label}
                  >
                    <IconCheckbox
                      appearance="compact"
                      icon={<Sigil name={column.sigil} />}
                      caption={column.caption}
                      label={column.label}
                      aria-describedby={`${legendId}-${column.capability}`}
                      checked={column.on}
                      disabled={
                        disabled ||
                        permissionCatalog[column.capability].consent ===
                          "affordance"
                      }
                      onChange={(event) => {
                        edit({
                          kind: "switch",
                          capability: column.capability,
                          on: event.target.checked,
                        });
                      }}
                    />
                  </ScreenCell>
                ))}
                {group.operations.map((operation) => (
                  <label key={operation.operation}>
                    <Checkbox
                      checked={operation.on}
                      disabled={disabled}
                      onChange={(event) => {
                        edit({
                          kind: "operation",
                          capability: operation.capability,
                          operation: operation.operation,
                          on: event.target.checked,
                        });
                      }}
                    />
                    {operation.operation}
                  </label>
                ))}
                <dl>
                  {[...group.columns, ...group.switches].map((column) => (
                    <div
                      key={column.capability}
                      id={`${legendId}-${column.capability}`}
                    >
                      <dt>{column.label}</dt>
                      <dd>
                        {column.description}
                        {column.warning !== null && <p>{column.warning}</p>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </ScreenCells>
        </Display>
      )}
      {screen.groups.length === 0 && <p>This App requests no permissions.</p>}
      {message !== null && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
      {((groups.length > 0 && !shellChanged) || uncertain || refreshNeeded) && (
        <FormFooter divider={false}>
          {refreshNeeded && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void retryRefresh()}
            >
              Retry screen refresh
            </Button>
          )}
          <Button
            type="submit"
            size="xs"
            variant="outline"
            disabled={
              saving ||
              retired ||
              !screen.canEdit ||
              (!uncertain && changes.length === 0)
            }
          >
            {saving
              ? "Saving…"
              : uncertain
                ? "Review current permissions"
                : "Save permissions"}
          </Button>
        </FormFooter>
      )}
    </Form>
  );
}

/** Shell is a single approval, not a resource/verb matrix. Confirmation still
 * submits the editor's whole draft through its one atomic save. */
function ShellPermissionRow({
  column,
  changed,
  otherChanges,
  disabled,
  onToggle,
  onCancel,
}: {
  column: PermissionColumn & Readonly<{ on: boolean }>;
  changed: boolean;
  otherChanges: boolean;
  disabled: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const { on } = column;
  return (
    <Card variant="outline" density="compact" aria-label="Shell permissions">
      <CardContent>
        <DataList density="compact">
          <DataRow
            style={{
              gridTemplateColumns: "20px minmax(0, 1fr) auto",
              alignItems: "center",
              gap: "var(--spacing-sm)",
              padding: 0,
              minHeight: 36,
            }}
          >
            <Sigil name={column.sigil} size={20} />
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "var(--spacing-sm)",
                minWidth: 0,
              }}
            >
              <strong style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                {column.label}
              </strong>
              <span
                title={column.description}
                style={{
                  color: "var(--stipe-fg-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {column.description}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-sm)",
              }}
            >
              <Status
                size="compact"
                glyph="dot"
                tone={changed ? "warning" : on ? "success" : "neutral"}
                aria-label={
                  changed
                    ? "Shell change not saved"
                    : on
                      ? "Shell allowed"
                      : "Shell not allowed"
                }
              />
              <Button
                type="button"
                size="xs"
                variant={changed || !on ? "outline" : "ghost-destructive"}
                disabled={disabled}
                onClick={changed ? onCancel : onToggle}
              >
                {changed ? "Cancel" : on ? "Revoke" : "Allow"}
              </Button>
            </div>
          </DataRow>
        </DataList>
        <p
          style={{
            margin: 0,
            color: "var(--stipe-fg-muted)",
            fontSize: "var(--text-sm)",
          }}
        >
          {column.warning}
        </p>
        {changed && (
          <FormFooter
            divider={false}
            status={
              otherChanges
                ? "Save all permission edits, including Shell access?"
                : on
                  ? "Allow Shell full access?"
                  : "Revoke Shell access?"
            }
          >
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={disabled}
            >
              {otherChanges
                ? "Save permissions"
                : on
                  ? "Confirm allow"
                  : "Confirm revoke"}
            </Button>
          </FormFooter>
        )}
      </CardContent>
    </Card>
  );
}
