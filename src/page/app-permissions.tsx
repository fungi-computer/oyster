import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Disclosure } from "@fungi.computer/caps/components/disclosure";
import { Alert } from "@fungi.computer/caps/components/alert";
import { Button } from "@fungi.computer/caps/components/button";
import { Card, CardContent } from "@fungi.computer/caps/components/card";
import { DataList, DataRow } from "@fungi.computer/caps/components/data-list";
import { Form, FormFooter } from "@fungi.computer/caps/components/field";
import { Switch } from "@fungi.computer/caps/components/switch";
import { LoadingState } from "@fungi.computer/caps/blocks/loading-state";
import {
  PermissionGrid,
  type PermissionGridRow,
} from "@fungi.computer/caps/blocks/permission-grid";
import { Status } from "@fungi.computer/caps/components/status";
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
  type PermissionScreen,
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

const groupLabels = {
  computers: "Computers",
  agents: "Agents",
  generation: "Generation",
  bazaar: "Bazaar",
  data: "Data",
  workflows: "Workflows",
  git: "Git",
  channels: "Channels",
  apps: "Apps",
  shell: "Shell",
  other: "Other",
} as const;

const gridHeadings = {
  capability: "Permission",
  state: "State",
  scope: "Applies to",
  control: "Change",
} as const;

type PermissionGroup = PermissionScreen["groups"][number];
type GrantRowContext = Readonly<{
  disabled: boolean;
  describedBy: (capability: PermissionColumn["capability"]) => string;
  edit: (change: PermissionEdit) => void;
}>;

