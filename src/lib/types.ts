/**
 * Shared types mirroring the Rust storage models in
 * `src-tauri/src/storage/model.rs`. Keep the two in sync.
 */

export interface CampaignMeta {
  id: string;
  name: string;
  system?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Absolute path of the campaign folder. */
  path: string;
}

export interface ElementMeta {
  id: string;
  /** Element kind; also the folder under `elements/`. */
  type: string;
  name: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Path relative to the campaign root, forward slashes. */
  path: string;
}

export interface Element extends ElementMeta {
  /** Markdown body (everything after the frontmatter). */
  body: string;
}

export interface SaveElementInput {
  id: string;
  name: string;
  tags: string[];
  body: string;
}

/**
 * The built-in element kinds, grouped into families the way a GM thinks about
 * them. The `id` is what goes on disk, so changing one is a migration.
 */
export interface ElementKind {
  id: string;
  label: string;
  plural: string;
  family: ElementFamily;
}

export type ElementFamily = "people" | "places" | "things" | "story";

export const ELEMENT_FAMILIES: { id: ElementFamily; label: string }[] = [
  { id: "people", label: "People" },
  { id: "places", label: "Places" },
  { id: "things", label: "Things" },
  { id: "story", label: "Story" },
];

export const ELEMENT_KINDS: ElementKind[] = [
  {
    id: "character",
    label: "Character",
    plural: "Characters",
    family: "people",
  },
  { id: "faction", label: "Faction", plural: "Factions", family: "people" },
  { id: "creature", label: "Creature", plural: "Creatures", family: "people" },
  { id: "location", label: "Location", plural: "Locations", family: "places" },
  { id: "item", label: "Item", plural: "Items", family: "things" },
  { id: "quest", label: "Quest", plural: "Quests", family: "story" },
  { id: "event", label: "Event", plural: "Events", family: "story" },
  { id: "lore", label: "Lore", plural: "Lore", family: "story" },
];

export function kindById(id: string): ElementKind {
  return (
    ELEMENT_KINDS.find((k) => k.id === id) ?? {
      id,
      label: id,
      plural: id,
      family: "story",
    }
  );
}
