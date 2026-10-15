import type { WhistleCommand } from "@fungi.computer/whistle";

/** The Back binding, also shown by the shell in window chrome. */
export const backBinding = "<leader> [";

/** The behavior supplied by either a browser or terminal workspace shell. */
export type ShellActions = Readonly<{
  /** Show the host-owned App picker. */
  openApp: () => void;
  /** Show the active command and key reference. */
  showKeys: () => void;
  /** Show the focused window command search. */
  showCommandLine: () => void;
  /** Move focus to the previous or next window. */
  focusStep: (step: -1 | 1) => void;
  /** Swap the focused window with its previous or next neighbor. */
  swapStep: (step: -1 | 1) => void;
  /** Toggle the focused window between normal and zoomed presentation. */
  toggleZoom: () => void;
  /** Ask the focused view to go back in its own history. */
  back?: () => void;
}>;

/**
 * Shared workspace declarations. Window moves have direct Alt chords and
 * leader keys; global actions live behind the shell-owned leader.
 */
export function shellCommands(
  actions: ShellActions,
): readonly WhistleCommand<never>[] {
  const windowCommand = (
    id: string,
    title: string,
    keys: readonly string[],
    order: number,
    run: () => void,
  ): WhistleCommand<never> => ({
    id,
    title,
    category: "Window",
    projections: {
      bindings: { values: keys, order },
      palette: { order: 10 + order },
      help: { order },
    },
    handler: () => {
      run();
    },
  });
  return [
    {
      id: "open-app",
      title: "Open App",
      category: "Apps",
      description: "Show available Apps.",
      projections: {
        bindings: { values: ["<leader> o"], order: 0 },
        palette: { order: 0 },
      },
      handler: () => {
        actions.openApp();
      },
    },
    {
      id: "show-command-palette",
      title: "Show keys",
      category: "System",
      description: "Show the keys and commands available here.",
      projections: { bindings: { values: ["mod+k"], order: 0 } },
      handler: () => {
        actions.showKeys();
      },
    },
    {
      id: "command-line",
      title: "Command line",
      category: "System",
      description: "Search the focused window's commands.",
      projections: { bindings: { values: ["<leader> :"], order: 1 } },
      handler: () => {
        actions.showCommandLine();
      },
    },
    windowCommand(
      "focus-previous",
      "Focus previous window",
      ["alt+left", "<leader> h"],
      2,
      () => {
        actions.focusStep(-1);
      },
    ),
    windowCommand(
      "focus-next",
      "Focus next window",
      ["alt+right", "<leader> l"],
      3,
      () => {
        actions.focusStep(1);
      },
    ),
    windowCommand(
      "swap-previous",
      "Swap window left",
      ["alt+shift+left", "<leader> {"],
      4,
      () => {
        actions.swapStep(-1);
      },
    ),
    windowCommand(
      "swap-next",
      "Swap window right",
      ["alt+shift+right", "<leader> }"],
      5,
      () => {
        actions.swapStep(1);
      },
    ),
    windowCommand("zoom", "Zoom window", ["alt+enter", "<leader> z"], 6, () => {
      actions.toggleZoom();
    }),
    // Alt+Left focuses the previous window. The leader crosses App iframes;
    // Cmd+[ is the Mac browser Back chord while the shell has focus.
    ...(actions.back === undefined
      ? []
      : [
          windowCommand(
            "back",
            "Back",
            [backBinding, "cmd+["],
            7,
            actions.back,
          ),
        ]),
  ];
}
