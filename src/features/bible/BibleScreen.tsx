import {
  ArrowLeftToLine,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  Eye,
  FileUp,
  Library,
  Map as MapIcon,
  Radio,
  Waypoints,
  Plus,
  Search,
  Sparkles,
  Swords,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Rail, RailButton, RailDivider, RailSpacer } from "@/components/Rail";
import { ThemePicker } from "@/components/ThemePicker";
import { AgentPane } from "@/features/agent/AgentPane";
import { GraphPanel } from "@/features/graph/GraphPanel";
import { JournalList } from "@/features/journal/JournalList";
import { PlayerScreen } from "@/features/player/PlayerScreen";
import { isShared, localPreviewSource } from "@/features/player/player-model";
import { Portrait } from "@/features/images/Portrait";
import { portraitOf } from "@/features/images/portrait-model";
import { ImportPdfPanel } from "@/features/import/ImportPdfPanel";
import { HostPanel } from "@/features/table/HostPanel";
import { Charactermancer5e } from "@/features/templates/Charactermancer5e";
import type { Sheet5e } from "@/features/templates/dnd5e-model";
import { rulesOf } from "@/features/templates/rulesets";
import { playersOf } from "@/features/table/players-model";
import { calendarOf } from "@/features/timeline/calendar-model";
import { CalendarSettings } from "@/features/timeline/CalendarSettings";
import { TimelineList } from "@/features/timeline/TimelineList";
import { displayName, sortForList } from "@/features/sessions/session-model";
import { storage } from "@/lib/tauri";
import {
  DEFAULT_CHARACTER_ROLE,
  ELEMENT_FAMILIES,
  ELEMENT_KINDS,
  elementLabel,
  filterNames,
  filtersForKind,
  kindById,
  matchesFilter,
  type CharacterRole,
  type ElementSummary,
  type ListFilter,
} from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";
import { useTableStore } from "@/stores/table-store";

import { ElementEditorFor } from "./ElementEditorFor";
import { OverviewPanel } from "./OverviewPanel";

// Numbers in react-resizable-panels v4 are pixels; strings without units are
// percentages. Pixels suit sidebars, which should not scale with the window.
const SEPARATOR_CLASS =
  "w-1 shrink-0 bg-ink-800 transition-colors hover:bg-ember-500/70 focus-visible:bg-ember-500 data-[separator=active]:bg-ember-500";

