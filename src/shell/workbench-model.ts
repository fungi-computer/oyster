import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
  rpcVoid,
} from "@fungi.computer/agar/rpc";
import * as z from "zod";
import * as Schema from "effect/Schema";
import { gillRequestSchema } from "@fungi.computer/gills";
import type {
  AppCommand,
  AppOpenRequest,
  FileNavigationInput,
  AppNavigationState,
  AppStatusAction,
  AppStatusItem,
} from "@fungi.computer/agar";
import type { AppOpenInput, AppRoleChoice } from "@fungi.computer/agar/apps";
import type {
  WhistleExecutionOrigin,
  WhistleJsonValue,
} from "@fungi.computer/whistle";

/** A request to resolve and mount one child App, by its own identity. */
export type WorkbenchChildLaunch = Readonly<{
  windowId: string;
  appId: string;
  releaseId: string;
  surfaceId: string;
  href: string;
  title?: string;
  openRequest: AppOpenRequest | null;
}>;

/** One invocation of a mounted child's own Release-declared command. */
export type WorkbenchCommandInvocation = Readonly<{
  arguments?: WhistleJsonValue;
  origin: WhistleExecutionOrigin;
}>;

/**
 * Events a mounted child raises toward its dashboard. A child's permission
 * requests never reach the dashboard: the host asks the person itself. The
 * host validates a
 * child's commands against that child's own Release declaration before
 * forwarding them, so the dashboard can present them but never widen them.
 */
export type WorkbenchChildEvents = Readonly<{
  /** Ask this window's shell to open its existing Computer picker. */
  onComputerChoice?: () => Promise<void>;
  /** Ask the embedding host to follow a file navigation request. */
  onNavigation?: (input: FileNavigationInput) => Promise<void>;
  /** Ask the embedding host to open an App through its own admission policy. */
  onAppOpen?: (input: AppOpenInput) => Promise<void>;
  /** Ask the embedding host which App its role routing would open for a role. */
  onAppRole?: (role: string) => Promise<AppRoleChoice>;
  /** Report a changed child selection; the host returns whether it handled it. */
  onSelectionChanged?: () => Promise<boolean>;
  /**
   * Replace the child's presented command set; an empty list clears it. Run
   * one through the child's handle with `invokeCommand`.
   */
  onCommands?: (commands: readonly AppCommand[]) => Promise<void>;
  /** A reserved shell chord (the command palette) pressed inside the child. */
  onReservedChord?: (
    input: Readonly<{ id: string; repeat: boolean }>,
  ) => Promise<void>;
  /** The child gained (`true`) or lost (`false`) input focus. */
  onFocus?: (focused: boolean) => Promise<void>;
  /**
   * The child's latest parsed navigation state; `null` once it disconnects.
   * The dashboard shows a Back affordance from it.
   */
  onNavigationState?: (state: AppNavigationState | null) => Promise<void>;
  /** The child's latest status readouts; an empty list once it disconnects. */
  onStatusItems?: (items: readonly AppStatusItem[]) => Promise<void>;
}>;

/** One mounted child App; every method proxies to its real host-owned mount. */
export type WorkbenchChildHandle = {
  /** Show or hide the mounted child without changing its identity. */
  setVisibility(visibility: "hidden" | "visible"): Promise<void>;
  /** Update the launch descriptor of the existing mount. */
  reconfigure(launch: WorkbenchChildLaunch): Promise<void>;
  /** Ask whether the child permits a user-initiated close. */
  requestClose(): Promise<boolean>;
  /** Ask the child to go back one step in its own history; `true` when it did. */
  requestBack(): Promise<boolean>;
  /** Deliver the person's use of a child's status item; `true` when it acted. */
  activateStatus(action: AppStatusAction): Promise<boolean>;
  /** Run one of the child's currently presented commands. */
  invokeCommand(
    commandId: string,
    input: WorkbenchCommandInvocation,
  ): Promise<WhistleJsonValue | undefined>;
  /** Release the child mount and its resources. */
  dispose(): Promise<void>;
};

/**
 * A platform destination the host offers the dashboard, such as opening
 * a host settings page. The host owns the labels and the navigation;
 * the dashboard only presents them and asks the host to follow one.
 */
export type WorkbenchPlatformDestination = Readonly<{
  id: string;
  label: string;
}>;

/** A declared Gill request addressed to one host-selected App surface. */
export const workbenchGillRequestSchema = Schema.Struct({
  surfaceId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(513),
  ),
  ...gillRequestSchema.fields,
});
/** Decoded Gill request for a surface in the host directory. */
export type WorkbenchGillRequest = typeof workbenchGillRequestSchema.Type;
/** The member chooses a declared Gill and size in host-rendered Settings. */
export const desktopGillSelectionSchema = z.strictObject({
  surfaceId: z.string().min(1).max(256),
  gillId: z.string().min(1).max(80),
});
/** The identity of a Gill selected in a host-rendered settings view. */
export type DesktopGillSelection = z.output<typeof desktopGillSelectionSchema>;
/** The dashboard layout sizes currently assigned to one Gill. */
export const desktopGillSizesSchema = z.array(z.enum(["S", "M", "L"])).max(24);
/** A selected Gill and the layout size requested for a new placement. */
export const desktopGillAdditionSchema = desktopGillSelectionSchema.extend({
  size: z.enum(["S", "M", "L"]),
});
/** A decoded request to add a Gill placement. */
export type DesktopGillAddition = z.output<typeof desktopGillAdditionSchema>;
/** A dashboard supplies its own arranger, not an endpoint for ordinary Apps. */
export type WorkbenchDesktopSettings = {
  /** Read the sizes currently assigned to this Gill in the dashboard layout. */
  readGill: (
    input: DesktopGillSelection,
  ) => Promise<z.output<typeof desktopGillSizesSchema>>;
  /** Add a Gill at the requested size to the dashboard layout. */
  addGill: (input: DesktopGillAddition) => Promise<void>;
  /** Remove this Gill from the dashboard layout. */
  removeGill: (input: DesktopGillSelection) => Promise<void>;
};
/** Shape of the arranger callbacks the shell supplies to its host. */
export const desktopSettingsHandlerSchema = rpcHandleSchema({
  readGill: rpcMethod(rpcDataSchema(desktopGillSizesSchema)).input([
    desktopGillSelectionSchema,
  ]),
  addGill: rpcVoid.input([desktopGillAdditionSchema]),
  removeGill: rpcVoid.input([desktopGillSelectionSchema]),
});
/** A registration lease; close it when the dashboard unmounts. */
export type WorkbenchDesktopRegistration = {
  /** Release this host registration. */
  close(): Promise<void>;
};

/** A host-owned change subscription; close it when no longer visible. */
export type WorkbenchGillWatch = {
  /** Release this host registration. */
  close(): Promise<void>;
};

/** Runtime check for an App-open handoff arriving across an untrusted boundary. */
export const appOpenRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("compose"),
    requestId: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    requestId: Schema.String,
    params: Schema.Array(
      Schema.Struct({ key: Schema.String, value: Schema.String }),
    ),
  }),
]);

/** One Team Computer in a host's inventory: the wire of `computers()`. */
export const teamComputerSchema = z.strictObject({
  computerId: z.string().min(1),
  name: z.string().min(1).max(256),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
/** A decoded Team Computer inventory record. */
export type TeamComputer = z.output<typeof teamComputerSchema>;
/** One page of a host's Team Computer inventory. */
export const teamComputerDirectorySchema = z.strictObject({
  computers: z.array(teamComputerSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});
