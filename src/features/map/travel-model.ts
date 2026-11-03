/**
 * Travel paces are a campaign setting, stored in `campaign.json` under
 * `travel`:
 *
 *   travel:
 *     hoursPerDay: 8
 *     paces: [{ id, label, perDay }]
 *
 * `perDay` is the distance covered in one travelling day, in whatever unit
 * the maps' scales use (miles, km, leagues). The paces are shared by every
 * map in the campaign; the unit is per map.
 */
import type { CampaignMeta } from "@/lib/types";

export interface TravelPace {
  id: string;
  label: string;
  /** Distance covered in one travelling day, in the map's unit. */
  perDay: number;
}

export interface TravelSettings {
  /** Hours on the move in one travelling day; used for sub-day estimates. */
  hoursPerDay: number;
  paces: TravelPace[];
}

/**
 * Typical overland paces for a full travelling day (about eight hours). Based
 * on common fantasy-RPG conventions; good enough for planning, not simulation.
 */
export const DEFAULT_TRAVEL: TravelSettings = {
  hoursPerDay: 8,
  paces: [
    { id: "foot", label: "On foot", perDay: 24 },
    { id: "horse", label: "On horseback", perDay: 40 },
    { id: "wagon", label: "By wagon", perDay: 16 },
  ],
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readTravel(campaign: Record<string, unknown>): TravelSettings {
  const raw =
    campaign.travel && typeof campaign.travel === "object"
      ? (campaign.travel as Record<string, unknown>)
      : null;
  if (!raw) return DEFAULT_TRAVEL;

  const paces: TravelPace[] = Array.isArray(raw.paces)
    ? raw.paces.flatMap((p, i) => {
        if (!p || typeof p !== "object") return [];
        const o = p as Record<string, unknown>;
        const perDay = num(o.perDay);
        if (perDay === null || perDay <= 0) return [];
        return [
          {
            id: typeof o.id === "string" && o.id ? o.id : `pace-${i}`,
            label: typeof o.label === "string" ? o.label : "",
            perDay,
          },
        ];
      })
    : [];
  const hours = num(raw.hoursPerDay);
  return {
    hoursPerDay:
      hours !== null && hours > 0 && hours <= 24
        ? hours
        : DEFAULT_TRAVEL.hoursPerDay,
    // An empty list is a valid choice: the GM turned travel estimates off.
    paces: Array.isArray(raw.paces) ? paces : DEFAULT_TRAVEL.paces,
  };
}

export function travelOf(campaign: CampaignMeta | null): TravelSettings {
  return campaign ? readTravel(campaign) : DEFAULT_TRAVEL;
}

export function newPaceId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** "On foot" → "foot", "By wagon" → "wagon", for tight table cells. */
export function shortPaceLabel(label: string): string {
  return label.replace(/^(on|by)\s+/i, "") || "pace";
}

/** "3 h", "1.5 days", "12 days" */
export function formatTravelTime(
  distance: number,
  perDay: number,
  hoursPerDay: number,
): string {
  if (perDay <= 0) return "—";
  const days = distance / perDay;
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * hoursPerDay));
    return `${hours} h`;
  }
  const rounded = days >= 10 ? Math.round(days) : Math.round(days * 2) / 2;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}
