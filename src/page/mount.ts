import {
  appOpenInputSchema,
  appsCall,
  appsOpen,
  type AppOpenInput,
  type AppRoleChoice,
} from "@fungi.computer/agar/apps";
import { appApiMethodNameSchema } from "@fungi.computer/puffball/app";
import { appIdSchema } from "@fungi.computer/puffball/effect";
import { createBrowserActionHandler } from "@fungi.computer/nacre";
import { createAppSurfaceCommandHost } from "@fungi.computer/nacre/command-host";
// App page: mounts one installed App's sandboxed frame and gives it the
// capabilities this Oyster host provides. Bundled into `shellScript`.
import { RpcTarget, RpcStub } from "@fungi.computer/capnweb";
import { EventSource } from "eventsource";
import {
  connectBrowser,
  UiBrowserError,
  type BrowserConnection,
} from "@fungi.computer/knapsack/ui/browser";
import type { WhistleRuntime } from "@fungi.computer/whistle";
import { createPageLifetime } from "./lifetime.js";
import { computerTargetUrl } from "./computer-target.js";
import * as Schema from "effect/Schema";
import {
  AppError,
  createCapabilityRegistry,
  type CapabilityDirectory,
  type AgentSessionSelection,
} from "@fungi.computer/agar";
import { appStorage } from "@fungi.computer/agar/storage";
import { approvals } from "@fungi.computer/agar/approvals";
import { oysterStorageHandle } from "./storage.js";
import { appBackend, appMethods } from "@fungi.computer/agar/backend";
import {
  computerList,
  computerPorts,
  computerProcesses,
  computerReadFile,
  computerTerminal,
  computerWriteFile,
} from "@fungi.computer/agar/computer";
import {
  agentList,
  agentManage,
  agentSessionRead,
  agentSessionWrite,
  openAppAgent,
  type AppAgentTransport,
} from "@fungi.computer/agar/agents";
import { mediaGeneration } from "@fungi.computer/agar/media";
import {
  MediaGeneration,
  mediaGenerationDescriptionSchema,
} from "@fungi.computer/agar/media-json";

import {
  registeredCapabilityHandle,
  type CapabilityRegistration,
} from "./capabilities.js";
import { capabilityDescriptorSchema } from "../capability-descriptor.js";
import {
  connectAppHost,
  type AppHost,
  type AppHostLaunch,
  type AppHostHandlers,
} from "@fungi.computer/agar/host";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { parseJsonValue } from "@fungi.computer/whistle/wire";
import { appDeclaredCommandSchema } from "@fungi.computer/puffball/app";
import { TerminalCapability } from "./terminal.js";
import {
  ComputerPortsHandle,
  ComputerProcessesHandle,
} from "./computer-handles.js";

// Embedded maintained Caps styles, plus the shell's own styles in a host build.
declare const OYSTER_SHELL_STYLES: string;

/** One page-wide selected Session, using only its reporting App's admitted view. */
export class OysterAgentBrowserHost {
  #active: { frame: HTMLIFrameElement; close: () => void } | undefined;
  #disposed = false;

  /** End the selected connection with the page's own lifetime. */
  constructor(signal: AbortSignal) {
    if (signal.aborted) this.dispose();
    else
      signal.addEventListener(
        "abort",
        () => {
          this.dispose();
        },
        { once: true },
      );
  }

