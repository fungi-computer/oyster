import { observeDesktopGill } from "./gill-observation.js";
import { OysterAgentBrowserHost } from "./agent-browser.js";
import { createShellAppAccess } from "./app-access.js";
import { createWindowLaunchTracker } from "./window-launch.js";
import { computerTargetUrl } from "../computer-target.js";
import {
  childInstallationAddress,
  childMatchesLaunch,
  sharedRead,
} from "./child-selection.js";
import { createGillClient } from "@fungi.computer/gills";
import { createRoot } from "react-dom/client";
import { Alert } from "@fungi.computer/caps/components/alert";
import { AppError } from "@fungi.computer/agar";
import { keyWire } from "@fungi.computer/ear-tag/keys";
import { oysterKeyVocabulary } from "../keys.js";
import {
  WorkbenchHost,
  appOpenRequestSchema,
  workbenchGillRequestSchema,
  type WorkbenchHostControls,
  type WorkbenchResolvedChild,
  type WorkbenchHostServices,
} from "@fungi.computer/nacre/workbench";
import {
  importShellModule,
  type ShellPlatformControls,
} from "@fungi.computer/nacre/shell-module";
import {
  workbenchDirectorySchema,
  workbenchComputerDirectorySchema,
  type WorkbenchDirectory,
} from "@fungi.computer/nacre/workbench-directory";
import {
  appSandbox,
  applyOysterPageTheme,
  connectOysterApp,
  mountOysterPage,
  oysterAppCapabilities,
  oysterAppConfigSchema,
  oysterShellHandles,
  readOysterPageConfig,
  type OysterAppConfig,
} from "./mount.js";
import * as S from "effect/Schema";

const launchSchema = S.Struct({
  windowId: S.NonEmptyString,
  appId: S.NonEmptyString,
  releaseId: S.NonEmptyString,
  surfaceId: S.NonEmptyString,
  href: S.NonEmptyString,
  title: S.optional(S.String),
  openRequest: S.NullOr(appOpenRequestSchema),
});
const unavailable = (action: string) =>
  new AppError(`This Oyster does not offer ${action}`, {
    code: "CAPABILITY_DENIED",
    retryable: false,
  });
async function json(path: string) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok)
    throw new AppError("Oyster data is unavailable", {
      code:
        response.status === 401 || response.status === 403
          ? "CAPABILITY_DENIED"
          : "HOST_FAILURE",
      retryable: response.status >= 500,
    });
  return S.decodeUnknownSync(S.Json)(await response.json());
}
/**
 * The shell's latest directory read. It is metadata only: whether this host
 * offers its owner's fleet as window context (fixed for a host) and which
 * installation declares a desktop Gill. Every route it leads to re-admits.
 */
