import * as Redacted from "effect/Redacted";
import {
  AppError,
  statusActionAllowed,
  type AppNavigationState,
  type AppStatusAction,
  type AppStatusItem,
} from "@fungi.computer/agar";

/**
 * Shared window lifetime owner for browser and terminal shells.
 *
 * This module knows how a window is mounted and disposed. It deliberately does
 * not know how an App is selected, admitted, or transported; those decisions
 * are made by the owner issuing the launch descriptor.
 */

/** Mount failures may outlive their window; keep their cause safe and observable. */
function defaultFailure(
  windowId: string,
  generation: number | null,
  phase: "mount" | "mutation",
  cause: unknown,
) {
  console.error(
    `App window ${phase} failed`,
    { windowId, generation, phase },
    Redacted.make(cause),
  );
}

function sameStatusItems(
  current: readonly AppStatusItem[],
  next: readonly AppStatusItem[],
): boolean {
  // Decoded status items are plain data, so their serialization is their value.
  return JSON.stringify(current) === JSON.stringify(next);
}

function sameNavigation(
  current: AppNavigationState | null,
  next: AppNavigationState | null,
): boolean {
  if (current === null || next === null) return current === next;
  return current.canGoBack === next.canGoBack && current.title === next.title;
}

/** Minimum identity required to own a window across mount generations. */
export type WindowLaunch = Readonly<{ windowId: string }>;

/** Current presentation state of a managed window. */
export type WindowStatus = "loading" | "ready" | "minimized" | "error";

/** Mount operations supplied by the embedding host; selection and authority stay with it. */
export type WindowHost<Launch extends WindowLaunch> = Readonly<{
  /** Show or hide the current mount without disposing it. */
  setVisibility: (visibility: "hidden" | "visible") => void | Promise<void>;
  /** Reconfigure the mounted App without replacing its iframe or root. */
  reconfigure: (launch: Launch, signal?: AbortSignal) => void | Promise<void>;
  /** Ask the mounted App whether a user initiated close may discard work. */
  requestClose?: () => boolean | Promise<boolean>;
  /** Ask the mounted App to go back in its own history; `true` when it did. */
  requestBack?: () => boolean | Promise<boolean>;
  /** Deliver the person's use of a status item; `true` when the App acted. */
  activateStatus?: (action: AppStatusAction) => boolean | Promise<boolean>;
  /** Release the current mount and its host resources. */
  dispose: () => void | Promise<void>;
}>;

/** What a mounted App tells its window while it lives. */
export type WindowEvents = Readonly<{
  /** Open this generation's shell-owned Computer picker. */
  onComputerChoice: () => Promise<void>;
  /** The App's latest parsed navigation state; `null` withdraws it. */
  onNavigationState: (state: AppNavigationState | null) => void;
  /** The App's latest parsed status readouts; an empty list clears them. */
  onStatusItems: (items: readonly AppStatusItem[]) => void;
}>;

/** Immutable snapshot of one window and its mount generation. */
export type WindowProjection<
  Launch extends WindowLaunch,
  Container,
> = Readonly<{
  windowId: string;
  launch: Launch;
  container: Container;
  status: WindowStatus;
  generation: number;
  error?: unknown;
  cleanupError?: unknown;
  /** The ready App's navigation state; `null` while it reports none. */
  navigation: AppNavigationState | null;
  /** The App's status readouts for its window's status bar. */
  statusItems: readonly AppStatusItem[];
}>;

/** Current ordered collection of managed window snapshots. */
export type WindowsProjection<
  Launch extends WindowLaunch,
  Container,
> = Readonly<{
  windows: readonly WindowProjection<Launch, Container>[];
}>;

/** Whether any projected App window is still visible in the workspace. */
export function hasVisibleWindows<Launch extends WindowLaunch, Container>(
  projection: WindowsProjection<Launch, Container>,
): boolean {
  return projection.windows.some((window) => window.status !== "minimized");
}

/** Create a host-owned mount in a container, observing cancellation and navigation. */
export type WindowMount<Launch extends WindowLaunch, Container> = (
  container: Container,
  launch: Launch,
  signal: AbortSignal,
  events: WindowEvents,
) => WindowHost<Launch> | Promise<WindowHost<Launch>>;

