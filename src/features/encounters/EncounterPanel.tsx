import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  GripVertical,
  Play,
  Plus,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Skull,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { Button } from "@/components/Button";
import { Portrait } from "@/features/images/Portrait";
import { portraitOf } from "@/features/images/portrait-model";
import { CONDITIONS, signed } from "@/features/templates/dnd5e-model";
import { storage } from "@/lib/tauri";
import { elementLabel, type Element, type ElementSummary } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  addCombatant,
  applyHpInput,
  combatantFrom,
  customCombatant,
  endEncounter,
  moveCombatant,
  nextTurn,
  patchCombatant,
  prevTurn,
  readEncounter,
  removeCombatant,
  resetEncounter,
  searchPeople,
  sortByInitiative,
  startEncounter,
  type Combatant,
  type EncounterData,
} from "./encounter-model";

const AUTOSAVE_MS = 400;

const NUM =
  "w-12 rounded-md border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-center font-mono text-sm text-ink-100 outline-none focus:border-ember-500";

/**
 * The structured part of an encounter: who is in it, in what order, and whose
 * turn it is. Combatants come from the People family (search and add, the
 * same one twice for a pack of goblins) or are typed in as one-offs; drag
 * them into order or sort by initiative, then run the fight round by round.
 * The free-form prep, tactics and aftermath live in the body below.
 */
