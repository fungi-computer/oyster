import type {
  TeamWorkbenchHostHandle,
  TeamWorkbenchChildEvents,
} from "./workbench-contract.js";
import * as Schema from "effect/Schema";
import { AppError, parseAppStatusAction } from "@fungi.computer/agar";
import type {
  AgentSessionSelection,
  AppStatusAction,
} from "@fungi.computer/agar";
import type { AppOpenInput } from "@fungi.computer/agar/apps";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { parseJsonValue } from "@fungi.computer/whistle/wire";
import {
  desktopSettingsHandlerSchema,
  type WorkbenchDesktopSettings,
  type WorkbenchDesktopRegistration,
  type WorkbenchChildHandle,
  type WorkbenchChildLaunch,
  type WorkbenchCommandInvocation,
  type WorkbenchPlatformDestination,
} from "./workbench-model.js";
import {
  createAppSurfaceCommandHost,
  type AppSurfaceCommandMount,
} from "./command-host.js";
import type {
  WorkbenchHostOptions,
  WorkbenchPreparedChild,
  WorkbenchChildSurface,
  WorkbenchWarningEvent,
  WorkbenchWarningFields,
} from "./workbench-host-types.js";

/** A dashboard may keep this many child Apps mounted at once. */
const maxChildren = 32;
const nonBlank = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(2_048)),
);
const visibilitySchema = Schema.Literals(["hidden", "visible"]);
// A dashboard presents a child's commands to people; it never acts as the
// child's Agent.
const commandInvocationSchema = Schema.Struct({
  commandId: nonBlank,
  origin: Schema.Literals([
    "keyboard",
    "palette",
    "menu",
    "browser",
    "programmatic",
    "slash",
    "terminal",
  ]),
});

/** The registered command invoker of one mounted child, once it registers. */
type ChildCommands = {
  invoke:
    | Parameters<
        AppSurfaceCommandMount["handlers"]["registerCommands"]
      >[0]["invoke"]
    | undefined;
};

/**
 * Forward a child's Release-validated commands and reserved chords to the
 * dashboard that presents them. Validation stays here, against the child's
 * own Release declaration, so the dashboard can never widen them.
 */
function forwardCommands(
  log: (event: WorkbenchWarningEvent, fields: WorkbenchWarningFields) => void,
  validated: AppSurfaceCommandMount,
  events: TeamWorkbenchChildEvents,
  current: ChildCommands,
): AppSurfaceCommandMount {
  const present = (
    commands: Parameters<
      AppSurfaceCommandMount["handlers"]["registerCommands"]
    >[0]["commands"],
  ): Promise<void> => events.onCommands?.(commands) ?? Promise.resolve();
  const handlers: AppSurfaceCommandMount["handlers"] = {
    registerCommands: async (input) => {
      const contribution = await validated.handlers.registerCommands(input);
      current.invoke = input.invoke;
      await present(input.commands);
      return {
        update: (commands) => {
          contribution.update(commands);
          void present(commands).catch((cause: unknown) => {
            log("team_workbench_commands_failed", {
              stage: "update",
              cause,
            });
          });
        },
        dispose: () => {
          contribution.dispose();
          if (current.invoke === input.invoke) current.invoke = undefined;
          void present([]).catch((cause: unknown) => {
            log("team_workbench_commands_failed", {
              stage: "dispose",
              cause,
            });
          });
        },
      };
    },
    invokeReservedChord: async (input) => {
      if (events.onReservedChord === undefined)
        throw new Error("App reserved chord is unavailable");
      await events.onReservedChord(input);
    },
  };
  return Object.freeze({
    handlers: Object.freeze(handlers),
    dispose: validated.dispose,
  });
}

/**
 * One mounted child App, proxying to its real host-owned mount. The shell
 * holds this bounded handle; the host's lease machinery stays behind it.
 */
class MountedChildHandle implements WorkbenchChildHandle {
  #disposed = false;

  constructor(
    private readonly surface: WorkbenchChildSurface,
    private readonly commands: ChildCommands,
    private readonly reconfigureCurrent: (
      launch: WorkbenchChildLaunch,
    ) => Promise<void>,
    private readonly release: () => Promise<void>,
  ) {}

