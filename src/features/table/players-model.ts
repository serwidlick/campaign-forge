/**
 * The campaign's players and their paired devices, as stored in
 * `campaign.json` under `players` (see `src-tauri/src/table/players.rs`).
 * Audiences and sheet owners point at a player's stable `id`.
 */
import type { CampaignMeta, PlayerRecord } from "@/lib/types";

export function playersOf(campaign: CampaignMeta | null): PlayerRecord[] {
  const raw = campaign?.players;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const o = p as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") return [];
    const devices = Array.isArray(o.devices)
      ? o.devices.flatMap((d) => {
          if (!d || typeof d !== "object") return [];
          const x = d as Record<string, unknown>;
          if (typeof x.fingerprint !== "string") return [];
          return [
            {
              fingerprint: x.fingerprint,
              publicKey: typeof x.publicKey === "string" ? x.publicKey : "",
              label: typeof x.label === "string" ? x.label : "",
              addedAt: typeof x.addedAt === "string" ? x.addedAt : "",
            },
          ];
        })
      : [];
    return [
      {
        id: o.id,
        name: o.name,
        devices,
        lastSeen: typeof o.lastSeen === "string" ? o.lastSeen : null,
      },
    ];
  });
}

export function playerName(players: PlayerRecord[], id: string): string {
  return players.find((p) => p.id === id)?.name ?? "Unknown player";
}

/** The `audience` list on an element: player ids, empty for everyone. */
export function audienceOf(element: Record<string, unknown>): string[] {
  return Array.isArray(element.audience)
    ? element.audience.filter((a): a is string => typeof a === "string")
    : [];
}

/** "ab12-cd34-…", enough to tell devices apart by eye. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.split("-").slice(0, 2).join("-") + "…";
}