export function EncounterPanel({ element }: { element: Element }) {
  const elements = useCampaignStore((s) => s.elements);
  const saveElement = useCampaignStore((s) => s.saveElement);
  const navigate = useCampaignStore((s) => s.navigate);

  // Edited as a local draft and flushed on a short debounce, so typing a
  // number does not hit the disk on every keystroke. Structural changes
  // (add, remove, reorder, turn) save at once.
  const [data, setData] = useState<EncounterData>(() => readEncounter(element));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setData((current) => {
      void saveElement(element.id, {
        status: current.status,
        round: current.round,
        turn: current.turn,
        combatants: current.combatants,
      });
      return current;
    });
  }, [saveElement, element.id]);

  const update = useCallback(
    (fn: (data: EncounterData) => EncounterData, immediate = false) => {
      setData((current) => fn(current));
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      if (immediate) flush();
      else timer.current = setTimeout(flush, AUTOSAVE_MS);
    },
    [flush],
  );

  useEffect(() => () => flush(), [flush]);

  // ---- Adding combatants ---------------------------------------------------
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const hits = useMemo(() => searchPeople(elements, query), [elements, query]);
  const canAddCustom = query.trim().length > 0;
  // The rows the dropdown offers: every hit, then the one-off at the end.
  const optionCount = hits.length + (canAddCustom ? 1 : 0);

  function add(c: Combatant) {
    update((d) => addCombatant(d, c), true);
    setQuery("");
    setHighlight(0);
  }

  function addHit(e: ElementSummary) {
    add(combatantFrom(e, data.combatants));
  }

  function addCustom() {
    add(customCombatant(query, data.combatants));
  }

  function pick(index: number) {
    const hit = hits[index];
    if (hit) addHit(hit);
    else if (canAddCustom) addCustom();
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, optionCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (optionCount > 0) pick(Math.min(highlight, optionCount - 1));
    } else if (e.key === "Escape") {
      setQuery("");
    }
  }

  // ---- Drag to reorder -----------------------------------------------------
  // Only a drag that began on the grip handle moves a row, so selecting text
  // in a notes field never picks the row up by accident.
  const [armed, setArmed] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  function onDragStart(e: DragEvent<HTMLLIElement>, id: string) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setDragging(id);
  }

  function onDragOver(e: DragEvent<HTMLLIElement>, overId: string) {
    if (!dragging || dragging === overId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Reorder live as the pointer passes rows; the save waits for the drop.
    dirty.current = true;
    setData((d) => {
      const from = d.combatants.findIndex((c) => c.id === dragging);
      const to = d.combatants.findIndex((c) => c.id === overId);
      if (from < 0 || to < 0 || from === to) return d;
      return moveCombatant(d, from, to);
    });
  }

  function onDragEnd() {
    setDragging(null);
    setArmed(null);
    flush();
  }

  const { status, round, turn, combatants } = data;
  const standing = combatants.filter((c) => !c.down).length;

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      {/* ---- Status and controls ---------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={status} />
        {status !== "planned" && (
          <span className="font-serif text-lg font-semibold text-ink-100">
            Round {round}
          </span>
        )}
        <span className="text-xs text-ink-500">
          {combatants.length === 0
            ? "No combatants yet"
            : `${standing} of ${combatants.length} standing`}
        </span>
        <span className="flex-1" />
        {status === "planned" && (
          <Button
            size="sm"
            disabled={combatants.length === 0}
            onClick={() => update(startEncounter, true)}
            title="Round one, first combatant"
          >
            <Play size={14} /> Start encounter
          </Button>
        )}
        {status === "running" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update(prevTurn, true)}
              title="Back one turn"
            >
              <SkipBack size={14} /> Back
            </Button>
            <Button
              size="sm"
              onClick={() => update(nextTurn, true)}
              title="Next combatant still standing"
            >
              Next turn <SkipForward size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update(endEncounter, true)}
              title="Mark the encounter finished"
            >
              <Square size={13} /> End
            </Button>
          </>
        )}
        {status === "done" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update(resetEncounter, true)}
            title="Back to planned; combatants and their hit points are kept"
          >
            <RotateCcw size={14} /> Reset
          </Button>
        )}
      </div>

      {/* ---- Add combatants ---------------------------------------------- */}
      <div className="relative mt-4">
        <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 focus-within:border-ember-500">
          <Search size={14} className="shrink-0 text-ink-500" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onSearchKey}
            placeholder="Add a character or creature by name, or type a one-off…"
            aria-label="Add a combatant"
            className="w-full bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="text-ink-500 hover:text-ink-200"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {optionCount > 0 && (
          <ul
            role="listbox"
            className="absolute left-0 right-0 z-10 mt-1 max-h-72 overflow-y-auto rounded-md border border-ink-700 bg-ink-900 py-1 shadow-lg shadow-black/40"
          >
            {hits.map((e, i) => (
              <li key={e.id} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => addHit(e)}
                  className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left ${
                    i === highlight ? "bg-ink-700/60" : "hover:bg-ink-800"
                  }`}
                >
                  <Portrait
                    path={portraitOf(e)}
                    name={e.name}
                    kind={e.type}
                    size={24}
                    scope="local"
                    load={storage.readAsset}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-100">
                      {e.name}
                    </span>
                    <span className="block truncate text-[11px] text-ink-500">
                      {elementLabel(e)}
                      {e.tags.length > 0 && <> · {e.tags.join(", ")}</>}
                    </span>
                  </span>
                  <Plus size={14} className="shrink-0 text-ink-500" />
                </button>
              </li>
            ))}
            {canAddCustom && (
              <li role="option" aria-selected={highlight === hits.length}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(hits.length)}
                  onClick={addCustom}
                  className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-sm ${
                    highlight === hits.length
                      ? "bg-ink-700/60"
                      : "hover:bg-ink-800"
                  }`}
                >
                  <Plus size={14} className="shrink-0 text-ember-400" />
                  <span className="text-ink-200">
                    Add “{query.trim()}” as a one-off
                  </span>
                  <span className="text-[11px] text-ink-500">
                    not in the bible
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* ---- Turn order ---------------------------------------------------- */}
      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Turn order
        </h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={combatants.length < 2}
          onClick={() => update(sortByInitiative, true)}
          title="Highest initiative first; blanks last"
        >
          <ArrowDownWideNarrow size={14} /> Sort by initiative
        </Button>
      </div>

      {combatants.length === 0 ? (
        <p className="mt-2 text-sm text-ink-600">
          Nobody here yet. Search above to add the party and their foes; add the
          same creature twice for a pack. Type an initiative for each, sort,
          then press Start.
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {combatants.map((c, i) => (
            <CombatantRow
              key={c.id}
              combatant={c}
              index={i}
              current={status === "running" && i === turn}
              isFirst={i === 0}
              isLast={i === combatants.length - 1}
              dragging={dragging === c.id}
              draggable={armed === c.id}
              onArm={() => setArmed(c.id)}
              onDisarm={() => setArmed(null)}
              onDragStart={(e) => onDragStart(e, c.id)}
              onDragOver={(e) => onDragOver(e, c.id)}
              onDragEnd={onDragEnd}
              onChange={(patch, immediate) =>
                update((d) => patchCombatant(d, c.id, patch), immediate)
              }
              onMove={(delta) =>
                update((d) => moveCombatant(d, i, i + delta), true)
              }
              onRemove={() => update((d) => removeCombatant(d, c.id), true)}
              onOpen={
                c.element
                  ? (pane) => void navigate(c.element as string, { pane })
                  : undefined
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: EncounterData["status"] }) {
  const style =
    status === "running"
      ? "bg-red-500/20 text-red-200"
      : status === "done"
        ? "bg-emerald-500/20 text-emerald-200"
        : "bg-ink-800 text-ink-300";
  const label =
    status === "running"
      ? "Running"
      : status === "done"
        ? "Finished"
        : "Planned";
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}

function CombatantRow({
  combatant: c,
  index,
  current,
  isFirst,
  isLast,
  dragging,
  draggable,
  onArm,
  onDisarm,
  onDragStart,
  onDragOver,
  onDragEnd,
  onChange,
  onMove,
  onRemove,
  onOpen,
}: {
  combatant: Combatant;
  index: number;
  current: boolean;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  draggable: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onDragStart: (e: DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onChange: (patch: Partial<Combatant>, immediate?: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** Opens the element this combatant stands for; absent for a one-off. */
  onOpen?: (pane: boolean) => void;
}) {
  // Number fields keep their own text so a half-typed "-" or "" survives.
  const [initText, setInitText] = useState(
    c.initiative === null ? "" : String(c.initiative),
  );
  const [hpText, setHpText] = useState(c.hp === null ? "" : String(c.hp));
  const [hpMaxText, setHpMaxText] = useState(
    c.hpMax === null ? "" : String(c.hpMax),
  );
  const [acText, setAcText] = useState(c.ac === null ? "" : String(c.ac));
  // A "+5" or "-7" commits as the resulting total; show that, not the delta.
  const [shownHp, setShownHp] = useState(c.hp);
  if (shownHp !== c.hp) {
    setShownHp(c.hp);
    setHpText(c.hp === null ? "" : String(c.hp));
  }

  function commitInt(
    text: string,
    key: "initiative" | "hpMax" | "ac",
    setText: (t: string) => void,
  ) {
    const n = Number(text);
    const value = text.trim() && Number.isFinite(n) ? Math.round(n) : null;
    setText(value === null ? "" : String(value));
    if (value !== c[key]) onChange({ [key]: value }, true);
  }

  function commitHp() {
    const value = applyHpInput(c.hp, hpText);
    setHpText(value === null ? "" : String(value));
    if (value !== c.hp) onChange({ hp: value }, true);
  }

  const hurt =
    c.hp !== null && c.hpMax !== null && c.hpMax > 0 ? c.hp / c.hpMax : null;
  const hpTone =
    c.hp !== null && c.hp <= 0
      ? "text-red-300"
      : hurt !== null && hurt <= 0.5
        ? "text-amber-200"
        : "text-ink-100";

  const accent = current
    ? "border-ember-500/70 border-l-ember-400 bg-ember-500/10"
    : c.down
      ? "border-ink-800 border-l-ink-700 opacity-50"
      : "border-ink-800 border-l-ink-700";

  return (
    <li
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      className={`rounded-md border border-l-2 bg-ink-900 px-2 py-2 ${accent} ${
        dragging ? "opacity-40" : ""
      }`}
      aria-current={current ? "step" : undefined}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onMouseDown={onArm}
          onMouseUp={onDisarm}
          onMouseLeave={onDisarm}
          title="Drag to reorder"
          aria-label="Drag to reorder"
          className="cursor-grab text-ink-600 hover:text-ink-300 active:cursor-grabbing"
        >
          <GripVertical size={14} />
        </button>

        <label className="flex flex-col items-center" title="Initiative">
          <input
            value={initText}
            onChange={(e) => setInitText(e.target.value)}
            onBlur={() => commitInt(initText, "initiative", setInitText)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            inputMode="numeric"
            placeholder="—"
            aria-label="Initiative"
            className={NUM}
          />
          <span className="text-[10px] leading-tight text-ink-600">
            {c.initiativeBonus === null ? "init" : signed(c.initiativeBonus)}
          </span>
        </label>

        <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-600">
          {index + 1}
        </span>

        {c.element ? (
          <button
            type="button"
            onClick={(e) => onOpen?.(e.ctrlKey || e.metaKey)}
            title="Click to open · Ctrl+click to open beside"
            className={`min-w-0 flex-1 truncate text-left text-sm hover:underline ${
              c.down ? "line-through" : ""
            } ${current ? "font-semibold text-ember-100" : "text-ink-100"}`}
          >
            {c.name}
          </button>
        ) : (
          <input
            value={c.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Name"
            aria-label="Name"
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-600 ${
              c.down ? "line-through" : ""
            } ${current ? "font-semibold text-ember-100" : "text-ink-100"}`}
          />
        )}

        {current && (
          <span className="rounded bg-ember-500/25 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ember-200">
            Turn
          </span>
        )}

        <label
          className="flex items-center gap-1 text-[11px] text-ink-500"
          title="Hit points. Type +5 to heal or -7 to damage, or a number to set."
        >
          HP
          <input
            value={hpText}
            onChange={(e) => setHpText(e.target.value)}
            onBlur={commitHp}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            inputMode="numeric"
            placeholder="—"
            aria-label="Hit points"
            className={`${NUM} ${hpTone}`}
          />
          <span className="text-ink-600">/</span>
          <input
            value={hpMaxText}
            onChange={(e) => setHpMaxText(e.target.value)}
            onBlur={() => commitInt(hpMaxText, "hpMax", setHpMaxText)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            inputMode="numeric"
            placeholder="—"
            aria-label="Maximum hit points"
            className={NUM}
          />
        </label>

        <label
          className="flex items-center gap-1 text-[11px] text-ink-500"
          title="Armour class"
        >
          AC
          <input
            value={acText}
            onChange={(e) => setAcText(e.target.value)}
            onBlur={() => commitInt(acText, "ac", setAcText)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            inputMode="numeric"
            placeholder="—"
            aria-label="Armour class"
            className={NUM}
          />
        </label>

        <button
          type="button"
          onClick={() => onChange({ down: !c.down }, true)}
          title={c.down ? "Back in the fight" : "Out of the fight (skipped)"}
          aria-pressed={c.down}
          aria-label={c.down ? "Back in the fight" : "Out of the fight"}
          className={`rounded p-1 ${
            c.down
              ? "bg-red-500/20 text-red-200"
              : "text-ink-600 hover:bg-ink-800 hover:text-ink-300"
          }`}
        >
          <Skull size={13} />
        </button>
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
          onClick={onRemove}
          aria-label="Remove from encounter"
          className="text-ink-600 hover:text-red-300"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* ---- Conditions and notes ---------------------------------------- */}
      <div className="mt-1.5 ml-[4.75rem] flex flex-wrap items-center gap-1.5">
        {c.conditions.map((cond) => (
          <span
            key={cond}
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-100"
          >
            {cond}
            <button
              type="button"
              onClick={() =>
                onChange(
                  { conditions: c.conditions.filter((x) => x !== cond) },
                  true,
                )
              }
              aria-label={`Remove ${cond}`}
              className="text-amber-200/70 hover:text-amber-50"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <select
          value=""
          onChange={(e) => {
            const cond = e.target.value;
            if (cond && !c.conditions.includes(cond)) {
              onChange({ conditions: [...c.conditions, cond] }, true);
            }
          }}
          aria-label="Add a condition"
          className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 text-[11px] text-ink-400 outline-none focus:border-ember-500"
        >
          <option value="">+ condition</option>
          {CONDITIONS.filter((x) => !c.conditions.includes(x)).map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <input
          value={c.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="Notes: concentration, legendary actions left, who it is fighting…"
          aria-label="Notes"
          className="min-w-[10rem] flex-1 bg-transparent text-xs text-ink-300 outline-none placeholder:text-ink-700"
        />
      </div>
    </li>
  );
}