/** "publishDraft" and "publish_draft" read as "Publish draft". */
function methodLabel(operation: string): string {
  const words = operation
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[._-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One grid row per grant: a label, its state in words and a labelled switch. */
function grantRow(
  context: GrantRowContext,
  input: {
    id: string;
    capability: PermissionColumn["capability"];
    sigil: PermissionColumn["sigil"];
    label: string;
    chip: string;
    scopeName: string;
    stateLabel?: string;
    pending: boolean;
    on: boolean;
    locked: boolean;
    onChange: (on: boolean) => void;
  },
): PermissionGridRow {
  return {
    id: input.id,
    mark: <Sigil name={input.sigil} />,
    label: input.label,
    state: input.on ? "allowed" : "denied",
    group: input.chip,
    stateLabel: input.stateLabel ?? (input.on ? "On" : "Off"),
    scope: input.scopeName,
    control: (
      <Switch
        id={input.pending ? `grant-${input.id}` : undefined}
        aria-label={`${input.scopeName}: ${input.label}`}
        aria-describedby={context.describedBy(input.capability)}
        checked={input.on}
        disabled={context.disabled || input.locked}
        onCheckedChange={input.onChange}
      />
    ),
  };
}

/** The rows for one resource (or "all") of a scoped group. */
function resourceRows(
  context: GrantRowContext,
  group: PermissionGroup,
  resource: PermissionGroup["rows"][number],
): PermissionGridRow[] {
  const key =
    resource.resource === "all"
      ? "all"
      : `${resource.resource.kind}:${resource.resource.id}`;
  return resource.cells.flatMap((cell) => {
    const column = group.columns.find(
      (item) => item.capability === cell.capability,
    );
    if (column === undefined) return [];
    const id = `${key}:${cell.capability}`;
    return [
      grantRow(context, {
        id,
        capability: cell.capability,
        sigil: column.sigil,
        label: column.label,
        chip: groupLabels[group.id],
        scopeName: resource.label,
        stateLabel: cell.state === "via-all" ? "On for all" : undefined,
        pending: column.pending && cell.state === "off",
        on: cell.state !== "off",
        locked: cell.state === "via-all",
        onChange: (on) => {
          context.edit(
            resource.resource === "all"
              ? { kind: "all", capability: cell.capability, on }
              : {
                  kind: "resource",
                  capability: cell.capability,
                  resource: resource.resource,
                  on,
                },
          );
        },
      }),
    ];
  });
}

/** Switches and App-call operations, which apply to the App rather than a resource. */
function appRows(
  context: GrantRowContext,
  group: PermissionGroup,
): PermissionGridRow[] {
  return [
    ...group.switches.map((column) => {
      const locked =
        permissionCatalog[column.capability].consent === "affordance";
      return grantRow(context, {
        id: column.capability,
        capability: column.capability,
        sigil: column.sigil,
        label: column.label,
        chip: groupLabels[group.id],
        scopeName: "This App",
        stateLabel: locked ? "Always on" : undefined,
        pending: column.pending && !column.on,
        on: column.on,
        locked,
        onChange: (on) => {
          context.edit({ kind: "switch", capability: column.capability, on });
        },
      });
    }),
    ...group.operations.map((operation) =>
      grantRow(context, {
        id: `${operation.capability}:${operation.operation}`,
        capability: operation.capability,
        sigil: permissionCatalog["apps.call"].sigil,
        label: methodLabel(operation.operation),
        chip: groupLabels[group.id],
        scopeName: "Other Apps",
        pending: false,
        on: operation.on,
        locked: false,
        onChange: (on) => {
          context.edit({
            kind: "operation",
            capability: operation.capability,
            operation: operation.operation,
            on,
          });
        },
      }),
    ),
  ];
}

/** Every row of a group: its resources' grants, then the App's own switches. */
function groupRows(
  context: GrantRowContext,
  group: PermissionGroup,
): PermissionGridRow[] {
  return [
    ...group.rows
      .filter((resource) =>
        resource.cells.some((cell) => cell.state !== "via-all"),
      )
      .flatMap((resource) => resourceRows(context, group, resource)),
    ...appRows(context, group),
  ];
}

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
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [otherOpen, setOtherOpen] = useState(false);
  const asked = useRef<ReadonlySet<PermissionGroup["id"]> | null>(null);
  const describeId = useId();
  const mounted = useRef(true);
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
      setSaved(true);
      setMessage("Permissions saved");
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
    setSaved(false);
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
    return retired ? (
      <p role="status">{message}</p>
    ) : (
      <LoadingState message="Loading permissions…" />
    );
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
  const context: GrantRowContext = {
    disabled,
    describedBy: (capability) => `${describeId}-${capability}`,
    edit,
  };
  const rowsOf = (items: readonly PermissionGroup[]) =>
    items.flatMap((group) => groupRows(context, group));
  const needsOk = (group: PermissionGroup) =>
    [...group.columns, ...group.switches].some((column) =>
      pending.some((item) => item === column.capability),
    );
  // The split is fixed on first sight, so rows never move under the cursor.
  asked.current ??= new Set(groups.filter(needsOk).map((group) => group.id));
  const askedIds = asked.current;
  const first = rowsOf(
    askedIds.size > 0 ? groups.filter((g) => askedIds.has(g.id)) : groups,
  );
  const later =
    askedIds.size > 0 ? rowsOf(groups.filter((g) => !askedIds.has(g.id))) : [];
  const showFooter =
    (groups.length > 0 && !shellChanged) || uncertain || refreshNeeded;
  return (
    <Form
      style={{ maxWidth: "var(--container-2xl)", marginInline: "auto" }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!screen.canEdit && <p>Only an owner can change these permissions.</p>}
      {pending.length > 0 && (
        <Alert
          tone="warning"
          title={`${String(pending.length)} ${pending.length === 1 ? "permission needs" : "permissions need"} your OK`}
          action={
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                document.querySelector<HTMLElement>('[id^="grant-"]')?.focus();
              }}
            >
              Review
            </Button>
          }
        >
          Turn on what you want this App to do, then save.
        </Alert>
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
      {first.length > 0 && (
        <PermissionGrid
          caption={
            later.length > 0
              ? `${view.appName} asks for`
              : `${view.appName} permissions`
          }
          headings={gridHeadings}
          rows={first}
        />
      )}
      {later.length > 0 && (
        <Disclosure
          open={otherOpen}
          onOpenChange={setOtherOpen}
          summary={`Other permissions · ${String(later.length)}`}
        >
          <PermissionGrid
            caption="Already decided"
            headings={gridHeadings}
            rows={later}
          />
        </Disclosure>
      )}
      <div className="sr-only">
        {groups
          .flatMap((group) => [...group.columns, ...group.switches])
          .map((column) => (
            <p
              key={column.capability}
              id={`${describeId}-${column.capability}`}
            >
              {column.description}
              {column.warning === null ? "" : ` ${column.warning}`}
            </p>
          ))}
      </div>
      {screen.groups.length === 0 && <p>This App requests no permissions.</p>}
      {message !== null && !showFooter && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
      {showFooter && (
        <FormFooter divider={false}>
          {message !== null &&
            (saved && !uncertain && !refreshNeeded ? (
              <Status
                role="status"
                size="compact"
                glyph="dot"
                tone="success"
                label={message}
              />
            ) : (
              <span role="status">{message}</span>
            ))}
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
          {(changes.length > 0 || saving || uncertain) && (
            <Button
              type="submit"
              variant="primary"
              disabled={saving || retired || !screen.canEdit}
            >
              {saving
                ? "Saving…"
                : uncertain
                  ? "Review current permissions"
                  : "Save permissions"}
            </Button>
          )}
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
            <strong>{column.label}</strong>
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
          <span style={{ display: "block" }}>{column.description}</span>
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