  async setVisibility(visibility: "hidden" | "visible"): Promise<void> {
    if (this.#disposed) return;
    await this.surface.setVisibility(
      Schema.decodeUnknownSync(visibilitySchema)(visibility),
    );
  }

  async reconfigure(launch: WorkbenchChildLaunch): Promise<void> {
    if (this.#disposed) return;
    await this.reconfigureCurrent(launch);
  }

  async requestClose(): Promise<boolean> {
    if (this.#disposed) return true;
    return this.surface.requestClose();
  }

  async requestBack(): Promise<boolean> {
    if (this.#disposed) return false;
    return this.surface.requestBack();
  }

  async activateStatus(action: AppStatusAction): Promise<boolean> {
    if (this.#disposed) return false;
    // The shell relays the person's click; parse it at the host's edge.
    return this.surface.activateStatus(parseAppStatusAction(action));
  }

  async invokeCommand(commandId: string, input: WorkbenchCommandInvocation) {
    const invoke = this.commands.invoke;
    if (this.#disposed || invoke === undefined)
      throw new AppError("That App command is unavailable", {
        code: "CAPABILITY_DENIED",
        retryable: false,
      });
    const parsed = Schema.decodeUnknownSync(commandInvocationSchema)({
      commandId,
      origin: input.origin,
    });
    return invoke(
      parsed.commandId,
      input.arguments === undefined
        ? { origin: parsed.origin }
        : { arguments: parseJsonValue(input.arguments), origin: parsed.origin },
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.release();
  }

  [Symbol.dispose](): void {
    void this.dispose();
  }
}

class DesktopSettingsRegistration implements WorkbenchDesktopRegistration {
  constructor(private readonly detach: () => void) {}
  close(): Promise<void> {
    this.detach();
    return Promise.resolve();
  }
  [Symbol.dispose](): void {
    this.detach();
  }
}

/**
 * Child-window, command and callback lifetime for the trusted shell the host
 * composes into its own document. Each child mounts inside the window slot
 * the shell hands it, so the browser moves, clips and stacks it with that
 * window; the host never positions a child itself.
 */
export class WorkbenchHost implements TeamWorkbenchHostHandle {
  readonly #hostWindow: Window;
  readonly #options: WorkbenchHostOptions;
  readonly #commands = createAppSurfaceCommandHost();
  readonly #children = new Set<string>();
  readonly #releases: (() => void)[] = [];
  #desktopSettingsClose: (() => void) | undefined;
  #settingsClose: Promise<void> | undefined;
  #finishSettings: (() => void) | undefined;

  constructor(options: WorkbenchHostOptions) {
    this.#hostWindow = options.hostWindow;
    this.#options = options;
  }

  team(): ReturnType<TeamWorkbenchHostHandle["team"]> {
    return this.#options.services.team();
  }
  computers(
    input: Parameters<TeamWorkbenchHostHandle["computers"]>[0],
  ): ReturnType<TeamWorkbenchHostHandle["computers"]> {
    return this.#options.services.computers(input);
  }
  directory(): ReturnType<TeamWorkbenchHostHandle["directory"]> {
    return this.#options.services.directory();
  }
  requestGill(
    input: Parameters<TeamWorkbenchHostHandle["requestGill"]>[0],
  ): ReturnType<TeamWorkbenchHostHandle["requestGill"]> {
    return this.#options.services.requestGill(input);
  }
  watchGillChanges(
    ...input: Parameters<TeamWorkbenchHostHandle["watchGillChanges"]>
  ): ReturnType<TeamWorkbenchHostHandle["watchGillChanges"]> {
    return this.#options.services.watchGillChanges(...input);
  }

  async platformDestinations(): Promise<
    readonly WorkbenchPlatformDestination[]
  > {
    return (await this.#options.platform.destinations()).map(
      ({ id, label }) => ({ id, label }),
    );
  }

  async openPlatformDestination(id: string): Promise<void> {
    const parsed = Schema.decodeUnknownSync(nonBlank)(id);
    const offered = await this.#options.platform.destinations();
    if (!offered.some((destination) => destination.id === parsed))
      throw new AppError("That destination is unavailable", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    this.#options.platform.open(parsed);
  }

  /** Describe the actual controls without offering unsupported Settings. */
  settingsSections(): Promise<readonly string[] | null> {
    const controls = this.#options.platform.controls;
    return Promise.resolve(controls.sections?.slice() ?? null);
  }

  takeAppOpenRequest(): Promise<AppOpenInput | null> {
    return Promise.resolve(this.#options.platform.takeAppOpenRequest());
  }

  registerDesktopSettings(
    handler: unknown,
  ): Promise<WorkbenchDesktopRegistration> {
    return Promise.resolve().then(() => {
      let parsed: WorkbenchDesktopSettings;
      try {
        parsed = desktopSettingsHandlerSchema.parse(handler);
      } catch (cause) {
        throw new AppError("Desktop settings registration is invalid", {
          code: "INVALID_ARGUMENT",
          retryable: false,
          cause,
        });
      }
      this.#desktopSettingsClose?.();
      const detach =
        this.#options.platform.controls.attachDesktopSettings(parsed);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        detach();
        if (this.#desktopSettingsClose === close)
          this.#desktopSettingsClose = undefined;
      };
      this.#desktopSettingsClose = close;
      return new DesktopSettingsRegistration(close);
    });
  }

  async openSettings(location: WhistleJsonValue): Promise<void> {
    const parsed = this.#options.platform.controls.parseSettings(location);
    const controls = this.#options.platform.controls;
    if (this.#settingsClose !== undefined) {
      const closed = this.#settingsClose;
      controls.openSettings(parsed, { restoreFocus: false });
      return closed;
    }
    const closed = new Promise<void>((resolve) => {
      const unsubscribe = controls.subscribeSettingsClosed(() =>
        this.#finishSettings?.(),
      );
      this.#finishSettings = () => {
        unsubscribe();
        this.#settingsClose = undefined;
        this.#finishSettings = undefined;
        resolve();
      };
    });
    this.#settingsClose = closed;
    // The shell restores its own invoker once Settings close; returning
    // focus here would race that restoration.
    controls.openSettings(parsed, { restoreFocus: false });
    return closed;
  }

  memberAvatar(): ReturnType<TeamWorkbenchHostHandle["memberAvatar"]> {
    return this.#options.services.memberAvatar();
  }

  watchSettingsChanges(onChanged: () => Promise<void>): Promise<void> {
    const unsubscribe = this.#options.platform.controls.subscribeChanges(() => {
      void onChanged().catch((cause: unknown) => {
        this.#options.log("team_workbench_settings_notification_failed", {
          cause,
        });
      });
    });
    this.#releases.push(unsubscribe);
    return Promise.resolve();
  }

  /** The shell unmounted: stop notifying its callbacks. */
  [Symbol.dispose](): void {
    this.#finishSettings?.();
    this.#desktopSettingsClose?.();
    this.#options.services.dispose();
    for (const release of this.#releases.splice(0)) release();
  }

  async mount(
    container: HTMLElement,
    input: WorkbenchChildLaunch,
    events: TeamWorkbenchChildEvents,
  ): Promise<WorkbenchChildHandle> {
    const request = this.#options.resolveLaunch(input);
    const mountId = request.launch.windowId;
    if (this.#children.has(mountId))
      throw new AppError("That App window is already open", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    if (this.#children.size >= maxChildren)
      throw new AppError("Too many Apps are open", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    this.#children.add(mountId);
    let prepared: WorkbenchPreparedChild | undefined;
    let commandMount: AppSurfaceCommandMount | undefined;
    const childCommands: ChildCommands = { invoke: undefined };
    const release = async () => {
      try {
        commandMount?.dispose();
        if (prepared) await prepared.dispose();
      } finally {
        this.#children.delete(mountId);
      }
    };
    try {
      prepared = await this.#options.prepareChild(request.launch);
      commandMount = forwardCommands(
        this.#options.log,
        this.#commands.mount(mountId, prepared.commands),
        events,
        childCommands,
      );
      const surface = await prepared.mount({
        container,
        hostWindow: this.#hostWindow,
        ...(request.title === undefined ? undefined : { title: request.title }),
        commands: commandMount,
        events,
        onDesktopSettings: (surfaceId) =>
          this.#options.services.suggestDesktopSettings(surfaceId),
        onPermissionRequest: (permission) =>
          this.#options.platform.controls.requestAppAccess(
            {
              surfaceId: request.launch.surfaceId,
              title: request.title ?? request.launch.appId,
            },
            permission,
          ),
      });
      const reconfigureCurrent = async (
        next: WorkbenchChildLaunch,
      ): Promise<void> => {
        const nextRequest = this.#options.resolveLaunch(next);
        if (
          nextRequest.launch.appId !== request.launch.appId ||
          nextRequest.launch.releaseId !== request.launch.releaseId ||
          nextRequest.launch.surfaceId !== request.launch.surfaceId
        )
          throw new Error("App identity cannot change during reconfiguration");
        await surface.reconfigure(nextRequest.launch);
      };
      return new MountedChildHandle(
        surface,
        childCommands,
        reconfigureCurrent,
        async () => {
          try {
            surface.dispose();
          } finally {
            await release();
          }
        },
      );
    } catch (error) {
      await release();
      throw error;
    }
  }

  reportAgentSessionSelection(
    windowId: string,
    selection: AgentSessionSelection | null,
  ): Promise<void> {
    const parsed = Schema.decodeUnknownSync(nonBlank)(windowId);
    this.#options.reportAgentSessionSelection(parsed, selection);
    return Promise.resolve();
  }
}