let lastDirectory: WorkbenchDirectory | undefined;
const directory = sharedRead(async () => {
  lastDirectory = workbenchDirectorySchema.parse(
    await json("/api/workbench/directory"),
  );
  return lastDirectory;
});
const knownDirectory = async () => lastDirectory ?? (await directory());
async function configuration(href: string): Promise<OysterAppConfig> {
  const response = await fetch(href, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw unavailable("that App");
  return S.decodeUnknownSync(oysterAppConfigSchema)(await response.json());
}
function resolveLaunch(
  raw: Parameters<WorkbenchHost["mount"]>[1],
): WorkbenchResolvedChild {
  const input = S.decodeUnknownSync(launchSchema, {
    onExcessProperty: "error",
  })(raw);
  const url = new URL(input.href, window.location.origin);
  if (url.origin !== window.location.origin || url.hash !== "")
    throw unavailable("that App address");
  const resolved: WorkbenchResolvedChild = {
    launch: {
      windowId: input.windowId,
      appId: input.appId,
      releaseId: input.releaseId,
      surfaceId: input.surfaceId,
      // Release/presentation fields are never authority. Retain only the
      // Computer hint; the owner/fleet admission below must accept it.
      href: computerTargetUrl(
        url.pathname,
        url.searchParams.get("computerId") ?? undefined,
      ),
      openRequest: input.openRequest,
    },
  };
  if (input.title === undefined) return resolved;
  return { ...resolved, title: input.title };
}
async function currentChild(launch: WorkbenchResolvedChild["launch"]) {
  const address = childInstallationAddress(launch.href, window.location.origin);
  if (address === null) throw unavailable("that App selection");
  const fleet = (await knownDirectory()).computerContext === "owner-fleet";
  const computerTarget = fleet
    ? (address.searchParams.get("computerId") ?? undefined)
    : undefined;
  // The App's own configuration is the one fresh read of what this address
  // serves; the launch must still name exactly that installation and Release.
  const config = await configuration(
    computerTargetUrl(address.pathname, computerTarget),
  );
  if (!childMatchesLaunch(launch, address.pathname, config, computerTarget))
    throw unavailable("that changed App selection");
  return { ...config, computerTarget };
}

/** A shell without Settings of its own: this host offers none. */
const noSettings: ShellPlatformControls = {
  controls: {
    sections: [],
    parseSettings: () => {
      throw unavailable("Settings");
    },
    openSettings: () => {
      throw unavailable("Settings");
    },
    subscribeSettingsClosed: () => () => undefined,
    subscribeChanges: () => () => undefined,
    attachDesktopSettings: () => () => undefined,
    requestAppAccess: () => Promise.reject(unavailable("App access requests")),
  } satisfies WorkbenchHostControls,
  suggestDesktopSettings: () => undefined,
  dispose: () => undefined,
};

/**
 * The home installation's page is this host's trusted shell: the picked shell
 * Release's own module renders in this top-level document with the host's
 * escalated permissions, and each App it opens mounts in its own sandboxed
 * frame inside that App's window. This host never bundles a shell.
 */
async function mountShell(config: OysterAppConfig): Promise<() => void> {
  const shellRoot = document.getElementById("oyster-shell");
  if (shellRoot === null) throw new Error("Oyster shell markup is missing");
  if (config.shellModuleUrl === null)
    throw new Error("This home shell Release ships no shell module");
  const shellModule = new URL(config.shellModuleUrl, window.location.origin);
  const theme = applyOysterPageTheme();
  const mountController = new AbortController();
  const mountSignal = mountController.signal;
  const agentBrowser = new OysterAgentBrowserHost(mountSignal);
  const own = oysterShellHandles(config);
  if (own.storage === null)
    throw new Error("The home shell must declare its desktop storage");
  // The picked shell brings its own code, styles and, optionally, the
  // Settings this host has none of; a shell without them gets none.
  const shell = await importShellModule(shellModule, window.location.origin);
  const settings = document.createElement("div");
  document.body.appendChild(settings);
  const platform: ShellPlatformControls =
    shell.mountPlatformControls === null
      ? noSettings
      : await shell.mountPlatformControls(settings, {
          teamId: window.location.origin,
          keysWire: keyWire(oysterKeyVocabulary),
          requestAppAccess: createShellAppAccess(directory),
        });
  const controls = platform.controls;
  const gillWatches = new Set<() => void>();
  const desktopGill = async (
    raw: Parameters<WorkbenchHostServices["requestGill"]>[0],
  ) => {
    const request = S.decodeUnknownSync(workbenchGillRequestSchema, {
      onExcessProperty: "error",
    })(raw);
    // The Gill route re-admits the installation, so the shell's latest read
    // is enough to name it; one more directory read per Gill is not needed.
    const app = (await knownDirectory()).apps.find(
      (item) =>
        item.surfaceId === request.surfaceId &&
        item.availability === "available",
    );
    const gill = app?.gills.find(
      (item) => item.id === request.viewId && item.desktop !== undefined,
    );
    if (app === undefined || gill === undefined || app.installationId === null)
      throw unavailable("that desktop Gill");
    return { request, gill, installationId: app.installationId };
  };
  const services: WorkbenchHostServices = {
    team: () =>
      Promise.resolve({
        team: {
          teamId: window.location.origin,
          name: "Oyster",
          handle: window.location.host,
        },
      }),
    directory: async () => S.decodeUnknownSync(S.Json)(await directory()),
    computers: async ({ limit, offset }) => {
      const current = await directory();
      if (current.computerContext === "owner-fleet")
        return workbenchComputerDirectorySchema.parse(
          await json(
            `/api/workbench/computers?${new URLSearchParams({
              limit: String(limit),
              offset: String(offset),
            })}`,
          ),
        );
      return {
        computers:
          current.computer !== undefined && offset === 0 && limit > 0
            ? [current.computer]
            : [],
        nextOffset: null,
      };
    },
    requestGill: async (input) => {
      const { request, gill, installationId } = await desktopGill(input);
      const selectors = {
        viewId: request.viewId,
        params: request.params,
        after: request.after,
        options: request.options,
      };
      return createGillClient({
        declaration: gill,
        endpoint: `/apps/${encodeURIComponent(installationId)}/gills`,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            credentials: "same-origin",
            cache: "no-store",
          }),
      }).request(selectors);
    },
    watchGillChanges: async (input, onChanged) => {
      const { request, gill, installationId } = await desktopGill(input);
      if (request.options !== undefined || request.after !== undefined)
        throw unavailable("those observation selectors");
      if (gillWatches.size >= 24)
        throw unavailable("more desktop observations");
      const stop = observeDesktopGill(
        onChanged,
        () =>
          gill.watch !== undefined && "storage" in gill.watch
            ? new EventSource(
                `/api/workbench/storage/${encodeURIComponent(installationId)}/events?${new URLSearchParams({ key: gill.watch.storage })}`,
                { withCredentials: true },
              )
            : null,
        window,
      );
      const close = () => {
        stop();
        gillWatches.delete(close);
      };
      gillWatches.add(close);
      return {
        close: () => {
          close();
          return Promise.resolve();
        },
      };
    },
    memberAvatar: () => Promise.resolve(null),
    suggestDesktopSettings: (surfaceId) => {
      platform.suggestDesktopSettings(surfaceId);
      return Promise.resolve();
    },
    dispose: () => undefined,
  };
  const workbench = new WorkbenchHost({
    hostWindow: window,
    resolveLaunch,
    services,
    reportAgentSessionSelection: () => undefined,
    platform: {
      controls,
      destinations: () => Promise.resolve([]),
      open: () => {
        throw unavailable("that platform destination");
      },
      takeAppOpenRequest: () => Promise.resolve(null),
    },
    prepareChild: async (launch) => {
      const childConfig = await currentChild(launch);
      const abort = new AbortController();
      const signal = AbortSignal.any([mountSignal, abort.signal]);
      return {
        commands: childConfig.commands,
        dispose: () => {
          abort.abort();
          return Promise.resolve();
        },
        mount: async (options) => {
          const frame = document.createElement("iframe");
          frame.sandbox.value = appSandbox;
          frame.src = childConfig.uiUrl;
          frame.title = options.title ?? childConfig.appId;
          // The window's slot is the frame's only home: the shell sizes it
          // there, and it moves, clips and stacks with that window.
          options.container.appendChild(frame);
          let contextVersion = 1;
          // reconfigure moves this forward, so a later restore
          // (setVisibility) never resends the window's first open request.
          const launchTracker = createWindowLaunchTracker({
            openRequest: launch.openRequest,
            computerId: childConfig.computerId,
          });
          // The Tourtois shell routes roles; the child never names a surface.
          const { onAppOpen, onAppRole } = options.events;
          const appOpen =
            onAppOpen && onAppRole
              ? { open: onAppOpen, role: onAppRole }
              : undefined;
          const host = await connectOysterApp({
            agentBrowser,
            agentCommands: options.commands.agentCommands,
            config: childConfig,
            computerTarget: childConfig.computerTarget,
            ...(appOpen && { appOpen }),
            frame,
            signal,
            surfaceId: launch.surfaceId,
            openRequest: launch.openRequest,
            reservedChords: [],
            theme,
            handlers: {
              ...options.commands.handlers,
              onDisconnect: () => {
                abort.abort();
                frame.remove();
                return Promise.resolve();
              },
              openNavigation: (input) =>
                options.events.onNavigation?.(input) ??
                Promise.reject(unavailable("file navigation")),
              openDesktopSettings: () =>
                options.onDesktopSettings(launch.surfaceId),
              requestAppPermissions: (input) =>
                options.onPermissionRequest(input, {
                  computerId: launchTracker.current().computerId,
                }),
              requestComputerChoice: () =>
                options.events.onComputerChoice?.() ??
                Promise.reject(unavailable("Computer choice")),
              reportFocus: () =>
                options.events.onFocus?.(document.activeElement === frame) ??
                Promise.resolve(),
              reportNavigation: (state) =>
                options.events.onNavigationState?.(state) ?? Promise.resolve(),
              reportStatus: (items) =>
                options.events.onStatusItems?.(items) ?? Promise.resolve(),
              reportAgentSessionSelection:
                options.events.onAgentSessionSelection,
              showToast: () => Promise.reject(unavailable("notifications")),
            },
          });
          return {
            dispose: () => {
              abort.abort();
              host.dispose();
              frame.remove();
            },
            requestClose: () => host.requestClose(),
            requestBack: () => host.requestBack(),
            activateStatus: (action) => host.activateStatus(action),
            activateNavigation: (activation) =>
              host.activateNavigation(activation),
            setVisibility: (visibility) => {
              frame.hidden = visibility === "hidden";
              const target = launchTracker.current();
              return host.updateContext({
                version: ++contextVersion,
                value: {
                  computerId: target.computerId,
                  focus: { editing: false, surface: null },
                  visibility,
                  openRequest: target.openRequest,
                },
              });
            },
            reconfigure: async (next) => {
              const fresh = await currentChild(next);
              const capabilities = await oysterAppCapabilities({
                config: fresh,
                computerTarget: fresh.computerTarget,
                signal,
                ...(appOpen && { appOpen }),
              });
              await host.reconfigure({
                capabilities,
                context: {
                  version: ++contextVersion,
                  value: {
                    computerId: fresh.computerId,
                    focus: { editing: false, surface: null },
                    visibility: frame.hidden ? "hidden" : "visible",
                    openRequest: next.openRequest,
                  },
                },
              });
              launchTracker.advance({
                openRequest: next.openRequest,
                computerId: fresh.computerId,
              });
            },
          };
        },
      };
    },
    log: (event, fields) => {
      console.error(event, fields);
    },
  });
  const dispose = () => {
    mountController.abort();
    for (const close of gillWatches) close();
    workbench[Symbol.dispose]();
    platform.dispose();
    settings.remove();
  };
  try {
    const unmountShell = await shell.mountShell(shellRoot, {
      workbench,
      storage: own.storage,
      methods: own.methods,
    });
    return () => {
      unmountShell();
      dispose();
    };
  } catch (cause) {
    dispose();
    throw cause;
  }
}

const start = async (): Promise<void> => {
  const config = readOysterPageConfig();
  if (!config.workbench) {
    await mountOysterPage();
    return;
  }
  // The shell and every App it opened leave with the page.
  window.addEventListener("pagehide", await mountShell(config), {
    once: true,
  });
};

start().catch((cause: unknown) => {
  const message =
    cause instanceof Error ? cause.message : "Oyster home connection failed";
  document.body.dataset.oysterError = message;
  const notice = document.createElement("div");
  document.body.appendChild(notice);
  createRoot(notice).render(
    <Alert
      tone="error"
      title="Oyster home could not open"
      description={message}
    />,
  );
});
