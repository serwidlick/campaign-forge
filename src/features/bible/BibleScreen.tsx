import {
  ArrowLeftToLine,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  Waypoints,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Fragment, useMemo, useState, type FormEvent } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { AgentPane } from "@/features/agent/AgentPane";
import { GraphPanel } from "@/features/graph/GraphPanel";
import { JournalList } from "@/features/journal/JournalList";
import { CalendarSettings } from "@/features/timeline/CalendarSettings";
import { TimelineList } from "@/features/timeline/TimelineList";
import { displayName, sortForList } from "@/features/sessions/session-model";
import { ELEMENT_FAMILIES, ELEMENT_KINDS, kindById } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

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

  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<string>("character");
  const [view, setView] = useState<
    "elements" | "timeline" | "graph" | "journal"
  >("elements");
  const [calendarOpen, setCalendarOpen] = useState(false);
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

  function showKind(kind: string | null) {
    setView("elements");
    setKindFilter(kind);
    // "Everything" is the overview page; clear the selection so it shows.
    if (kind === null) void select(null);
  }

  function startNew(kind: string) {
    setView("elements");
    setKindFilter(kind);
    setNewKind(kind);
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
    setNewKind(kindFilter ?? "character");
    setNewName("");
  }

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of elements) map.set(e.type, (map.get(e.type) ?? 0) + 1);
    return map;
  }, [elements]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = elements.filter(
      (e) =>
        (!kindFilter || e.type === kindFilter) &&
        (!q ||
          e.name.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q))),
    );
    return sortForList(filtered, kindFilter);
  }, [elements, kindFilter, query]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newName?.trim()) return;
    await createElement(kindFilter ?? newKind, newName.trim());
    setNewName(null);
  }

  if (!campaign) return null;

  return (
    <div className="flex h-full flex-col">
      <ErrorBanner />
      <Group orientation="horizontal" className="flex-1">
        {/* ---- Kinds sidebar ---------------------------------------- */}
        <Panel
          defaultSize={230}
          minSize={170}
          maxSize={380}
          className="flex flex-col bg-ink-900"
        >
          <header className="border-b border-ink-800 px-3 py-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={closeCampaign}
                className="flex items-center gap-1 text-xs text-ink-400 hover:text-ink-200"
              >
                <ChevronLeft size={14} /> Campaigns
              </button>
              <button
                type="button"
                onClick={toggleAgent}
                title={agentOpen ? "Hide assistant" : "Show assistant"}
                aria-label={agentOpen ? "Hide assistant" : "Show assistant"}
                aria-pressed={agentOpen}
                className={`rounded-md p-1 transition-colors ${
                  agentOpen
                    ? "bg-ember-500/25 text-ember-200"
                    : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
                }`}
              >
                <Sparkles size={14} />
              </button>
            </div>
            <h1 className="mt-1 truncate font-serif text-lg font-semibold">
              {campaign.name}
            </h1>
            {campaign.system && (
              <p className="text-xs text-ink-400">{campaign.system}</p>
            )}
          </header>
          <nav className="flex-1 overflow-y-auto px-2 py-2">
            <button
              type="button"
              onClick={() => setView("timeline")}
              className={`mb-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
                view === "timeline"
                  ? "bg-ink-700/60 text-ink-100"
                  : "text-ink-300 hover:bg-ink-800"
              }`}
            >
              <span className="flex items-center gap-2">
                <CalendarDays size={14} className="text-ember-400" />
                Timeline
              </span>
              <span className="text-xs text-ink-500">{datedCount}</span>
            </button>
            <button
              type="button"
              onClick={() => setView("graph")}
              className={`mb-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
                view === "graph"
                  ? "bg-ink-700/60 text-ink-100"
                  : "text-ink-300 hover:bg-ink-800"
              }`}
            >
              <span className="flex items-center gap-2">
                <Waypoints size={14} className="text-ember-400" />
                Graph
              </span>
            </button>
            <button
              type="button"
              onClick={() => setView("journal")}
              className={`mb-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
                view === "journal"
                  ? "bg-ink-700/60 text-ink-100"
                  : "text-ink-300 hover:bg-ink-800"
              }`}
            >
              <span className="flex items-center gap-2">
                <BookOpen size={14} className="text-ember-400" />
                Journal
              </span>
              <span className="text-xs text-ink-500">
                {elements.filter((e) => e.type === "journal").length}
              </span>
            </button>
            <KindRow
              label="Everything"
              count={elements.length}
              active={view === "elements" && kindFilter === null}
              onClick={() => showKind(null)}
            />
            {ELEMENT_FAMILIES.map((family) => (
              <div key={family.id} className="mt-3">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
                  {family.label}
                </div>
                {ELEMENT_KINDS.filter((k) => k.family === family.id).map(
                  (k) => (
                    <KindRow
                      key={k.id}
                      label={k.plural}
                      count={counts.get(k.id) ?? 0}
                      active={view === "elements" && kindFilter === k.id}
                      onClick={() => showKind(k.id)}
                    />
                  ),
                )}
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
                      kindFilter
                        ? `Search ${kindById(kindFilter).plural.toLowerCase()}…`
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
              </div>

              {newName !== null && (
                <form
                  onSubmit={handleCreate}
                  className="border-b border-ink-800 px-3 py-2"
                >
                  {kindFilter ? (
                    <p className="mb-1 text-[11px] text-ink-400">
                      New {kindById(kindFilter).label.toLowerCase()}
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
                    autoFocus={kindFilter !== null}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setNewName(null)}
                    placeholder="Name"
                    className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm outline-none focus:border-ember-500"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" type="submit" disabled={!newName.trim()}>
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
                        void navigate(e.id, { pane: ev.ctrlKey || ev.metaKey })
                      }
                      title="Click to open · Ctrl+click to open beside the current element"
                      className={`w-full px-4 py-2 text-left transition-colors ${
                        e.id === selectedId
                          ? "bg-ink-700/60"
                          : "hover:bg-ink-800"
                      }`}
                    >
                      <div className="truncate text-sm text-ink-100">
                        {displayName(e)}
                      </div>
                      <div className="text-[11px] text-ink-500">
                        {kindById(e.type).label}
                        {e.tags.length > 0 && <> · {e.tags.join(", ")}</>}
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
          <Group orientation="horizontal" className="h-full">
            <Panel minSize={360} className="flex flex-col">
              {view === "graph" ? (
                <GraphPanel />
              ) : calendarOpen && view === "timeline" ? (
                <CalendarSettings onClose={() => setCalendarOpen(false)} />
              ) : view === "elements" && kindFilter === null && !selected ? (
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
