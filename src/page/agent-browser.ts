import type {
  AgentSessionSelection,
  CapabilityDirectory,
} from "@fungi.computer/agar";
import {
  agentManage,
  agentSessionWrite,
  openAppAgent,
  type AppAgentTransport,
} from "@fungi.computer/agar/agents";
import { correlationKey, type CorrelationKey } from "@fungi.computer/cairn";
import {
  connectBrowser,
  UiBrowserError,
  type BrowserConnection,
} from "@fungi.computer/knapsack/ui/browser";
import {
  sameWhistleCommand,
  type WhistleCommandKey,
  type WhistleExecutionOutcome,
  type WhistleRuntime,
  type WhistleSnapshot,
} from "@fungi.computer/whistle";
import { EventSource } from "eventsource";

type AgentCommands = Pick<WhistleRuntime, "snapshot" | "execute">;
type WindowCommands = Readonly<{
  id: CorrelationKey;
  commands: AgentCommands;
}>;
type Selection = Readonly<{
  frame: HTMLIFrameElement;
  close: () => void;
}>;
const detachedOutcome: WhistleExecutionOutcome = {
  status: "failed",
  error: {
    code: "window_command_detached",
    message:
      "The window or selected Session closed after dispatch; completion is unknown",
  },
};

function windowCommand(
  window: WindowCommands,
  command: WhistleCommandKey,
): WhistleCommandKey {
  return { namespace: `${command.namespace}@${window.id}`, id: command.id };
}

/** One admitted page's live windows and selected Agent Session, never a global catalog. */
export class OysterAgentBrowserHost {
  readonly #windows = new Map<HTMLIFrameElement, WindowCommands>();
  #active: Selection | undefined;
  #disposed = false;

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

  /** Borrow a Release-validated window view only for this exact frame lifetime. */
  mount(
    frame: HTMLIFrameElement,
    commands: Pick<WhistleRuntime, "snapshot" | "execute">,
  ): () => void {
    if (this.#disposed) return () => undefined;
    if (this.#windows.has(frame))
      throw new Error("Agent command window is already mounted");
    const window = { id: correlationKey(), commands };
    this.#windows.set(frame, window);
    return () => {
      if (this.#windows.get(frame) !== window) return;
      this.#windows.delete(frame);
      this.release(frame);
    };
  }

  /** A departing or deselecting window cannot close a different selection. */
  release(frame: HTMLIFrameElement): void {
    if (this.#active?.frame !== frame) return;
    const previous = this.#active;
    this.#active = undefined;
    previous.close();
  }

  /** Release this page's window registrations and selected Agent connection. */
  dispose(): void {
    this.#disposed = true;
    this.#windows.clear();
    if (this.#active !== undefined) this.release(this.#active.frame);
  }

  #commands(selection: Selection): AgentCommands {
    const live = () => this.#active === selection && !this.#disposed;
    return {
      snapshot: (): WhistleSnapshot => ({
        bindings: [],
        palette: [],
        slash: [],
        help: [],
        menu: [],
        agent: live()
          ? [...this.#windows.values()].flatMap((window) =>
              window.commands.snapshot().agent.map((row) => ({
                ...row,
                command: windowCommand(window, row.command),
              })),
            )
          : [],
      }),
      execute: async (command, input) => {
        if (!live() || input.origin !== "agent") return { status: "missing" };
        for (const [frame, window] of this.#windows) {
          const row = window.commands
            .snapshot()
            .agent.find((row) =>
              sameWhistleCommand(windowCommand(window, row.command), command),
            );
          if (row === undefined) continue;
          // The mounted view remains the execution owner: it checks the live
          // Agent projection and invokes only this frame's Agar connection.
          const attached = () => live() && this.#windows.get(frame) === window;
          try {
            const outcome = await window.commands.execute(row.command, input);
            // Closing does not promise to undo an already dispatched effect,
            // but its old result must never settle as a replacement window's.
            return attached() ? outcome : detachedOutcome;
          } catch (cause) {
            if (!attached()) return detachedOutcome;
            throw cause;
          }
        }
        return { status: "missing" };
      },
    };
  }

  /** Admit the selected Agent through the reporting App's existing write door. */
  async report(
    frame: HTMLIFrameElement,
    selection: AgentSessionSelection | null,
    capabilities: CapabilityDirectory,
  ): Promise<void> {
    if (this.#disposed || !this.#windows.has(frame)) return;
    // A read-only Session handle cannot open or displace this connection.
    // The server re-admits the principal on every transport request.
    if (!capabilities.has(agentSessionWrite) && !capabilities.has(agentManage))
      return;
    if (selection === null) {
      this.release(frame);
      return;
    }
    if (this.#active !== undefined) this.release(this.#active.frame);
    let transport: AppAgentTransport | undefined;
    let connection: BrowserConnection | undefined;
    const failure = () => {
      console.warn("Oyster Agent browser connection failed");
    };
    const active: Selection = {
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
        whistle: this.#commands(active),
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
