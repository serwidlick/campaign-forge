/**
 * The game a campaign is played with. Stored in `campaign.json` as `rules`
 * and chosen when the campaign is created. It decides which templates new
 * elements start from and which structured panels appear (a D&D 5e character
 * gets a character sheet, for instance).
 */
import type { CampaignMeta } from "@/lib/types";

export type RulesId = "dnd5e" | "generic";

export interface Ruleset {
  id: RulesId;
  label: string;
  /** Default text for the campaign's `system` label. */
  system: string;
  blurb: string;
}

export const RULESETS: Ruleset[] = [
  {
    id: "dnd5e",
    label: "Dungeons & Dragons 5e",
    system: "D&D 5e",
    blurb:
      "Characters get a 5e sheet: class, level, abilities, AC, hit points, saves and skills.",
  },
  {
    id: "generic",
    label: "Another game",
    system: "",
    blurb: "Plain templates with no system-specific fields.",
  },
];

export const DEFAULT_RULES: RulesId = "dnd5e";

export function rulesetById(id: string): Ruleset {
  return RULESETS.find((r) => r.id === id) ?? RULESETS[0]!;
}

/** The campaign's ruleset; campaigns made before this setting are 5e. */
export function rulesOf(campaign: CampaignMeta | null): RulesId {
  const raw = campaign?.rules;
  return RULESETS.some((r) => r.id === raw) ? (raw as RulesId) : DEFAULT_RULES;
}