/** Own window lifetimes, visibility and serialized host mutations. */
export type WindowManager<Launch extends WindowLaunch, Container> = Readonly<{
  /** Open a window or restore the existing window with the same identity. */
  open: (launch: Launch) => Promise<void>;
  /** Notify the manager that a waiting container is attached. */
  attach: (windowId: string) => void;
  /** Hide one window without disposing its mount. */
  minimize: (windowId: string) => Promise<void>;
  /** Show an individually hidden window. */
  restore: (windowId: string) => Promise<void>;
  /** Hide visible Apps without closing them; preserve individually minimized Apps. */
  hideAll: () => Promise<void>;
  /** Restore surviving windows from the last Show desktop operation. */
  restoreHidden: () => Promise<void>;
  /** Consult the App before disposing and removing its window. */
  close: (windowId: string) => Promise<void>;
  /** Update a mounted window through the host after validation. */
  reconfigure: (windowId: string, launch: Launch) => Promise<void>;
  /**
   * Reconfigure from the launch committed when the window's mutation queue
   * reaches this change, so it never reapplies a stale snapshot over an
   * earlier queued change.
   */
  update: (
    windowId: string,
    derive: (current: Launch) => Launch,
  ) => Promise<void>;
  /** Consult the old App, dispose it, then create a new mount generation. */
  replace: (windowId: string, launch: Launch) => Promise<void>;
  /** Ask a ready window's App to go back; `false` when it cannot. */
  back: (windowId: string) => Promise<boolean>;
  /** Deliver a status item action to a ready window's App; `false` when it cannot. */
  activateStatus: (
    windowId: string,
    action: AppStatusAction,
  ) => Promise<boolean>;
  /** Register the current window generation's host-owned picker. */
  registerComputerChoice: (windowId: string, handler: () => void) => () => void;
  /** Dispose all surviving windows and release subscriptions. */
  dispose: () => Promise<void>;
  /** Read the current immutable window projection. */
  read: () => WindowsProjection<Launch, Container>;
  /** Observe projection changes until the returned disposer is called. */
  subscribe: (listener: () => void) => () => void;
}>;

/** Host adapters used to create, attach and validate window mounts. */
export type WindowManagerOptions<
  Launch extends WindowLaunch,
  Container,
> = Readonly<{
  mount: WindowMount<Launch, Container>;
  /** Create a container for a new window generation. */
  createContainer: (launch: Launch) => Container;
  /**
   * A renderer may create a projection container before attaching it. Waiting
   * here keeps iframe and Agar setup inside a real document tree.
   */
  waitForAttachment?: boolean;
  /** Observe mount or mutation failures, including failures after retirement. */
  onFailure?: (
    failure: Readonly<{
      windowId: string;
      generation: number | null;
      phase: "mount" | "mutation";
      cause: unknown;
    }>,
  ) => void;
  /** Report whether the renderer has attached a container. */
  isAttached?: (container: Container) => boolean;
  /** Reject an inadmissible launch change before it reaches the mounted host. */
  validateReconfiguration?: (current: Launch, next: Launch) => void;
  /**
   * Whether `next` differs from `current` only in shell chrome the mounted
   * App never sees. Such a change is committed without reconfiguring the App.
   */
  isChromeOnlyChange?: (current: Launch, next: Launch) => boolean;
}>;

type WindowRecord<Launch extends WindowLaunch, Container> = {
  launch: Launch;
  container: Container;
  generation: number;
  status: WindowStatus;
  controller: AbortController;
  host: WindowHost<Launch> | undefined;
  disposed: boolean;
  retiring: boolean;
  disposal: Promise<void> | undefined;
  mountPromise: Promise<void> | undefined;
  hostOperation: Promise<void> | undefined;
  reconfigureController: AbortController | undefined;
  closeRequested: boolean;
  error: unknown;
  cleanupError: unknown;
  visibility: "hidden" | "visible";
  attachmentWaiters: Set<(attached: boolean) => void>;
  visibilityVersion: number;
  navigation: AppNavigationState | null;
  statusItems: readonly AppStatusItem[];
  computerChoice: (() => void) | undefined;
};