  /** A departing or deselecting mount cannot close a different active mount. */
  release(frame: HTMLIFrameElement): void {
    if (this.#active?.frame !== frame) return;
    const previous = this.#active;
    this.#active = undefined;
    previous.close();
  }

  /** Release the page's current selection; later reports cannot reconnect it. */
  dispose(): void {
    this.#disposed = true;
    if (this.#active !== undefined) this.release(this.#active.frame);
  }

  /** Bind the reporting mount's current command view to its explicitly selected Session. */
  async report(
    frame: HTMLIFrameElement,
    selection: AgentSessionSelection | null,
    capabilities: CapabilityDirectory,
    whistle: Pick<WhistleRuntime, "snapshot" | "execute">,
  ): Promise<void> {
    if (this.#disposed) return;
    if (selection === null) {
      this.release(frame);
      return;
    }
    if (this.#active !== undefined) this.release(this.#active.frame);
    // Read-only Apps may observe Sessions, but cannot claim or settle UI work.
    if (!capabilities.has(agentSessionWrite) && !capabilities.has(agentManage))
      return;
    let transport: AppAgentTransport | undefined;
    let connection: BrowserConnection | undefined;
    const failure = () => {
      console.warn("Oyster Agent browser connection failed");
    };
    const active = {
      frame,
      close: () => {
        connection?.close();
        if (transport !== undefined) void transport.close().catch(failure);
      },
    };
    this.#active = active;
    try {
      transport = await openAppAgent(capabilities, {
        agentId: selection.agentId,
      });
      if (this.#active !== active) {
        await transport.close();
        return;
      }
      const admitted = transport;
      connection = connectBrowser({
        baseUrl: `${admitted.baseUrl}/browser/sessions/${encodeURIComponent(selection.sessionId)}`,
        whistle,
        transport: {
          fetch: admitted.fetch,
          openEvents: (url) => new EventSource(url, { fetch: admitted.fetch }),
        },
      });
      void connection.closed.catch((cause: unknown) => {
        if (this.#active === active) this.release(frame);
        console.warn(
          "Oyster Agent browser connection failed",
          cause instanceof UiBrowserError
            ? cause.message
            : "Transport unavailable",
        );
      });
    } catch (cause) {
      if (this.#active === active) this.release(frame);
      throw cause;
    }
  }
}

function agentDirectory(
  capabilities: AppHostLaunch["capabilities"],
): CapabilityDirectory {
  const directory = createCapabilityRegistry();
  const read = capabilities.find(
    ({ id, version }) =>
      id === agentSessionRead.id && version === agentSessionRead.version,
  );
  const write = capabilities.find(
    ({ id, version }) =>
      id === agentSessionWrite.id && version === agentSessionWrite.version,
  );
  const manage = capabilities.find(
    ({ id, version }) =>
      id === agentManage.id && version === agentManage.version,
  );
  if (read !== undefined)
    directory.provide(
      agentSessionRead,
      agentSessionRead.schema.parse(new RpcStub(read.handle)),
    );
  if (write !== undefined)
    directory.provide(
      agentSessionWrite,
      agentSessionWrite.schema.parse(new RpcStub(write.handle)),
    );
  if (manage !== undefined)
    directory.provide(
      agentManage,
      agentManage.schema.parse(new RpcStub(manage.handle)),
    );
  return directory;
}

/** Current server-admitted configuration for one installed App page. */
export const oysterAppConfigSchema = Schema.Struct({
  workbench: Schema.Boolean,
  /** The home shell Release's own module, imported top-level; null if it ships none. */
  shellModuleUrl: Schema.NullOr(Schema.String),
  storage: Schema.Boolean,
  /** The Release declares `apps.open`; only an embedding shell can serve it. */
  appsOpen: Schema.Boolean,
  computerId: Schema.NullOr(Schema.String),
  authorityVersion: Schema.Int,
  commands: Schema.Array(appDeclaredCommandSchema),
  icon: Schema.NullOr(Schema.String),
  roles: Schema.Array(Schema.String),
  installationId: Schema.String,
  appId: Schema.String,
  releaseId: Schema.String,
  uiUrl: Schema.String,
  backendUrl: Schema.String,
  methodsUrl: Schema.String,
  capabilities: Schema.Array(capabilityDescriptorSchema),
});

async function answer(response: Response): Promise<WhistleJsonValue> {
  if (response.status === 401 || response.status === 403)
    throw new AppError("App permission was denied", {
      code: "CAPABILITY_DENIED",
      retryable: false,
    });
  if (!response.ok)
    throw new AppError("App backend request failed", {
      code: "HOST_FAILURE",
      retryable: response.status >= 500,
    });
  return parseJsonValue(await response.json());
}

/** The App's typed methods, reached through this host's method route. */
class Methods extends RpcTarget {
  readonly #url: string;
  constructor(
    url: string,
    readonly computerTarget?: string,
  ) {
    super();
    this.#url = url;
  }
  async call(method: string, input: string): Promise<WhistleJsonValue> {
    const name = Schema.decodeUnknownSync(
      Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.]{0,79}$/u)),
    )(method);
    const body = Schema.decodeUnknownSync(Schema.String)(input);
    return answer(
      await fetch(
        computerTargetUrl(`${this.#url}${name}`, this.computerTarget),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        },
      ),
    );
  }
}

/** A member-only declared deputy; identity and approval are rechecked by the host route. */
class Calls extends RpcTarget {
  constructor(
    readonly base: string,
    readonly signal: AbortSignal,
    readonly computerTarget?: string,
  ) {
    super();
  }
  async call(
    appId: string,
    method: string,
    input: string,
  ): Promise<WhistleJsonValue> {
    const target = Schema.decodeUnknownSync(appIdSchema)(appId);
    const name = Schema.decodeUnknownSync(appApiMethodNameSchema)(method);
    const body = Schema.decodeUnknownSync(Schema.String)(input);
    if (new TextEncoder().encode(body).byteLength > 64 * 1024)
      throw new AppError("App method input is too large", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(body);
    return answer(
      await fetch(
        computerTargetUrl(
          `${this.base}${encodeURIComponent(target)}/${encodeURIComponent(name)}`,
          this.computerTarget,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: this.signal,
        },
      ),
    );
  }
}

/** Role and App opens, routed by the embedding shell; the App never names a surface. */
export type OysterAppOpenRouting = Readonly<{
  /** Open the declared intent through the App the Team chose for its role. */
  open(input: AppOpenInput): Promise<void>;
  /** Which App that role's open would reach, or null when none fills it. */
  role(role: string): Promise<AppRoleChoice>;
}>;

/** A declared `apps.open` reaches the embedding shell's own role routing. */
class AppOpen extends RpcTarget {
  constructor(readonly routing: OysterAppOpenRouting) {
    super();
  }
  open(value: AppOpenInput): Promise<void> {
    return this.routing.open(
      Schema.decodeUnknownSync(appOpenInputSchema, {
        onExcessProperty: "error",
      })(value),
    );
  }
  role(value: string): Promise<AppRoleChoice> {
    const { role } = Schema.decodeUnknownSync(appOpenInputSchema.members[0], {
      onExcessProperty: "error",
    })({ role: value, intent: { kind: "navigate", params: [] } });
    return this.routing.role(role);
  }
}

/** The App's backend, reached through this host's admitted backend route. */
class Backend extends RpcTarget {
  readonly #url: string;
  constructor(url: string) {
    super();
    this.#url = url;
  }
  async request(input: string): Promise<WhistleJsonValue> {
    const body = Schema.decodeUnknownSync(Schema.String)(input);
    const response = await fetch(this.#url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    return answer(response);
  }
}

const denied = () =>
  Promise.reject(
    new AppError("This Oyster host does not provide that action", {
      code: "CAPABILITY_DENIED",
      retryable: false,
    }),
  );

function terminalSelection(config: OysterAppConfig) {
  const descriptor = config.capabilities.find(
    (capability) =>
      capability.id === computerTerminal.id &&
      capability.version === computerTerminal.version,
  );
  const method = descriptor?.methods.open;
  return {
    computerId: config.computerId,
    terminalUrl:
      descriptor !== undefined && method?.kind === "transport"
        ? `${descriptor.base}${method.path}`
        : null,
  };
}

/** Read the server-admitted configuration this page was served with. */
export function readOysterPageConfig(): OysterAppConfig {
  const configElement = document.getElementById("oyster-config");
  if (configElement === null) throw new Error("Oyster page config is missing");
  return Schema.decodeUnknownSync(Schema.fromJsonString(oysterAppConfigSchema))(
    configElement.textContent,
  );
}

/** Apply this host's shared page styles and the person's color theme. */
export function applyOysterPageTheme(): "mocha" | "latte" {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = dark ? "mocha" : "latte";
  document.documentElement.dataset.theme = theme;
  const style = document.createElement("style");
  style.textContent = OYSTER_SHELL_STYLES;
  document.head.append(style);
  return theme;
}

/**
 * The home installation's own storage and methods, for the trusted shell the
 * host composes into this document. They reach the same admitted routes an
 * isolated App would, without a frame between the shell and its host.
 */
export function oysterShellHandles(config: OysterAppConfig) {
  return {
    storage: config.storage
      ? appStorage.schema.parse(oysterStorageHandle(config.installationId))
      : null,
    methods: appMethods.schema.parse(new Methods(config.methodsUrl)),
  };
}

/**
 * Mount one installed App's own page: its sandboxed frame and nothing else.
 * Desktop chrome (menus, palette, status) belongs to the trusted shell.
 */
export async function mountOysterPage(): Promise<AppHost> {
  const frame = document.getElementById("oyster-app");
  if (!(frame instanceof HTMLIFrameElement) || frame.contentWindow === null)
    throw new Error("Oyster App frame is missing");
  const config = readOysterPageConfig();
  const lifetime = createPageLifetime(window);
  const theme = applyOysterPageTheme();
  // The App's commands are still admitted against its Release declaration.
  const commands = createAppSurfaceCommandHost();
  const mount = commands.mount(config.installationId, config.commands);
  const agentBrowser = new OysterAgentBrowserHost(lifetime.signal);
  lifetime.own(() => {
    commands.dispose();
  });
  return connectOysterApp({
    config,
    agentBrowser,
    agentCommands: mount.agentCommands,
    frame,
    signal: lifetime.signal,
    reservedChords: [],
    theme,
    handlers: {
      ...mount.handlers,
      reportStatus: () => Promise.resolve(),
      openNavigation: denied,
      reportFocus: () => Promise.resolve(),
      reportAgentSessionSelection: () => Promise.resolve(),
      showToast: () => Promise.resolve(),
      onDisconnect: () => {
        lifetime.dispose();
        return Promise.resolve();
      },
    },
  });
}

/** The host-admitted App configuration served by Oyster. */
export type OysterAppConfig = typeof oysterAppConfigSchema.Type;
/** One isolated App connection, with the slots this host admitted for it. */
export type OysterAppConnectionOptions = Readonly<{
  config: OysterAppConfig;
  /** The page-wide selected Session owner shared by all child mounts. */
  agentBrowser: OysterAgentBrowserHost;
  /** The existing command owner's live, mount-scoped Agent view. */
  agentCommands: Pick<WhistleRuntime, "snapshot" | "execute">;
  /** An independently admitted per-window target; absent on fixed/default hosts. */
  computerTarget?: string | undefined;
  frame: HTMLIFrameElement;
  signal: AbortSignal;
  handlers: AppHostHandlers;
  /** Present only where a shell can route opens; used when the Release declares `apps.open`. */
  appOpen?: OysterAppOpenRouting;
  openRequest?: AppHostLaunch["context"]["value"]["openRequest"];
  surfaceId?: string;
  reservedChords: readonly import("@fungi.computer/agar/host").AppHostReservedChord[];
  theme: string;
}>;
/** Connect a child or home App using the same admitted Oyster slot handles. */
export async function connectOysterApp(
  options: OysterAppConnectionOptions,
): Promise<AppHost> {
  const { config, frame } = options;
  if (frame.contentWindow === null) throw new Error("App frame is unavailable");
  const capabilities = await oysterAppCapabilities(options);
  const agents = agentDirectory(capabilities);
  const releaseBrowser = () => {
    options.agentBrowser.release(frame);
  };
  options.signal.addEventListener("abort", releaseBrowser, { once: true });
  const host = await connectAppHost({
    appWindow: frame.contentWindow,
    expectedAppOrigin: "null",
    hostWindow: window,
    signal: options.signal,
    launch: {
      identity: {
        appId: config.appId,
        releaseId: config.releaseId,
        surfaceId: options.surfaceId ?? config.installationId,
      },
      capabilities,
      context: {
        version: 1,
        value: {
          computerId: config.computerId,
          focus: { editing: false, surface: null },
          openRequest: options.openRequest ?? null,
          visibility: "visible",
        },
      },
      lifecycle: { version: 1, value: "connected" },
      reservedChords: { version: 0, value: options.reservedChords },
      theme: { version: 1, value: options.theme },
    },
    handlers: {
      ...options.handlers,
      reportAgentSessionSelection: async (selection) => {
        await options.agentBrowser.report(
          frame,
          selection,
          agents,
          options.agentCommands,
        );
        await options.handlers.reportAgentSessionSelection(selection);
      },
      onDisconnect: async () => {
        releaseBrowser();
        await options.handlers.onDisconnect();
      },
      requestBrowserAction: createBrowserActionHandler({
        frame,
        hostWindow: window,
        signal: options.signal,
      }),
    },
  });
  if (options.signal.aborted) host.dispose();
  else
    options.signal.addEventListener(
      "abort",
      () => {
        host.dispose();
      },
      { once: true },
    );
  return host;
}

export { oysterStorageHandle } from "./storage.js";
export { appSandbox } from "../app-sandbox.js";

/** Resolve only the slots admitted for this installation by its current host. */
export async function oysterAppCapabilities(
  options: Pick<
    OysterAppConnectionOptions,
    "config" | "signal" | "appOpen" | "computerTarget"
  >,
): Promise<AppHostLaunch["capabilities"]> {
  const { config } = options;
  const contracts: readonly CapabilityRegistration[] = [
    { contract: computerList },
    {
      contract: computerPorts,
      createHandle: (call) => new ComputerPortsHandle(call),
    },
    {
      contract: computerProcesses,
      createHandle: (call) => new ComputerProcessesHandle(call),
    },
    { contract: computerReadFile },
    { contract: computerWriteFile },
    {
      contract: computerTerminal,
      createHandle: (_call, transport) => {
        const selected = terminalSelection(config);
        if (selected.terminalUrl === null)
          throw new AppError("Computer terminal is unavailable", {
            code: "CAPABILITY_DENIED",
            retryable: false,
          });
        let leaseExpiresAt = 0;
        return new TerminalCapability((input) => transport("open", input), {
          computerId: config.computerId,
          terminalUrl: computerTargetUrl(
            selected.terminalUrl,
            options.computerTarget,
          ),
          hostWindow: window,
          mountSignal: options.signal,
          ensureAccess: Object.assign(
            async (signal: AbortSignal) => {
              const response = await fetch(
                computerTargetUrl(
                  `/apps/${encodeURIComponent(config.installationId)}/`,
                  options.computerTarget,
                ),
                {
                  headers: { Accept: "application/json" },
                  credentials: "same-origin",
                  cache: "no-store",
                  redirect: "error",
                  signal,
                },
              );
              const current = Schema.decodeUnknownSync(oysterAppConfigSchema)(
                await answer(response),
              );
              if (
                current.installationId !== config.installationId ||
                current.releaseId !== config.releaseId ||
                current.authorityVersion !== config.authorityVersion
              )
                throw new AppError("App admission changed. Reopen the App.", {
                  code: "CAPABILITY_DENIED",
                  retryable: false,
                });
              leaseExpiresAt = Date.now() + 60_000;
              const selected = terminalSelection(current);
              return {
                ...selected,
                terminalUrl:
                  selected.terminalUrl === null
                    ? null
                    : computerTargetUrl(
                        selected.terminalUrl,
                        options.computerTarget,
                      ),
              };
            },
            { leaseExpiresAt: () => leaseExpiresAt },
          ),
        });
      },
    },
    { contract: approvals },
    { contract: agentList },
    { contract: agentManage },
    { contract: agentSessionRead },
    { contract: agentSessionWrite },
    {
      contract: mediaGeneration,
      createHandle: async (call) => {
        const description = Schema.decodeUnknownSync(
          mediaGenerationDescriptionSchema,
          {
            onExcessProperty: "error",
          },
        )(await call("describe"));
        return new MediaGeneration(call, description.computerId);
      },
    },
  ];
  const unknownCapabilities: string[] = [];
  const capabilities = await Promise.all(
    config.capabilities.flatMap(
      (descriptor): Promise<AppHostLaunch["capabilities"][number]>[] => {
        if (
          descriptor.id === appsCall.id &&
          descriptor.version === appsCall.version
        ) {
          const base = `/apps/${encodeURIComponent(config.installationId)}/calls/`;
          if (descriptor.base !== base)
            throw new AppError(
              "App call route does not match this installation",
              {
                code: "PROTOCOL",
                retryable: false,
              },
            );
          return [
            Promise.resolve({
              ...appsCall,
              handle: new Calls(base, options.signal, options.computerTarget),
            }),
          ];
        }
        const registration = contracts.find(
          ({ contract }) =>
            contract.id === descriptor.id &&
            contract.version === descriptor.version,
        );
        if (registration === undefined) {
          unknownCapabilities.push(
            `${descriptor.id}@${String(descriptor.version)}`,
          );
          return [];
        }
        return [
          registeredCapabilityHandle(
            registration,
            descriptor,
            config.installationId,
            options.computerTarget,
          ).then((handle) => ({ ...registration.contract, handle })),
        ];
      },
    ),
  );
  if (unknownCapabilities.length > 0)
    document.body.dataset.oysterCapability = unknownCapabilities.join(", ");
  const resolved: AppHostLaunch["capabilities"][number][] = [
    {
      ...appBackend,
      handle: new Backend(
        computerTargetUrl(config.backendUrl, options.computerTarget),
      ),
    },
    {
      ...appMethods,
      handle: new Methods(config.methodsUrl, options.computerTarget),
    },
    ...capabilities,
    ...(config.appsOpen && options.appOpen
      ? [{ ...appsOpen, handle: new AppOpen(options.appOpen) }]
      : []),
  ];
  if (config.storage)
    resolved.push({
      ...appStorage,
      handle: oysterStorageHandle(config.installationId),
    });
  return resolved;
}