export function BibleScreen() {
  const campaign = useCampaignStore((s) => s.campaign);
  const elements = useCampaignStore((s) => s.elements);
  const selectedId = useCampaignStore((s) => s.selectedId);
  const selected = useCampaignStore((s) => s.selected);
  const revisions = useCampaignStore((s) => s.revisions);
  const paneIds = useCampaignStore((s) => s.paneIds);
  const loaded = useCampaignStore((s) => s.loaded);
  const closePane = useCampaignStore((s) => s.closePane);
  const promotePane = useCampaignStore((s) => s.promotePane);
  const navigate = useCampaignStore((s) => s.navigate);
  const select = useCampaignStore((s) => s.select);
  const createElement = useCampaignStore((s) => s.createElement);
  const closeCampaign = useCampaignStore((s) => s.closeCampaign);

  const [filter, setFilter] = useState<ListFilter | null>(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<string>("character");
  /** The name the charactermancer opened with; null while it is closed. */
  const [mancerName, setMancerName] = useState<string | null>(null);
  const rules = rulesOf(campaign);
  const [view, setView] = useState<
    "elements" | "timeline" | "graph" | "journal" | "table" | "import"
  >("elements");
  const hosting = useTableStore((s) => s.hosting);
  const stopHosting = useTableStore((s) => s.stopHosting);
  // A GM working from a second machine: the table is hosted elsewhere.
  const remoteGm = useTableStore((s) => s.session?.gm === true);
  const leaveTable = useTableStore((s) => s.leave);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [playerPreview, setPlayerPreview] = useState(false);
  const [previewAs, setPreviewAs] = useState<string | null>(null);
  const registry = playersOf(campaign);
  const previewPlayer = registry.find((p) => p.id === previewAs);
  // The preview reads through the same Rust sanitiser as the table server.
  const [sharedElements, setSharedElements] = useState<ElementSummary[]>([]);
  useEffect(() => {
    if (!playerPreview) return;
    let cancelled = false;
    storage
      .listSharedElements(previewPlayer?.id)
      .then((list) => {
        if (!cancelled) setSharedElements(list);
      })
      .catch(() => {
        /* the error banner already reports storage failures */
      });
    return () => {
      cancelled = true;
    };
  }, [playerPreview, elements, previewPlayer?.id]);
  const previewSource = useMemo(
    () => localPreviewSource(sharedElements, previewPlayer, registry),
    [sharedElements, previewPlayer, registry],
  );
  const calendar = useMemo(() => calendarOf(campaign), [campaign]);
  const sharedCount = useMemo(
    () => elements.filter(isShared).length,
    [elements],
  );
  const datedCount = useMemo(
    () =>
      elements.filter(
        (e) =>
          (e.type === "event" && e.when !== undefined && e.when !== null) ||
          (e.type === "session" &&
            e.worldDate !== undefined &&
            e.worldDate !== null),
      ).length,
    [elements],
  );

  function showList(next: ListFilter | null) {
    setView("elements");
    setFilter(next);
    // "Everything" is the overview page; clear the selection so it shows.
    if (next === null) void select(null);
  }

  function startNew(next: ListFilter) {
    setView("elements");
    setFilter(next);
    setNewKind(next.kind);
    setNewName("");
  }

  const [agentOpen, setAgentOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cf.agentOpen") === "1";
    } catch {
      return false;
    }
  });

  function toggleAgent() {
    setAgentOpen((open) => {
      try {
        localStorage.setItem("cf.agentOpen", open ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !open;
    });
  }

  function openNewForm() {
    // Inside a kind, the kind is implied. On "Everything" the user picks one.
    setNewKind(filter?.kind ?? "character");
    setNewName("");
  }

  // One count per sidebar row: a kind, or a character role.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    const bump = (key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const e of elements) {
      bump(e.type);
      for (const f of filtersForKind(e.type)) {
        if (f.role !== undefined && matchesFilter(e, f)) bump(filterKey(f));
      }
    }
    return map;
  }, [elements]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = elements.filter(
      (e) =>
        matchesFilter(e, filter) &&
        (!q ||
          e.name.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q))),
    );
    return sortForList(filtered, filter?.kind ?? null);
  }, [elements, filter, query]);

  const creatingKind = filter?.kind ?? newKind;
  // Inside the player characters or NPCs list the role is implied; on
  // "Everything" or "Characters" a new character is an NPC unless chosen.
  const creatingRole: CharacterRole = filter?.role ?? DEFAULT_CHARACTER_ROLE;
  // A 5e character can start three ways: as an NPC, as a blank player
  // sheet, or through the guided builder. Inside the NPC list, and for
  // other kinds, a name is all it takes.
  const characterChoice =
    creatingKind === "character" && rules === "dnd5e" && filter?.role !== "npc";

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newName?.trim()) return;
    if (creatingKind === "character") {
      await createCharacter(creatingRole);
      return;
    }
    await createElement(creatingKind, newName.trim());
    setNewName(null);
  }

  /** The ruleset's template supplies the rest (a 5e sheet, the headings). */
  async function createCharacter(role: CharacterRole) {
    if (!newName?.trim()) return;
    await createElement("character", newName.trim(), { role });
    setNewName(null);
  }

  function openCharactermancer() {
    setMancerName(newName ?? "");
    setNewName(null);
  }

  async function finishCharactermancer(name: string, sheet: Sheet5e) {
    await createElement("character", name, { role: "pc", sheet });
    setMancerName(null);
  }

  if (!campaign) return null;

  if (playerPreview) {
    return (
      <div className="flex h-full flex-col">
        <ErrorBanner />
        <PlayerScreen
          source={previewSource}
          calendar={calendar}
          title={campaign.name}
          subtitle={campaign.system ?? undefined}
          banner="Previewing as a player: only shared elements, and only what is shared on them."
          exitLabel="Back to GM view"
          onExit={() => setPlayerPreview(false)}
          bannerExtra={
            <label className="flex items-center gap-1.5 text-xs">
              Previewing as
              <select
                value={previewAs ?? ""}
                onChange={(e) => setPreviewAs(e.target.value || null)}
                className="rounded-md border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-xs text-ink-100 outline-none"
              >
                <option value="">anyone</option>
                {registry.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      </div>
    );
  }

  // The rail's Bible button covers the element list, except the two kinds
  // that have rail buttons of their own.
  const listKind = view === "elements" ? filter?.kind : undefined;
  const bibleActive =
    view === "import" ||
    (view === "elements" && listKind !== "map" && listKind !== "encounter");
  const seated = hosting?.players.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <ErrorBanner />
      <div className="flex min-h-0 flex-1">
        {/* ---- Rail ---------------------------------------------------- */}
        <Rail label="Workspace">
          <RailButton
            label="World bible"
            icon={<Library size={18} />}
            active={bibleActive}
            onClick={() => setView("elements")}
          />
          <RailButton
            label="Maps"
            icon={<MapIcon size={18} />}
            active={listKind === "map"}
            onClick={() => showList({ kind: "map" })}
          />
          <RailButton
            label="Timeline"
            icon={<CalendarDays size={18} />}
            title={`Timeline · ${datedCount} dated`}
            active={view === "timeline"}
            onClick={() => setView("timeline")}
          />
          <RailButton
            label="Graph"
            icon={<Waypoints size={18} />}
            active={view === "graph"}
            onClick={() => setView("graph")}
          />
          <RailButton
            label="Journal"
            icon={<BookOpen size={18} />}
            active={view === "journal"}
            onClick={() => setView("journal")}
          />
          <RailButton
            label="Encounters"
            icon={<Swords size={18} />}
            active={listKind === "encounter"}
            onClick={() => showList({ kind: "encounter" })}
          />
          <RailDivider />
          <RailButton
            label="Table"
            icon={<Radio size={18} />}
            title={
              remoteGm
                ? "The table, hosted by the other machine"
                : hosting
                  ? `Hosting a table · code ${hosting.code} · ${seated} seated`
                  : "Host a table"
            }
            active={view === "table"}
            tone={hosting ? "live" : "default"}
            badge={hosting ? seated : undefined}
            onClick={() =>
              setView((v) => (v === "table" ? "elements" : "table"))
            }
          />
          <RailButton
            label="Assistant"
            icon={<Sparkles size={18} />}
            title={agentOpen ? "Hide assistant" : "Show assistant"}
            active={agentOpen}
            tone={agentOpen ? "accent" : "default"}
            onClick={toggleAgent}
          />
          <RailSpacer />
          <RailButton
            label="Preview"
            icon={<Eye size={18} />}
            title={`Preview as a player (${sharedCount} shared)`}
            onClick={() => setPlayerPreview(true)}
          />
          <ThemePicker variant="rail" placement="right-end" />
        </Rail>

        <Group orientation="horizontal" className="min-w-0 flex-1">
          {/* ---- Kinds sidebar ---------------------------------------- */}
          <Panel
            defaultSize={230}
            minSize={190}
            maxSize={380}
            className="flex flex-col bg-ink-900"
          >
            <header className="border-b border-ink-800 px-3 py-3">
              <button
                type="button"
                onClick={() => {
                  if (remoteGm) {
                    void leaveTable();
                    return;
                  }
                  void stopHosting();
                  closeCampaign();
                }}
                className="flex items-center gap-1 text-xs text-ink-400 hover:text-ink-200"
              >
                <ChevronLeft size={14} />{" "}
                {remoteGm ? "Leave table" : "Campaigns"}
              </button>
              <h1 className="mt-1 truncate font-serif text-lg font-semibold">
                {campaign.name}
              </h1>
              {campaign.system && (
                <p className="text-xs text-ink-400">{campaign.system}</p>
              )}
            </header>
            <nav className="flex-1 overflow-y-auto px-2 py-2">
              <KindRow
                label="Everything"
                count={elements.length}
                active={view === "elements" && filter === null}
                onClick={() => showList(null)}
              />
              {ELEMENT_FAMILIES.map((family) => (
                <div key={family.id} className="mt-3">
                  <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
                    {family.label}
                  </div>
                  {ELEMENT_KINDS.filter((k) => k.family === family.id)
                    .flatMap((k) => filtersForKind(k.id))
                    .map((f) => (
                      <KindRow
                        key={filterKey(f)}
                        label={filterNames(f).plural}
                        count={counts.get(filterKey(f)) ?? 0}
                        active={
                          view === "elements" &&
                          filter !== null &&
                          filterKey(filter) === filterKey(f)
                        }
                        onClick={() => showList(f)}
                      />
                    ))}
                </div>
              ))}
            </nav>
          </Panel>

          <Separator className={SEPARATOR_CLASS} />

          {/* ---- Element list ----------------------------------------- */}
          <Panel
            defaultSize={300}
            minSize={210}
            maxSize={520}
            className="flex flex-col bg-ink-850"
          >
            {view === "journal" ? (
              <JournalList selectedId={selectedId} />
            ) : view === "timeline" ? (
              <TimelineList
                selectedId={selectedId}
                calendarOpen={calendarOpen}
                onOpenCalendar={() => setCalendarOpen((v) => !v)}
              />
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
                  <div className="flex flex-1 items-center gap-2 rounded-md bg-ink-900 px-2 py-1.5">
                    <Search size={14} className="text-ink-500" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        filter
                          ? `Search ${lower(filterNames(filter).plural)}…`
                          : "Search…"
                      }
                      className="w-full bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-600"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={openNewForm}
                    aria-label="New element"
                  >
                    <Plus size={14} /> New
                  </Button>
                  <button
                    type="button"
                    onClick={() =>
                      setView((v) => (v === "import" ? "elements" : "import"))
                    }
                    title="Import a PDF and build elements from it"
                    aria-label="Import a PDF"
                    aria-pressed={view === "import"}
                    className={`rounded-md p-1.5 transition-colors ${
                      view === "import"
                        ? "bg-ember-500/25 text-ember-200"
                        : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
                    }`}
                  >
                    <FileUp size={14} />
                  </button>
                </div>

                {newName !== null && (
                  <form
                    onSubmit={handleCreate}
                    className="border-b border-ink-800 px-3 py-2"
                  >
                    {filter ? (
                      <p className="mb-1 text-[11px] text-ink-400">
                        New {lower(filterNames(filter).label)}
                      </p>
                    ) : (
                      <label className="mb-2 block text-[11px] text-ink-400">
                        What are you creating?
                        <select
                          autoFocus
                          value={newKind}
                          onChange={(e) => setNewKind(e.target.value)}
                          onKeyDown={(e) =>
                            e.key === "Escape" && setNewName(null)
                          }
                          className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-ember-500"
                        >
                          {ELEMENT_FAMILIES.map((family) => (
                            <optgroup key={family.id} label={family.label}>
                              {ELEMENT_KINDS.filter(
                                (k) => k.family === family.id,
                              ).map((k) => (
                                <option key={k.id} value={k.id}>
                                  {k.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                    )}
                    <input
                      autoFocus={filter !== null}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setNewName(null)}
                      placeholder="Name"
                      className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm outline-none focus:border-ember-500"
                    />
                    {characterChoice ? (
                      <div className="mt-2 space-y-1.5">
                        {filter?.role !== "pc" && (
                          <CreateChoice
                            label="NPC"
                            blurb="A person in the world, with a light sheet."
                            disabled={!newName.trim()}
                            onClick={() => void createCharacter("npc")}
                          />
                        )}
                        <CreateChoice
                          label="Character sheet"
                          blurb="A blank player sheet to fill in by hand."
                          disabled={!newName.trim()}
                          onClick={() => void createCharacter("pc")}
                        />
                        <CreateChoice
                          label="Charactermancer"
                          blurb="Build a player character step by step."
                          onClick={openCharactermancer}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setNewName(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          type="submit"
                          disabled={!newName.trim()}
                        >
                          Create
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setNewName(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </form>
                )}

                <ul className="flex-1 overflow-y-auto py-1">
                  {visible.length === 0 && (
                    <li className="px-4 py-6 text-center text-sm text-ink-500">
                      {elements.length === 0
                        ? "Nothing here yet. Create your first element."
                        : "No matches."}
                    </li>
                  )}
                  {visible.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={(ev) =>
                          void navigate(e.id, {
                            pane: ev.ctrlKey || ev.metaKey,
                          })
                        }
                        title="Click to open · Ctrl+click to open beside the current element"
                        className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                          e.id === selectedId
                            ? "bg-ink-700/60"
                            : "hover:bg-ink-800"
                        }`}
                      >
                        <Portrait
                          path={portraitOf(e)}
                          name={e.name}
                          kind={e.type}
                          size={30}
                          scope="local"
                          load={storage.readAsset}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-sm text-ink-100">
                            <span className="truncate">{displayName(e)}</span>
                            {isShared(e) && (
                              <span
                                title="Shared with players"
                                className="shrink-0 text-ember-400/80"
                              >
                                <Eye size={12} />
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-ink-500">
                            {elementLabel(e)}
                            {e.tags.length > 0 && <> · {e.tags.join(", ")}</>}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>

          <Separator className={SEPARATOR_CLASS} />

          {/* ---- Editor and side columns -------------------------------- */}
          <Panel minSize={420} className="flex flex-col bg-ink-950">
            {/* The table bar: where the table stands, and the player preview,
              always in reach while running a session. */}
            <div className="flex items-center gap-2 border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-xs">
              <span className="truncate text-ink-400">
                {view === "table"
                  ? "Table"
                  : view === "graph"
                    ? "Graph"
                    : view === "timeline"
                      ? "Timeline"
                      : view === "journal"
                        ? "Journal"
                        : view === "import"
                          ? "Import a PDF"
                          : filter
                            ? filterNames(filter).plural
                            : "Everything"}
              </span>
              <span className="flex-1" />
              {hosting ? (
                <button
                  type="button"
                  onClick={() => setView("table")}
                  title="Open the table"
                  className="flex items-center gap-1.5 rounded-full bg-green-500/15 px-2.5 py-0.5 text-[11px] font-medium text-green-300 transition-colors hover:bg-green-500/25"
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full bg-green-400"
                  />
                  Hosting · <span className="font-mono">{hosting.code}</span> ·{" "}
                  {seated} {seated === 1 ? "player" : "players"}
                </button>
              ) : remoteGm ? (
                <button
                  type="button"
                  onClick={() => setView("table")}
                  className="rounded-full bg-ink-800 px-2.5 py-0.5 text-[11px] text-ink-300 transition-colors hover:bg-ink-700"
                >
                  At a table hosted elsewhere
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setView("table")}
                  className="rounded-md px-2 py-0.5 text-[11px] text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
                >
                  Host a table
                </button>
              )}
              <button
                type="button"
                onClick={() => setPlayerPreview(true)}
                title={`Preview as a player (${sharedCount} shared)`}
                className="flex items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 text-[11px] text-ink-200 transition-colors hover:bg-ink-800"
              >
                <Eye size={12} /> Preview
              </button>
            </div>
            <Group orientation="horizontal" className="min-h-0 flex-1">
              <Panel minSize={360} className="flex flex-col">
                {view === "table" ? (
                  <HostPanel
                    onClose={() => setView("elements")}
                    onPreview={() => setPlayerPreview(true)}
                  />
                ) : view === "graph" ? (
                  <GraphPanel />
                ) : view === "import" ? (
                  <ImportPdfPanel onClose={() => setView("elements")} />
                ) : calendarOpen && view === "timeline" ? (
                  <CalendarSettings onClose={() => setCalendarOpen(false)} />
                ) : view === "elements" && filter === null && !selected ? (
                  <OverviewPanel onNew={startNew} />
                ) : selected ? (
                  <ElementEditorFor
                    key={`${selected.id}:${revisions[selected.id] ?? 0}`}
                    element={selected}
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-ink-600">
                    <span>Select an element, or create one.</span>
                    <span className="text-xs text-ink-700">
                      Ctrl+click opens an element beside the current one.
                    </span>
                  </div>
                )}
              </Panel>
              {paneIds.map((id) => {
                const el = loaded[id];
                const summary = elements.find((e) => e.id === id);
                return (
                  <Fragment key={id}>
                    <Separator className={SEPARATOR_CLASS} />
                    <Panel minSize={320} className="flex flex-col">
                      <div className="flex items-center gap-2 border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-xs">
                        <span className="text-ink-500">
                          {kindById((summary ?? el)?.type ?? "").label}
                        </span>
                        <span className="truncate text-ink-200">
                          {(summary ?? el)?.name ?? "…"}
                        </span>
                        <span className="flex-1" />
                        <button
                          type="button"
                          onClick={() => void promotePane(id)}
                          title="Swap into the main column"
                          aria-label="Swap into the main column"
                          className="rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                        >
                          <ArrowLeftToLine size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => closePane(id)}
                          title="Close column"
                          aria-label="Close column"
                          className="rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                        >
                          <X size={13} />
                        </button>
                      </div>
                      {el ? (
                        <ElementEditorFor
                          key={`${id}:${revisions[id] ?? 0}`}
                          element={el}
                        />
                      ) : (
                        <div className="flex flex-1 items-center justify-center text-xs text-ink-600">
                          Loading…
                        </div>
                      )}
                    </Panel>
                  </Fragment>
                );
              })}
            </Group>
          </Panel>

          {/* ---- Assistant --------------------------------------------- */}
          {agentOpen && (
            <>
              <Separator className={SEPARATOR_CLASS} />
              <Panel defaultSize={380} minSize={300} maxSize={640}>
                <AgentPane onClose={toggleAgent} />
              </Panel>
            </>
          )}
        </Group>
      </div>
      {mancerName !== null && (
        <Charactermancer5e
          initialName={mancerName}
          onCancel={() => setMancerName(null)}
          onCreate={finishCharactermancer}
        />
      )}
    </div>
  );
}

/** A stable key for a sidebar row: the kind, plus the role for characters. */
function filterKey(f: ListFilter): string {
  return f.role === undefined ? f.kind : `${f.kind}:${f.role}`;
}

/** Lower-cases a label for mid-sentence use, keeping acronyms like NPC. */
function lower(label: string): string {
  return label === label.toUpperCase() ? label : label.toLowerCase();
}

/** One of the ways a new character can start. */
function CreateChoice({
  label,
  blurb,
  disabled,
  onClick,
}: {
  label: string;
  blurb: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full rounded-md border border-ink-700 px-2.5 py-1.5 text-left transition-colors hover:border-ember-500/60 hover:bg-ember-500/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-700 disabled:hover:bg-transparent"
    >
      <span className="block text-sm text-ink-100">{label}</span>
      <span className="block text-[11px] text-ink-400">{blurb}</span>
    </button>
  );
}

function KindRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
        active ? "bg-ink-700/60 text-ink-100" : "text-ink-300 hover:bg-ink-800"
      }`}
    >
      <span>{label}</span>
      <span className="text-xs text-ink-500">{count}</span>
    </button>
  );
}
