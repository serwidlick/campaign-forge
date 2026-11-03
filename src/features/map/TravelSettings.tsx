import { Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/Button";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  DEFAULT_TRAVEL,
  newPaceId,
  travelOf,
  type TravelSettings,
} from "./travel-model";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";

const AUTOSAVE_MS = 500;

/**
 * Edits the campaign's travel paces. Lives under a map's toolbar but the
 * setting is campaign-wide: every map's measurements and routes use it.
 */
export function TravelSettingsPanel({
  unit,
  onClose,
}: {
  /** The current map's distance unit, for the labels. */
  unit: string;
  onClose: () => void;
}) {
  const campaign = useCampaignStore((s) => s.campaign);
  const updateCampaignSettings = useCampaignStore(
    (s) => s.updateCampaignSettings,
  );
  const initial = useMemo(() => travelOf(campaign), [campaign]);

  const [draft, setDraft] = useState<TravelSettings>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  function update(fn: (t: TravelSettings) => TravelSettings) {
    setDraft(fn);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  }

  function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setDraft((t) => {
      void updateCampaignSettings({ travel: t });
      return t;
    });
  }

  // Flush on unmount so closing the panel never loses an edit.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  return (
    <div className="border-t border-ink-800 px-3 py-3">
      <div className="mb-2 flex items-start gap-3">
        <div className="flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Travel paces
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
              campaign-wide
            </span>
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            How far each way of travelling covers in one day, in the unit your
            maps are scaled in ({unit}). Every measurement and route uses these.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </Button>
      </div>

      <ul className="space-y-1">
        {draft.paces.map((p, i) => (
          <li key={p.id} className="flex items-center gap-2">
            <input
              value={p.label}
              onChange={(e) =>
                update((t) => ({
                  ...t,
                  paces: t.paces.map((x, j) =>
                    j === i ? { ...x, label: e.target.value } : x,
                  ),
                }))
              }
              placeholder="On foot"
              className={`${FIELD} w-48`}
              aria-label={`Pace ${i + 1} name`}
            />
            <input
              type="number"
              min={0}
              step="any"
              value={p.perDay}
              onChange={(e) =>
                update((t) => ({
                  ...t,
                  paces: t.paces.map((x, j) =>
                    j === i
                      ? { ...x, perDay: Math.max(0, Number(e.target.value)) }
                      : x,
                  ),
                }))
              }
              className={`${FIELD} w-24`}
              aria-label={`Pace ${i + 1} distance per day`}
            />
            <span className="text-xs text-ink-500">{unit} a day</span>
            <button
              type="button"
              onClick={() =>
                update((t) => ({
                  ...t,
                  paces: t.paces.filter((_, j) => j !== i),
                }))
              }
              title="Remove pace"
              aria-label={`Remove ${p.label || "pace"}`}
              className="rounded p-1 text-ink-600 hover:bg-ink-800 hover:text-red-300"
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
        {draft.paces.length === 0 && (
          <li className="text-xs text-ink-500">
            No paces: measurements show distance only.
          </li>
        )}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            update((t) => ({
              ...t,
              paces: [...t.paces, { id: newPaceId(), label: "", perDay: 20 }],
            }))
          }
        >
          <Plus size={14} /> Add pace
        </Button>
        <label className="flex items-center gap-2 text-xs text-ink-400">
          Hours on the move per day
          <input
            type="number"
            min={1}
            max={24}
            value={draft.hoursPerDay}
            onChange={(e) =>
              update((t) => ({
                ...t,
                hoursPerDay: Math.min(
                  24,
                  Math.max(1, Number(e.target.value) || 1),
                ),
              }))
            }
            className={`${FIELD} w-16`}
          />
        </label>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => update(() => DEFAULT_TRAVEL)}
          title="Back to foot 24, horseback 40, wagon 16, eight hours a day"
        >
          <RotateCcw size={14} /> Defaults
        </Button>
      </div>
    </div>
  );
}
