import type { AgentSessionSelection } from "@fungi.computer/agar";
import type { GillReply } from "@fungi.computer/gills";
import type { AppOpenInput } from "@fungi.computer/agar/apps";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import type {
  WorkbenchChildEvents,
  WorkbenchChildHandle,
  WorkbenchChildLaunch,
  WorkbenchGillRequest,
  WorkbenchGillWatch,
  WorkbenchPlatformDestination,
  WorkbenchDesktopSettings,
  WorkbenchDesktopRegistration,
} from "./workbench-model.js";

/** Team dashboards additionally relay the selected Agent Session to the Hub. */
export type TeamWorkbenchChildEvents = WorkbenchChildEvents &
  Readonly<{
    /** Relay a child's explicit Agent Session selection to its host. */
    onAgentSessionSelection: (
      selection: AgentSessionSelection | null,
    ) => Promise<void>;
  }>;

/**
 * Team/Computer/App-directory reads and child-App hosting for the trusted
 * shell. The host composes the shell into its own top-level document, so the
 * shell runs with the host's escalated permissions; each child App still runs
 * in its own sandboxed frame with its own separately resolved approvals.
 */
export type TeamWorkbenchHostHandle = {
  /** The authenticated Team hosting this dashboard; the caller parses it. */
  team(): Promise<WhistleJsonValue>;
  /** A page of the Team's Computer inventory; the caller parses it. */
  computers(
    input: Readonly<{ limit: number; offset: number }>,
  ): Promise<WhistleJsonValue>;
  /** The Team's effective App directory and role choices; the caller parses it. */
  directory(): Promise<WhistleJsonValue>;
  /** Invoke a declared Gill of an admitted App in this Team. No caller-provided resource data. */
  requestGill(input: WorkbenchGillRequest): Promise<GillReply>;
  /** Observe resource changes; only the host owns the authenticated stream. Close while covered. */
  watchGillChanges(
    input: WorkbenchGillRequest,
    onChanged: () => Promise<void>,
  ): Promise<WorkbenchGillWatch>;
  /**
   * Resolve, authorize and mount one child App inside `container`, the
   * shell's own slot in that App's window. The host never moves the child:
   * the shell keeps `container` attached and moves its window instead.
   */
  mount(
    container: HTMLElement,
    input: WorkbenchChildLaunch,
    events: TeamWorkbenchChildEvents,
  ): Promise<WorkbenchChildHandle>;
  /** Bind one mounted child's explicit Agent Session selection to the host. */
  reportAgentSessionSelection(
    windowId: string,
    selection: AgentSessionSelection | null,
  ): Promise<void>;
  /** The platform destinations the host currently offers. */
  platformDestinations(): Promise<readonly WorkbenchPlatformDestination[]>;
  /** Offered Settings categories, or null for unrestricted host controls. */
  settingsSections(): Promise<readonly string[] | null>;
  /** Ask the host to navigate to one offered platform destination. */
  openPlatformDestination(id: string): Promise<void>;
  /**
   * Take, once, the App-open handoff the visitor's Hub address carried (for
   * example `?open=inbox&intent=compose`). The host consumes it from its own
   * address; the dashboard opens it like any other `apps.open` request.
   */
  takeAppOpenRequest(): Promise<AppOpenInput | null>;
  /**
   * Open the host's own Team settings at a dashboard-defined location (the
   * host parses it). Administration there runs with the signed-in person's
   * own authority in host-rendered UI, never through the dashboard.
   * Resolves when Settings close, so the dashboard restores its own focus.
   */
  openSettings(location: WhistleJsonValue): Promise<void>;
  /** Bind the admitted dashboard's arranger to the host's member-consent UI.
   * Only the host invokes it; ordinary Apps can only open their own Settings. */
  registerDesktopSettings(
    handler: WorkbenchDesktopSettings,
  ): Promise<WorkbenchDesktopRegistration>;
  /**
   * Hear when host-rendered settings or App access consent changed the
   * Team's Apps or the person's settings, so the dashboard refreshes.
   */
  watchSettingsChanges(onChanged: () => Promise<void>): Promise<void>;
  /** The signed-in person's own avatar preference; the caller parses it. */
  memberAvatar(): Promise<WhistleJsonValue>;
};