/**
 * Owns App-window generations while leaving selection and App authority to the
 * caller. A stale mount is always disposed when it eventually resolves.
 */
export function createWindowManager<Launch extends WindowLaunch, Container>(
  options: WindowManagerOptions<Launch, Container>,
): WindowManager<Launch, Container> {
  const reportFailure = (
    windowId: string,
    generation: number | null,
    phase: "mount" | "mutation",
    cause: unknown,
  ) => {
    if (options.onFailure !== undefined)
      options.onFailure({ windowId, generation, phase, cause });
    else defaultFailure(windowId, generation, phase, cause);
  };
  const records = new Map<string, WindowRecord<Launch, Container>>();
  const hiddenForDesktop = new Set<WindowRecord<Launch, Container>>();
  const listeners = new Set<() => void>();
  const operations = new Map<string, Promise<void>>();
  let managerDisposed = false;
  let disposalInFlight: Promise<void> | undefined;

  const enqueueMutation = (windowId: string, task: () => Promise<void>) => {
    const generation = records.get(windowId)?.generation ?? null;
    const previous = operations.get(windowId) ?? Promise.resolve();
    const next = previous.then(task);
    const settled: Promise<void> = next.then(
      () => {
        if (operations.get(windowId) === settled) operations.delete(windowId);
      },
      (cause: unknown) => {
        reportFailure(windowId, generation, "mutation", cause);
        if (operations.get(windowId) === settled) operations.delete(windowId);
      },
    );
    operations.set(windowId, settled);
    return next;
  };

  const project = (): WindowsProjection<Launch, Container> => ({
    windows: Array.from(records.values(), (record) => {
      const projected = {
        windowId: record.launch.windowId,
        launch: record.launch,
        container: record.container,
        status: record.status,
        generation: record.generation,
        // A loading, hidden or failed App offers no Back.
        navigation: record.status === "ready" ? record.navigation : null,
        statusItems: record.statusItems,
      };
      const withError =
        record.error === undefined
          ? projected
          : { ...projected, error: record.error };
      return record.cleanupError === undefined
        ? withError
        : { ...withError, cleanupError: record.cleanupError };
    }),
  });
  let projection = project();
  const notify = () => {
    projection = project();
    for (const listener of Array.from(listeners)) listener();
  };
  const read = () => projection;

  const isCurrent = (record: WindowRecord<Launch, Container>) =>
    records.get(record.launch.windowId) === record;
  const isActive = (record: WindowRecord<Launch, Container>) =>
    isCurrent(record) &&
    !record.controller.signal.aborted &&
    !record.retiring &&
    !record.disposed;
  const hasCloseRequest = (record: WindowRecord<Launch, Container>) =>
    record.closeRequested;
  const isVisibilityCurrent = (
    record: WindowRecord<Launch, Container>,
    version: number,
  ) =>
    isCurrent(record) &&
    !record.disposed &&
    record.visibilityVersion === version;
  const reconfigurationWasCancelled = (
    record: WindowRecord<Launch, Container>,
    controller: AbortController,
  ) =>
    controller.signal.aborted || hasCloseRequest(record) || !isActive(record);

  const retire = (record: WindowRecord<Launch, Container>) => {
    hiddenForDesktop.delete(record);
    if (!record.retiring) {
      record.retiring = true;
      record.controller.abort();
    }
    for (const resolve of record.attachmentWaiters) resolve(false);
    record.attachmentWaiters.clear();
  };

  /**
   * Dispose the host currently owned by a record. The disposal promise is
   * shared, so close, replacement, and setup failure cannot call a host's
   * disposer twice. A host operation is allowed to settle before disposal;
   * otherwise visibility and disposal would race on the same connection.
   */
  const disposeRecordHost = async (record: WindowRecord<Launch, Container>) => {
    if (record.disposed) return;
    if (record.disposal) {
      await record.disposal;
      return;
    }

    for (const resolve of record.attachmentWaiters) resolve(false);
    record.attachmentWaiters.clear();
    const disposal = (async () => {
      // A retiring record may still be awaiting attachment or its async mount.
      // `mount` disposes any host that arrives after retirement; waiting here
      // makes close/dispose mean that cleanup has actually completed.
      if (!record.host && record.mountPromise) await record.mountPromise;
      const host = record.host;
      if (!host) {
        record.disposed = true;
        return;
      }
      const operation = record.hostOperation;
      if (operation) {
        try {
          await operation;
        } catch (error) {
          // The visibility owner records this failure as the primary error
          // when it handles the operation. This branch covers close winning
          // the race and therefore records it here as well.
          if (record.error === undefined) {
            record.status = "error";
            record.error = error;
            notify();
          }
        }
      }
      await host.dispose();
      if (record.host === host) record.host = undefined;
      record.disposed = true;
    })();
    record.disposal = disposal;
    try {
      await disposal;
    } catch (error) {
      record.disposal = undefined;
      record.cleanupError = error;
      notify();
      throw error;
    }
  };

  const disposeLateHost = async (
    record: WindowRecord<Launch, Container>,
    host: WindowHost<Launch>,
  ) => {
    try {
      await host.dispose();
    } catch (error) {
      record.cleanupError = error;
      if (isCurrent(record) && record.error === undefined) {
        record.status = "error";
        record.error = error;
        notify();
      }
      throw error;
    }
  };

  const setHostVisibility = async (
    record: WindowRecord<Launch, Container>,
    host: WindowHost<Launch>,
    visibility: "hidden" | "visible",
  ) => {
    const operation = Promise.resolve().then(() =>
      host.setVisibility(visibility),
    );
    record.hostOperation = operation;
    try {
      await operation;
    } finally {
      if (record.hostOperation === operation) record.hostOperation = undefined;
    }
  };

  const applyVisibility = async (
    record: WindowRecord<Launch, Container>,
    version: number,
  ) => {
    if (!isVisibilityCurrent(record, version) || record.retiring) return;
    const host = record.host;
    if (!host) return;
    const requested = record.visibility;
    try {
      await setHostVisibility(record, host, requested);
    } catch (error) {
      if (!isVisibilityCurrent(record, version)) return;
      record.status = "error";
      record.error = error;
      notify();
      try {
        await disposeRecordHost(record);
      } catch (cleanupError) {
        // Keep the visibility error in `error`; cleanupError makes the second
        // failure observable without changing the first failure's identity.
        record.cleanupError = cleanupError;
        notify();
        throw cleanupError;
      }
    }
  };

  const mount = async (record: WindowRecord<Launch, Container>) => {
    performance.mark("fungi.app-open.window-mount-start");
    if (options.waitForAttachment && !options.isAttached?.(record.container)) {
      performance.mark("fungi.app-open.window-wait-for-attachment");
      const attached = await new Promise<boolean>((resolve) => {
        record.attachmentWaiters.add(resolve);
      });
      if (!attached) return;
      performance.mark("fungi.app-open.window-attached");
    }
    let host: WindowHost<Launch>;
    try {
      performance.mark("fungi.app-open.window-host-mount-start");
      host = await options.mount(
        record.container,
        record.launch,
        record.controller.signal,
        {
          onComputerChoice: () =>
            Promise.resolve().then(() => {
              if (
                !isActive(record) ||
                record.status !== "ready" ||
                record.computerChoice === undefined
              )
                throw new AppError(
                  "Computer choice is unavailable for this window",
                  { code: "CAPABILITY_DENIED", retryable: false },
                );
              record.computerChoice();
            }),
          onNavigationState: (state) => {
            // A retired generation never speaks for the window again.
            if (!isActive(record) || sameNavigation(record.navigation, state))
              return;
            record.navigation = state;
            notify();
          },
          onStatusItems: (items) => {
            if (!isActive(record) || sameStatusItems(record.statusItems, items))
              return;
            record.statusItems = items;
            notify();
          },
        },
      );
      performance.mark("fungi.app-open.window-host-mount-ready");
    } catch (error) {
      if (!isActive(record)) {
        if (error !== record.controller.signal.reason)
          reportFailure(
            record.launch.windowId,
            record.generation,
            "mount",
            error,
          );
        return;
      }
      record.status = record.visibility === "hidden" ? "minimized" : "error";
      record.error = error;
      notify();
      return;
    }

    if (!isActive(record)) {
      await disposeLateHost(record, host);
      return;
    }

    record.host = host;
    if (record.visibility === "hidden") {
      await applyVisibility(record, record.visibilityVersion);
    }
    if (!isActive(record)) {
      await disposeRecordHost(record);
      return;
    }
    if (record.status !== "error") {
      record.status = record.visibility === "hidden" ? "minimized" : "ready";
      record.error = undefined;
      record.cleanupError = undefined;
      notify();
    }
  };

  const startMount = (record: WindowRecord<Launch, Container>) => {
    const mounted = mount(record);
    record.mountPromise = mounted;
    // Callers such as React effect cleanup can intentionally ignore open's
    // promise. Keep that ordinary use from creating an unhandled rejection;
    // the original promise still reports failures to callers that await it.
    void mounted.catch((cause: unknown) => {
      reportFailure(record.launch.windowId, record.generation, "mount", cause);
      return undefined;
    });
    return mounted;
  };

  const createRecord = (
    launch: Launch,
    generation: number,
  ): WindowRecord<Launch, Container> => ({
    launch,
    container: options.createContainer(launch),
    generation,
    status: "loading",
    controller: new AbortController(),
    host: undefined,
    disposed: false,
    retiring: false,
    disposal: undefined,
    mountPromise: undefined,
    hostOperation: undefined,
    reconfigureController: undefined,
    closeRequested: false,
    error: undefined,
    cleanupError: undefined,
    visibility: "visible",
    attachmentWaiters: new Set(),
    visibilityVersion: 0,
    navigation: null,
    statusItems: [],
    computerChoice: undefined,
  });

  const open = (launch: Launch) => {
    const existingAtCall = records.get(launch.windowId);
    const created =
      !managerDisposed && !existingAtCall ? createRecord(launch, 1) : undefined;
    let mounted: Promise<void> | undefined;
    if (created) {
      records.set(launch.windowId, created);
      notify();
      mounted = startMount(created);
    }
    const operation = enqueueMutation(launch.windowId, async () => {
      if (managerDisposed) {
        if (created && records.get(launch.windowId) === created) {
          retire(created);
          await disposeRecordHost(created);
          records.delete(launch.windowId);
          notify();
        }
        return;
      }
      const existing = records.get(launch.windowId);
      if (created) {
        if (existing !== created) return;
        return;
      }
      if (existing) {
        mounted = existing.mountPromise;
        if (existing.visibility === "hidden" && !existing.retiring) {
          const version = ++existing.visibilityVersion;
          existing.visibility = "visible";
          existing.status =
            existing.error !== undefined
              ? "error"
              : existing.host
                ? "ready"
                : "loading";
          notify();
          if (existing.error === undefined)
            await applyVisibility(existing, version);
        } else {
          notify();
        }
        return;
      }
      const record = createRecord(launch, 1);
      records.set(launch.windowId, record);
      notify();
      mounted = startMount(record);
    });
    return operation.then(async () => {
      if (mounted) await mounted;
    });
  };

  const attach = (windowId: string) => {
    if (managerDisposed) return;
    const record = records.get(windowId);
    if (!record || record.disposed || record.retiring) return;
    for (const resolve of record.attachmentWaiters) resolve(true);
    record.attachmentWaiters.clear();
  };

  const requestVisibility = (
    windowId: string,
    visibility: "hidden" | "visible",
  ) => {
    const record = records.get(windowId);
    if (managerDisposed) return Promise.resolve();
    // A failed App still has a visible error window, even after its host was
    // disposed. Hide that presentation without discarding the failure.
    if (record && !record.retiring && record.error !== undefined) {
      record.visibility = visibility;
      record.status = visibility === "hidden" ? "minimized" : "error";
      notify();
      return Promise.resolve();
    }
    if (
      !record ||
      record.disposed ||
      record.retiring ||
      record.status === "error"
    ) {
      return enqueueMutation(windowId, async () => {
        const next = records.get(windowId);
        if (!next || next.disposed || next.retiring || next.status === "error")
          return;
        const nextVersion = ++next.visibilityVersion;
        next.visibility = visibility;
        next.status =
          visibility === "hidden"
            ? "minimized"
            : next.host
              ? "ready"
              : "loading";
        notify();
        await applyVisibility(next, nextVersion);
      });
    }
    const version = ++record.visibilityVersion;
    record.visibility = visibility;
    record.status =
      visibility === "hidden" ? "minimized" : record.host ? "ready" : "loading";
    notify();
    return enqueueMutation(windowId, () => applyVisibility(record, version));
  };

  const minimize = (windowId: string) => requestVisibility(windowId, "hidden");

  const restore = (windowId: string) => requestVisibility(windowId, "visible");

  const hideAll = async () => {
    if (managerDisposed) return;
    const visible = [...records.values()].filter(
      (record) => !record.retiring && record.visibility === "visible",
    );
    for (const record of visible) hiddenForDesktop.add(record);
    await Promise.all(
      visible.map((record) => minimize(record.launch.windowId)),
    );
  };

  const restoreHidden = async () => {
    const hidden = [...hiddenForDesktop];
    hiddenForDesktop.clear();
    await Promise.all(
      hidden
        .filter((record) => records.get(record.launch.windowId) === record)
        .map((record) => restore(record.launch.windowId)),
    );
  };

  const consultClose = async (
    record: WindowRecord<Launch, Container>,
  ): Promise<boolean> => {
    // Manager disposal is the host/process teardown path; it cannot wait for
    // an interactive dirty-buffer decision.
    if (managerDisposed) return true;
    const requestClose = record.host?.requestClose;
    if (!requestClose) return true;
    try {
      return await requestClose();
    } catch (error) {
      if (isCurrent(record)) {
        record.status = "error";
        record.error = error;
        notify();
      }
      throw error;
    }
  };

  const close = (windowId: string) => {
    const current = records.get(windowId);
    const hadRecordAtCall = current !== undefined;
    // Invalidate an in-flight reconfiguration immediately. The serialized
    // close still performs the dirty-buffer consultation before disposal, but
    // a late reconfiguration result must not become the committed launch.
    current?.reconfigureController?.abort();
    if (current) current.closeRequested = true;
    return enqueueMutation(windowId, async () => {
      if (!hadRecordAtCall) return;
      const record = records.get(windowId);
      if (!record) return;
      // Consultation belongs inside the serialized mutation. A replacement
      // or second close must not race an App's dirty-buffer decision.
      let mayClose: boolean;
      try {
        mayClose = await consultClose(record);
      } catch (error) {
        record.closeRequested = false;
        throw error;
      }
      if (!mayClose) {
        record.closeRequested = false;
        return;
      }
      retire(record);
      try {
        await disposeRecordHost(record);
      } catch (error) {
        if (isCurrent(record)) {
          record.status = "error";
          // An earlier mount/visibility error remains the primary projection
          // error; this cleanup failure is exposed beside it.
          if (record.error === undefined) record.error = error;
          record.cleanupError = error;
          notify();
        }
        throw error;
      }
      if (!isCurrent(record)) return;
      records.delete(windowId);
      notify();
    });
  };

  const update = (windowId: string, derive: (current: Launch) => Launch) => {
    const operation = enqueueMutation(windowId, async () => {
      if (managerDisposed) return;
      const record = records.get(windowId);
      if (!record || record.disposed || record.retiring) return;
      if (hasCloseRequest(record)) return;
      const next = { ...derive(record.launch), windowId };
      options.validateReconfiguration?.(record.launch, next);
      if (options.isChromeOnlyChange?.(record.launch, next) === true) {
        record.launch = next;
        notify();
        return;
      }

      const controller = new AbortController();
      record.reconfigureController = controller;
      try {
        if (!record.host && record.mountPromise) await record.mountPromise;
        if (reconfigurationWasCancelled(record, controller)) return;
        const host = record.host;
        if (!host)
          throw new Error("The App host is not ready for reconfiguration.");

        const hostOperation = Promise.resolve().then(() =>
          host.reconfigure(next, controller.signal),
        );
        record.hostOperation = hostOperation;
        try {
          await hostOperation;
        } finally {
          if (record.hostOperation === hostOperation)
            record.hostOperation = undefined;
        }
        if (reconfigurationWasCancelled(record, controller)) return;

        // The old descriptor remains authoritative until the mounted host has
        // accepted its new configuration. Reconfiguration keeps the same
        // generation and container, so only the descriptor is committed here.
        record.launch = next;
        record.status = record.visibility === "hidden" ? "minimized" : "ready";
        record.error = undefined;
        record.cleanupError = undefined;
        notify();
      } catch (error) {
        if (reconfigurationWasCancelled(record, controller)) return;
        // Keep the existing host and descriptor mounted so the caller can
        // report the failure and retry without creating a second iframe. The
        // rejected operation is the failure surface; changing the projection
        // to "error" would incorrectly hide that the old App is still usable.
        throw error;
      } finally {
        if (record.reconfigureController === controller)
          record.reconfigureController = undefined;
      }
    });
    return operation;
  };

  const reconfigure = (windowId: string, launch: Launch) =>
    update(windowId, () => launch);

  const replace = (windowId: string, launch: Launch) => {
    let mounted: Promise<void> | undefined;
    const operation = enqueueMutation(windowId, async () => {
      if (managerDisposed) return;
      const previous = records.get(windowId);
      let restoreWithDesktop = false;
      if (previous) {
        if (!(await consultClose(previous))) return;
        restoreWithDesktop = hiddenForDesktop.has(previous);
        retire(previous);
        try {
          await disposeRecordHost(previous);
        } catch (error) {
          if (isCurrent(previous)) {
            previous.status = "error";
            if (previous.error === undefined) previous.error = error;
            previous.cleanupError = error;
            notify();
          }
          throw error;
        }
      }
      const descriptor = { ...launch, windowId };
      const record = createRecord(
        descriptor,
        previous ? previous.generation + 1 : 1,
      );
      if (previous?.visibility === "hidden") {
        record.visibility = "hidden";
        record.status = "minimized";
      }
      if (restoreWithDesktop) hiddenForDesktop.add(record);
      records.set(windowId, record);
      notify();
      mounted = startMount(record);
    });
    return operation.then(async () => {
      if (mounted) await mounted;
    });
  };

  const back = async (windowId: string): Promise<boolean> => {
    const record = records.get(windowId);
    if (
      !record ||
      !isActive(record) ||
      record.status !== "ready" ||
      record.navigation?.canGoBack !== true
    )
      return false;
    const requestBack = record.host?.requestBack;
    return requestBack ? await requestBack() : false;
  };

  const activateStatus = async (
    windowId: string,
    action: AppStatusAction,
  ): Promise<boolean> => {
    const record = records.get(windowId);
    if (!record || !isActive(record) || record.status !== "ready") return false;
    // Only an enabled item (and option) the App currently declares.
    if (!statusActionAllowed(record.statusItems, action)) return false;
    const deliver = record.host?.activateStatus;
    return deliver ? await deliver(action) : false;
  };

  const registerComputerChoice = (windowId: string, handler: () => void) => {
    const record = records.get(windowId);
    if (!record || !isActive(record))
      throw new AppError("App window is unavailable", {
        code: "DISCONNECTED",
        retryable: false,
      });
    record.computerChoice = handler;
    return () => {
      if (record.computerChoice === handler) record.computerChoice = undefined;
    };
  };

  const disposeAll = async () => {
    managerDisposed = true;
    for (const record of records.values()) {
      record.closeRequested = true;
      record.reconfigureController?.abort();
    }
    try {
      // Finish already-enqueued setup/state work before taking the record
      // snapshot. New public work is rejected by managerDisposed meanwhile.
      await Promise.allSettled(operations.values());
      const failures: unknown[] = [];
      const results = await Promise.allSettled(
        [...records.keys()].map((windowId) => close(windowId)),
      );
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose App windows");
      }
    } finally {
      listeners.clear();
    }
  };

  const dispose = () => {
    if (disposalInFlight) return disposalInFlight;
    const pending = disposeAll();
    disposalInFlight = pending;
    void pending.then(
      () => {
        if (disposalInFlight === pending) disposalInFlight = undefined;
      },
      () => {
        if (disposalInFlight === pending) disposalInFlight = undefined;
      },
    );
    return pending;
  };

  return {
    open,
    attach,
    minimize,
    restore,
    hideAll,
    restoreHidden,
    close,
    reconfigure,
    update,
    activateStatus,
    registerComputerChoice,
    replace,
    back,
    dispose,
    read,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
