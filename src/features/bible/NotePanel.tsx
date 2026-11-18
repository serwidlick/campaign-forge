import { noteAuthorLabel } from "@/features/player/player-model";
import { playersOf } from "@/features/table/players-model";
import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

/**
 * Above a note's body: who wrote it, when it came from a player at the
 * table. A note the GM made has no author and shows nothing extra.
 */
export function NotePanel({ element }: { element: Element }) {
  const campaign = useCampaignStore((s) => s.campaign);
  const by = noteAuthorLabel(
    element,
    playersOf(campaign).map((p) => ({ id: p.id, name: p.name })),
  );
  if (!by) return null;
  return (
    <p className="text-xs text-ink-400">
      Written at the table by <span className="text-ink-200">{by}</span>. They
      always see it and can change it from their seat; share it to show it to
      everyone else.
    </p>
  );
}
