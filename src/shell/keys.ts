import type {
  WhistleBindingProjection,
  WhistleExecutionInput,
  WhistleExecutionOutcome,
  WhistleSnapshot,
} from "@fungi.computer/whistle";

/**
 * Single-chord and leader binding dispatch for the shell document. App frames
 * own their local key dispatch; reserved shell chords cross through the host.
 */

/** Whistle binding prefix for a key pressed after the leader chord. */
const leaderPrefix = "<leader> ";

/** One physical chord parsed from a Whistle binding such as `alt+left`. */
export type ShellChord = Readonly<{
  key: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}>;

/** Keyboard facts shared by DOM events and terminal adapters. */
export type KeyEventFacts = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

const keyNames = new Map([
  ["arrowleft", "left"],
  ["arrowright", "right"],
  ["arrowup", "up"],
  ["arrowdown", "down"],
  ["esc", "escape"],
  [" ", "space"],
]);

/** Normalize a DOM key or binding key name to the binding vocabulary. */
function keyName(key: string): string {
  const lower = key.toLowerCase();
  return keyNames.get(lower) ?? lower;
}

/**
 * Parse one single-chord binding. Sequences (including `<leader> x`) and
 * unknown modifiers return `null`; they are never matched as one chord.
 */
export function parseChord(binding: string, mac: boolean): ShellChord | null {
  if (binding.trim().includes(" ")) return null;
  const parts = binding.toLowerCase().split("+");
  const key = parts.pop();
  if (key === undefined || key.length === 0) return null;
  const chord = {
    key: keyName(key),
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
  };
  for (const modifier of parts) {
    if (modifier === "alt" || modifier === "option") chord.alt = true;
    else if (modifier === "ctrl" || modifier === "control") chord.ctrl = true;
    else if (modifier === "super" || modifier === "meta" || modifier === "cmd")
      chord.meta = true;
    else if (modifier === "shift") chord.shift = true;
    else if (modifier === "mod") {
      if (mac) chord.meta = true;
      else chord.ctrl = true;
    } else return null;
  }
  return chord;
}

/** Whether one key event is exactly this chord. */
export function chordMatches(event: KeyEventFacts, chord: ShellChord): boolean {
  return (
    keyName(event.key) === chord.key &&
    event.altKey === chord.alt &&
    event.ctrlKey === chord.ctrl &&
    event.metaKey === chord.meta &&
    event.shiftKey === chord.shift
  );
}

/** One key offered after the leader chord, with the command it runs. */
export type LeaderKey = WhistleBindingProjection & Readonly<{ key: string }>;

/** The `<leader> x` rows of the active view, first binding per key. */
export function leaderKeys(active: WhistleSnapshot): readonly LeaderKey[] {
  const seen = new Set<string>();
  const rows: LeaderKey[] = [];
  for (const row of active.bindings) {
    if (!row.binding.startsWith(leaderPrefix)) continue;
    const key = row.binding.slice(leaderPrefix.length).trim();
    if (key.length === 0 || key.includes(" ") || seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, key });
  }
  return rows;
}

/** Whether one key event (after the leader) selects this leader key. */
export function leaderKeyMatches(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
  key: string,
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === key || keyName(event.key) === key;
}

/** The shell host operations the key dispatcher reads. */
export type ShellKeyHost = Readonly<{
  /** Read the commands currently available to the focused view. */
  active: () => WhistleSnapshot;
  /** Observe command changes; call the returned disposer to stop listening. */
  subscribe: (listener: () => void) => () => void;
  /** Run a command through the host with the original input origin. */
  execute: (
    commandId: string,
    input: WhistleExecutionInput,
  ) => Promise<WhistleExecutionOutcome>;
}>;

/** Whether the event started in text entry, including inside shadow roots. */
function isEditing(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof HTMLElement &&
        (node.isContentEditable ||
          node.getAttribute("contenteditable") === "true" ||
          node.matches("input, textarea, select")),
    );
}

/**
 * Dispatch the active view's single-chord bindings from the shell document.
 * Text entry is a mode: while an input is focused only Ctrl/Cmd chords fire,
 * so Alt-arrows keep their word-navigation meaning.
 */
export function installShellKeys(
  root: HTMLElement,
  host: ShellKeyHost,
  mac: boolean,
): () => void {
  let chords: readonly Readonly<{ commandId: string; chord: ShellChord }>[] =
    [];
  const refresh = (): void => {
    chords = host.active().bindings.flatMap(({ binding, commandId }) => {
      const chord = parseChord(binding, mac);
      return chord === null ? [] : [{ commandId, chord }];
    });
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const editing = isEditing(event);
    const match = chords.find(
      ({ chord }) =>
        chordMatches(event, chord) && (!editing || chord.ctrl || chord.meta),
    );
    if (match === undefined) return;
    event.preventDefault();
    void host
      .execute(match.commandId, { origin: "keyboard" })
      .catch((cause: unknown) => {
        console.warn("Shell key command failed", cause);
      });
  };
  refresh();
  const unsubscribe = host.subscribe(refresh);
  root.addEventListener("keydown", onKeyDown, { capture: true });
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe();
    root.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}
