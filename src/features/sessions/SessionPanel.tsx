import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  Flag,
  Plus,
  Swords,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/Button";
import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  moveBeat,
  newBeat,
  readSession,
  setBeatRole,
  type Beat,
  type BeatRole,
  type SessionData,
} from "./session-model";

const BEATS_AUTOSAVE_MS = 400;

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";

/**
 * Structured part of a session: which arc, number, date, status, and the beat
 * sequence with one main encounter and one cliffhanger. The free-form prep
 * notes live in the Markdown body below this panel.
 */
export function SessionPanel({ element }: { element: Element }) {
  const elements = useCampaignStore((s) => s.elements);
  const saveSelected = useCampaignStore((s) => s.saveSelected);
  const select = useCampaignStore((s) => s.select);

  const session = useMemo(() => readSession(element), [element]);
  const arcs = useMemo(
    () => elements.filter((e) => e.type === "arc"),
    [elements],
  );

  // Header fields save straight away; they change rarely.
  const saveField = useCallback(
    (patch: Partial<SessionData>) => {
      // null means "remove the key from frontmatter"; the store drops nulls.
      void saveSelected(patch as Record<string, unknown>);
    },
    [saveSelected],
  );

  // Beats are edited as a local draft and flushed on a short debounce, so
  // typing a title does not hit the disk on every keystroke.
  const [beats, setBeats] = useState<Beat[]>(session.beats);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setBeats((current) => {
      void saveSelected({ beats: current });
      return current;
    });
  }, [saveSelected]);

  const update = useCallback(
    (fn: (beats: Beat[]) => Beat[], immediate = false) => {
      setBeats((current) => fn(current));
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      if (immediate) {
        flush();
      } else {
        timer.current = setTimeout(flush, BEATS_AUTOSAVE_MS);
      }
    },
    [flush],
  );

  useEffect(() => () => flush(), [flush]);

  const [numberText, setNumberText] = useState(
    session.number === null ? "" : String(session.number),
  );

  const done = beats.filter((b) => b.done).length;

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      {/* ---- Header fields ------------------------------------------- */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-3">
        <label className="text-[11px] text-ink-400">
          Arc
          <select
            value={session.arc ?? ""}
            onChange={(e) => saveField({ arc: e.target.value || null })}
            className={`mt-1 block w-full ${FIELD}`}
          >
            <option value="">No arc</option>
            {arcs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-ink-400">
          Session #
          <input
            type="number"
            min={1}
            value={numberText}
            onChange={(e) => setNumberText(e.target.value)}
            onBlur={() => {
              const n = Number(numberText);
              saveField({
                number: numberText.trim() && Number.isFinite(n) ? n : null,
              });
            }}
            className={`mt-1 block w-20 ${FIELD}`}
          />
        </label>
        <label className="text-[11px] text-ink-400">
          Date
          <input
            type="date"
            value={session.date ?? ""}
            onChange={(e) => saveField({ date: e.target.value || null })}
            className={`mt-1 block ${FIELD}`}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            saveField({
              status: session.status === "played" ? "planned" : "played",
            })
          }
          className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${
            session.status === "played"
              ? "bg-emerald-500/20 text-emerald-200"
              : "bg-ink-800 text-ink-300 hover:bg-ink-700"
          }`}
        >
          {session.status === "played" ? "Played" : "Planned"}
        </button>
      </div>

      {session.arc && (
        <button
          type="button"
          onClick={() => void select(session.arc as string)}
          className="mt-2 text-[11px] text-ember-400 hover:underline"
        >
          Open arc →
        </button>
      )}

      {/* ---- Beats ---------------------------------------------------- */}
      <div className="mt-5 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Beats
          {beats.length > 0 && (
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
              {done}/{beats.length} done
            </span>
          )}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => update((b) => [...b, newBeat()], true)}
        >
          <Plus size={14} /> Add beat
        </Button>
      </div>

      {beats.length === 0 ? (
        <p className="mt-2 text-sm text-ink-600">
          No beats yet. A beat is one thing you expect to happen: a scene, a
          reveal, a fight. Mark one as the main encounter and one as the
          cliffhanger.
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {beats.map((beat, i) => (
            <BeatRow
              key={beat.id}
              beat={beat}
              index={i}
              isFirst={i === 0}
              isLast={i === beats.length - 1}
              onChange={(patch) =>
                update((b) =>
                  b.map((x) => (x.id === beat.id ? { ...x, ...patch } : x)),
                )
              }
              onRole={(role) =>
                update((b) => setBeatRole(b, beat.id, role), true)
              }
              onMove={(delta) =>
                update((b) => moveBeat(b, beat.id, delta), true)
              }
              onDelete={() =>
                update((b) => b.filter((x) => x.id !== beat.id), true)
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function BeatRow({
  beat,
  index,
  isFirst,
  isLast,
  onChange,
  onRole,
  onMove,
  onDelete,
}: {
  beat: Beat;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<Beat>) => void;
  onRole: (role: BeatRole) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const accent =
    beat.role === "encounter"
      ? "border-l-red-400/70"
      : beat.role === "cliffhanger"
        ? "border-l-ember-400/80"
        : "border-l-ink-700";

  return (
    <li
      className={`rounded-md border border-ink-800 border-l-2 bg-ink-900 px-3 py-2 ${accent} ${
        beat.done ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange({ done: !beat.done })}
          aria-label={beat.done ? "Mark not done" : "Mark done"}
          className="text-ink-400 hover:text-emerald-300"
        >
          {beat.done ? (
            <CheckCircle2 size={16} className="text-emerald-300" />
          ) : (
            <Circle size={16} />
          )}
        </button>
        <span className="w-5 text-right font-mono text-[11px] text-ink-600">
          {index + 1}
        </span>
        <input
          value={beat.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="What happens?"
          className={`flex-1 bg-transparent text-sm outline-none placeholder:text-ink-600 ${
            beat.done ? "line-through" : ""
          }`}
        />
        <RoleToggle
          active={beat.role === "encounter"}
          label="Main encounter"
          onClick={() =>
            onRole(beat.role === "encounter" ? "beat" : "encounter")
          }
          activeClass="bg-red-500/20 text-red-200"
        >
          <Swords size={13} />
        </RoleToggle>
        <RoleToggle
          active={beat.role === "cliffhanger"}
          label="Cliffhanger"
          onClick={() =>
            onRole(beat.role === "cliffhanger" ? "beat" : "cliffhanger")
          }
          activeClass="bg-ember-500/25 text-ember-200"
        >
          <Flag size={13} />
        </RoleToggle>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={isFirst}
          aria-label="Move up"
          className="text-ink-600 hover:text-ink-300 disabled:opacity-30"
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={isLast}
          aria-label="Move down"
          className="text-ink-600 hover:text-ink-300 disabled:opacity-30"
        >
          <ArrowDown size={13} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete beat"
          className="text-ink-600 hover:text-red-300"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <textarea
        value={beat.notes}
        onChange={(e) => onChange({ notes: e.target.value })}
        placeholder="Notes for this beat (optional)"
        rows={beat.notes ? Math.min(6, beat.notes.split("\n").length + 1) : 1}
        className="mt-1 ml-9 w-[calc(100%-2.25rem)] resize-none bg-transparent text-xs text-ink-300 outline-none placeholder:text-ink-700"
      />
    </li>
  );
}

function RoleToggle({
  active,
  label,
  onClick,
  activeClass,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  activeClass: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-pressed={active}
      aria-label={label}
      className={`rounded p-1 ${
        active
          ? activeClass
          : "text-ink-600 hover:bg-ink-800 hover:text-ink-300"
      }`}
    >
      {children}
    </button>
  );
}
