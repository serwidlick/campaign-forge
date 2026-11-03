/**
 * What a new element starts with, per ruleset and kind: a body skeleton of
 * headings and any structured fields. Every template ends with a
 * "Players know" heading so a freshly shared element reveals nothing until
 * something is written there on purpose.
 */
import { EMPTY_SHEET } from "./dnd5e-model";
import type { RulesId } from "./rulesets";

export interface ElementTemplate {
  body: string;
  extra: Record<string, unknown>;
}

const NONE: ElementTemplate = { body: "", extra: {} };

function body(...sections: string[]): string {
  return sections.map((s) => `## ${s}\n\n`).join("\n");
}

const PLAYERS = "Players know";

const GENERIC: Record<string, ElementTemplate> = {
  character: {
    body: body("Appearance", "Personality", "Backstory", "Notes", PLAYERS),
    extra: {},
  },
  creature: {
    body: body("Description", "Abilities", "Behaviour", "Lore", PLAYERS),
    extra: {},
  },
  location: {
    body: body("Overview", "Notable people", "Places within", "Hooks", PLAYERS),
    extra: {},
  },
  faction: {
    body: body(
      "Goals",
      "Leaders and members",
      "Resources",
      "Relationships",
      PLAYERS,
    ),
    extra: {},
  },
  item: {
    body: body("Description", "Properties", "History", PLAYERS),
    extra: {},
  },
  quest: {
    body: body(
      "Hook",
      "Objectives",
      "Complications",
      "Rewards",
      "Resolution",
      PLAYERS,
    ),
    extra: {},
  },
  lore: { body: body("Summary", "Details", PLAYERS), extra: {} },
  event: { body: body("What happened", "Consequences", PLAYERS), extra: {} },
  session: { body: body("Recap", "Notes", "Loot and rewards"), extra: {} },
  arc: {
    body: body("Premise", "Stakes", "Key players", "How it could end"),
    extra: {},
  },
};

const DND5E: Record<string, ElementTemplate> = {
  ...GENERIC,
  character: {
    body: body("Appearance", "Personality", "Backstory", "Notes", PLAYERS),
    extra: { sheet: EMPTY_SHEET },
  },
  creature: {
    body:
      "## Stat block\n\n| | |\n| --- | --- |\n| Armour Class | |\n| Hit Points | |\n| Speed | 30 ft. |\n| Challenge | |\n\n" +
      body("Traits", "Actions", "Lore", PLAYERS),
    extra: {},
  },
  item: {
    body:
      "## Description\n\n\n## Properties\n\nRarity: \nAttunement: no\n\n" +
      body("History", PLAYERS),
    extra: {},
  },
};

const BY_RULES: Record<RulesId, Record<string, ElementTemplate>> = {
  dnd5e: DND5E,
  generic: GENERIC,
};

export function templateFor(rules: RulesId, kind: string): ElementTemplate {
  return BY_RULES[rules][kind] ?? NONE;
}
