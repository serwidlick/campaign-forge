import { Users, UserRound } from "lucide-react";

import {
  CHARACTER_ROLES,
  characterRoleOf,
  type CharacterRole,
  type Element,
} from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

/**
 * Marks a character as one of the players' or one of the GM's. The choice
 * is saved straight to the character's `role` frontmatter field and decides
 * which sidebar list the character appears in.
 */
export function CharacterRoleField({ element }: { element: Element }) {
  const saveElement = useCampaignStore((s) => s.saveElement);
  const role = characterRoleOf(element);

  function setRole(next: CharacterRole) {
    if (next !== role) void saveElement(element.id, { role: next });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Character role"
      className="inline-flex rounded-md border border-ink-700 bg-ink-900 p-0.5 text-sm"
    >
      {CHARACTER_ROLES.map((r) => {
        const active = r.id === role;
        const Icon = r.id === "pc" ? UserRound : Users;
        return (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setRole(r.id)}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors ${
              active
                ? "bg-ink-700/70 text-ink-100"
                : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            }`}
          >
            <Icon size={14} className={active ? "text-ember-400" : ""} />
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
