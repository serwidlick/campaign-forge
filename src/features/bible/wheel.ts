import {
  Dices,
  Flag,
  Gem,
  MapPin,
  Scroll,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * One spoke of the wheel. The wheel groups kinds a little differently from
 * the sidebar families so it has six balanced nodes, like a campaign's six
 * concerns: who is playing, who they meet, who holds power, where, what, and
 * what happens.
 */
export interface WheelNode {
  id: string;
  label: string;
  kinds: string[];
  icon: LucideIcon;
  /** Ring/accent colour. */
  color: string;
}

export const WHEEL: WheelNode[] = [
  {
    id: "play",
    label: "Play",
    kinds: ["arc", "session", "journal"],
    icon: Dices,
    color: "#e69a57",
  },
  {
    id: "people",
    label: "People",
    kinds: ["character", "creature"],
    icon: Users,
    color: "#f9a8d4",
  },
  {
    id: "factions",
    label: "Factions",
    kinds: ["faction"],
    icon: Flag,
    color: "#fde68a",
  },
  {
    id: "places",
    label: "Places",
    kinds: ["location", "map"],
    icon: MapPin,
    color: "#86efac",
  },
  {
    id: "things",
    label: "Things",
    kinds: ["item"],
    icon: Gem,
    color: "#c4b5fd",
  },
  {
    id: "story",
    label: "Story",
    kinds: ["quest", "event", "lore"],
    icon: Scroll,
    color: "#7dd3fc",
  },
];

/** The spoke a kind belongs to; unknown kinds fall under Story. */
export function spokeForKind(kind: string): WheelNode {
  return WHEEL.find((n) => n.kinds.includes(kind)) ?? WHEEL[WHEEL.length - 1]!;
}
