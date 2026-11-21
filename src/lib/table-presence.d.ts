import type { RosterEntry, TableChange, TableCommand } from "./types";

export const TAG: "table-presence";

/** The floating, draggable "who is at the table" bubbles. */
export class TablePresence extends HTMLElement {
  /** Everyone at the table, host first. Names are only ever set as text. */
  roster: RosterEntry[];
  /** How far this device's clock is ahead of the host's, in ms. */
  clockOffset: number;
  /** The roster key of the person at this device: their bubble is marked
   *  "you" and never folded into "+N". */
  you: string | null;
  /** True while this device cannot reach the host: the host shows as
   *  disconnected, everyone else as last seen. Only changes act. */
  offline: boolean;
  /** Plays an activity (see `defineActivity`) on someone's bubble; `null`
   *  stops it. */
  setActivity(key: string, activity: string | null): void;
  /** Hands a card section its state (`TableChat` does this for messages). */
  setSectionState(id: string, value: unknown): void;
  /** Unread messages by person key, and in all. */
  setUnread(per: Record<string, number>, total?: number): void;
  /** Messages arrived live from `from`: an envelope travels to your bubble
   *  unless their card is open. */
  messageArrived(from: string, count?: number): void;
  /** Opens someone's card, as pressing their bubble does. */
  openCard(key: string): void;
  closeCard(): void;
}

/**
 * Table messages for a page: conversation state, resends, Seen and unread,
 * and the card's events. Lives with the connection; attach it to the
 * bubbles whenever they exist.
 */
export class TableChat {
  constructor(options: {
    /** Hands one command to the table: true/false for went out or not, or
     *  a promise of that, or of the ack for a send. */
    send: (command: TableCommand) => unknown;
    now?: () => number;
  });
  /** This device's person, when the frames do not say ("host" hosting). */
  you: string | null;
  /** Every frame from the table. */
  receive(frame: Partial<TableChange> | null | undefined): void;
  /** The socket dropped (false) or a new one is up (true). */
  connected(on: boolean): void;
  sendMessage(to: string, text: string): string | null;
  attach(element: TablePresence | null): void;
  detach(): void;
  dispose(): void;
}

/** Context card sections and actions are given. */
export interface CardContext {
  you: string | null;
  me: RosterEntry | null;
  now: number;
  offset: number;
  state(id: string): unknown;
}

export interface CardApi {
  emit(name: string, detail?: Record<string, unknown>): void;
  state(id: string): unknown;
  announce(text: string): void;
  signal: AbortSignal | null;
}

/** Adds or replaces a section of the person card. */
export function defineCardSection<H = unknown>(
  id: string,
  def: {
    order?: number;
    when?: (
      entry: RosterEntry & { self?: boolean },
      ctx: CardContext,
    ) => boolean;
    mount: (root: HTMLElement, entry: RosterEntry, api: CardApi) => H;
    update?: (handle: H, entry: RosterEntry, ctx: CardContext) => void;
    unmount?: (handle: H) => void;
  },
): void;

/** Adds or replaces a button in the person card's header. */
export function defineCardAction(
  id: string,
  def: {
    label: string;
    icon?: string | null;
    when?: (entry: RosterEntry, ctx: CardContext) => boolean;
    run: (entry: RosterEntry, api: CardApi) => void;
  },
): void;

/** Registers `<table-presence>` once; safe to call more than once. */
export function defineTablePresence(): void;

/** Adds the presence bubbles to the page and returns the element; set `.roster` to fill it. */
export function mountTablePresence(options?: {
  /** URL of table-presence.css, loaded into the element's shadow root. */
  stylesheet?: string;
  parent?: HTMLElement;
}): TablePresence;

/** Context for words that depend on time: this clock and its lead on the host's. */
export interface StatusContext {
  now: number;
  offset: number;
}

export interface StatusDefinition {
  /** A short word for the status. */
  label?: string;
  /** A face style from the stylesheet: "idle" or "gone", or your own. */
  face?: string;
  /** The corner badge: a dot or an icon, in a tone ("here", "muted", "off"). */
  badge?: { dot?: boolean; icon?: string; tone?: string } | null;
  /** Words after the person's name, e.g. "away for 7 min". */
  detail?: (entry: RosterEntry, ctx: StatusContext) => string;
  /** The badge's own hover tip, if any. */
  badgeTip?: ((entry: RosterEntry, ctx: StatusContext) => string) | null;
  /** True when `detail` changes with time, so it is refreshed. */
  ticks?: boolean;
}

/** Adds or replaces how a roster state looks and reads. */
export function defineStatus(id: string, def: StatusDefinition): void;
export function statusOf(id: string): Required<StatusDefinition>;

export interface ActivityDefinition {
  /** Added to the person's name while running, e.g. "sending a message". */
  label?: string;
  /** An icon name for the badge, top right. */
  badge?: string | null;
  /** What moves: the face (default) or the whole bubble. */
  target?: "face" | "bubble";
  /** Web Animations keyframes, or a function of where the bubbles are
   *  docked (`inward` points towards the middle of the screen). */
  keyframes:
    | Keyframe[]
    | ((ctx: { side: string; inward: { x: number; y: number } }) => Keyframe[]);
  /** Duration, iterations (Infinity loops until stopped), easing, ... */
  options?: KeyframeAnimationOptions;
  /** A buzz (see `defineHaptic`) when it starts on your own bubble. */
  haptic?: string | null;
}

/** Adds or replaces an activity bubbles can play. */
export function defineActivity(id: string, def: ActivityDefinition): void;
export function activityOf(id: string): ActivityDefinition | null;

/** Adds an icon by name: SVG path data on a 24×24 grid. */
export function defineIcon(name: string, paths: string[]): void;

/** How long without input counts as away: five minutes. */
export const IDLE_AFTER: number;

/** Calls `onChange(true)` after `timeout` without input, `onChange(false)`
 *  on the next input. Returns a function that stops watching. */
export function watchIdle(options: {
  onChange: (idle: boolean) => void;
  timeout?: number;
  target?: EventTarget;
}): () => void;

/** "just now", "7 min", "2 h 5 min", "3 days". */
export function formatDuration(ms: number): string;

/** Adds or replaces a kind of buzz: a vibration pattern in ms. Built in:
 *  "pick", "snap", "tap", "notice", "warn". */
export function defineHaptic(kind: string, pattern: number | number[]): void;
/** Buzzes for `kind` if it is known and haptics are on. Never throws. */
export function haptic(kind: string): boolean;
/** Replaces how a buzz is made (say, a native bridge); `null` restores the
 *  Vibration API. */
export function setHapticDriver(
  driver: ((kind: string, pattern: number[]) => void) | null,
): void;
export function setHapticsEnabled(on: boolean): void;
