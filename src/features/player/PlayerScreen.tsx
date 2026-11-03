import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Eye, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/Button";
import {
  formatIsoDate,
  readJournal,
  scopeLabel,
} from "@/features/journal/journal-model";
import { readMap } from "@/features/map/map-model";
import {
  displayName,
  readArc,
  readSession,
  sortForList,
} from "@/features/sessions/session-model";
import {
  compareDates,
  formatWorldDate,
  readWorldDate,
  type Calendar,
} from "@/features/timeline/calendar-model";
import {
  ELEMENT_FAMILIES,
  ELEMENT_KINDS,
  elementIdFromHref,
  kindById,
  type Element,
  type ElementSummary,
} from "@/lib/types";

import { PlayerMap } from "./PlayerMap";
import type { PlayerSource } from "./player-model";

interface Props {
  source: PlayerSource;
  calendar: Calendar;
  title: string;
  subtitle?: string;
  /** Shown across the top, e.g. "Previewing as a player". */
  banner?: string;
  exitLabel: string;
  onExit: () => void;
  /** Something the GM wants on screen now; a new nonce opens it again. */
  focus?: { id: string; nonce: number };
}

/**
 * What a player sees: a read-only bible of shared elements. Fed by a
 * `PlayerSource`, so the same screen serves the GM's preview today and a
 * table joined over the network later.
 */
export function PlayerScreen({
  source,
  calendar,
  title,
  subtitle,
  banner,
  exitLabel,
  onExit,
  focus,
}: Props) {
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The GM's spotlight: adopt it once per nonce, during render, so it does
  // not fight the player's own clicks afterwards.
  const [focusSeen, setFocusSeen] = useState<number | null>(null);
  if (focus && focus.nonce !== focusSeen) {
    setFocusSeen(focus.nonce);
    setSelectedId(focus.id);
    setKindFilter(null);
  }
  const [opened, setOpened] = useState<{
    id: string;
    element: Element | null;
  } | null>(null);

  const elements = source.elements;

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

  // Re-read whenever the source changes too, so a GM un-sharing something
  // while previewing sees it vanish.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    source
      .readElement(selectedId)
      .then((element) => {
        if (!cancelled) setOpened({ id: selectedId, element });
      })
      .catch(() => {
        if (!cancelled) setOpened({ id: selectedId, element: null });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, source]);

  const open = useCallback((id: string) => setSelectedId(id), []);
  const element =
    opened && opened.id === selectedId ? opened.element : undefined;

  return (
    <div className="flex h-full flex-col">
      {banner && (
        <div className="flex items-center gap-3 border-b border-ember-500/40 bg-ember-500/10 px-4 py-1.5 text-xs text-ember-200">
          <Eye size={13} />
          <span className="flex-1">{banner}</span>
          <Button size="sm" variant="ghost" onClick={onExit}>
            <ArrowLeft size={13} /> {exitLabel}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Kinds */}
        <aside className="flex w-[220px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
          <header className="border-b border-ink-800 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Player view
            </div>
            <h1 className="mt-1 truncate font-serif text-lg font-semibold">
              {title}
            </h1>
            {subtitle && <p className="text-xs text-ink-400">{subtitle}</p>}
          </header>
          <nav className="flex-1 overflow-y-auto px-2 py-2">
            <KindRow
              label="Everything"
              count={elements.length}
              active={kindFilter === null}
              onClick={() => setKindFilter(null)}
            />
            {ELEMENT_FAMILIES.map((family) => {
              const kinds = ELEMENT_KINDS.filter(
                (k) => k.family === family.id && (counts.get(k.id) ?? 0) > 0,
              );
              if (kinds.length === 0) return null;
              return (
                <div key={family.id} className="mt-3">
                  <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-600">
                    {family.label}
                  </div>
                  {kinds.map((k) => (
                    <KindRow
                      key={k.id}
                      label={k.plural}
                      count={counts.get(k.id) ?? 0}
                      active={kindFilter === k.id}
                      onClick={() => setKindFilter(k.id)}
                    />
                  ))}
                </div>
              );
            })}
          </nav>
          {!banner && (
            <div className="border-t border-ink-800 p-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={onExit}
                className="w-full"
              >
                <ArrowLeft size={13} /> {exitLabel}
              </Button>
            </div>
          )}
        </aside>

        {/* List */}
        <section className="flex w-[300px] shrink-0 flex-col border-r border-ink-800 bg-ink-850">
          <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
            <div className="flex flex-1 items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1">
              <Search size={13} className="text-ink-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="w-full bg-transparent text-sm outline-none placeholder:text-ink-600"
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
          </div>
          <ul className="flex-1 overflow-y-auto py-1">
            {visible.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-ink-500">
                {elements.length === 0
                  ? "Nothing has been shared yet."
                  : "No matches."}
              </li>
            )}
            {visible.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => open(e.id)}
                  className={`w-full px-4 py-2 text-left transition-colors ${
                    e.id === selectedId ? "bg-ink-700/60" : "hover:bg-ink-800"
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
        </section>

        {/* Reader */}
        <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
          {!selectedId ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-ink-500">
              <Eye size={28} className="text-ink-700" />
              <p>
                {elements.length === 0
                  ? "The GM has not shared anything yet."
                  : `${elements.length} shared ${elements.length === 1 ? "thing" : "things"}. Pick one from the list.`}
              </p>
            </div>
          ) : element === undefined ? (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-600">
              Loading…
            </div>
          ) : element === null ? (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
              This is no longer shared.
            </div>
          ) : (
            <PlayerElementView
              key={element.id}
              element={element}
              source={source}
              calendar={calendar}
              onOpen={open}
            />
          )}
        </main>
      </div>
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

/** One shared element, read-only. */
function PlayerElementView({
  element,
  source,
  calendar,
  onOpen,
}: {
  element: Element;
  source: PlayerSource;
  calendar: Calendar;
  onOpen: (id: string) => void;
}) {
  const elements = source.elements;
  const byId = useMemo(
    () => new Map(elements.map((e) => [e.id, e])),
    [elements],
  );
  const mentionedIn = useMemo(
    () => elements.filter((e) => e.links.includes(element.id)),
    [elements, element.id],
  );
  const details = detailsFor(element, byId, calendar);
  const map = element.type === "map" ? readMap(element) : null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-ink-800 px-6 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          {kindById(element.type).label}
        </div>
        <h2 className="mt-0.5 font-serif text-2xl font-semibold text-ink-100">
          {element.name}
        </h2>
        {element.tags.length > 0 && (
          <p className="mt-1 text-xs text-ink-400">{element.tags.join(", ")}</p>
        )}
        {details.length > 0 && (
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            {details.map((d) => (
              <div key={d.label} className="flex gap-1.5">
                <dt className="text-ink-500">{d.label}</dt>
                <dd className="text-ink-200">
                  {d.link ? (
                    <button
                      type="button"
                      onClick={() => onOpen(d.link!)}
                      className="text-ember-300 hover:underline"
                    >
                      {d.value}
                    </button>
                  ) : (
                    d.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {map && (
            <>
              <PlayerMap
                data={map}
                elements={elements}
                readAsset={source.readAsset}
                onOpen={onOpen}
              />
              {map.pins.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {map.pins.map((p) => {
                    const linked = p.element ? byId.get(p.element) : undefined;
                    const label = p.label.trim() || linked?.name || "Pin";
                    return linked ? (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => onOpen(linked.id)}
                          className="element-chip"
                        >
                          {label}
                        </button>
                      </li>
                    ) : (
                      <li
                        key={p.id}
                        className="rounded-full border border-ink-800 px-2 py-0.5 text-[11px] text-ink-400"
                      >
                        {label}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {element.body.trim() ? (
            <div className="chat-md text-[15px] text-ink-200">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => {
                    const id = elementIdFromHref(href);
                    if (id) {
                      return byId.has(id) ? (
                        <button
                          type="button"
                          onClick={() => onOpen(id)}
                          className="element-chip"
                        >
                          {children}
                        </button>
                      ) : (
                        <span>{children}</span>
                      );
                    }
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) void openUrl(href);
                        }}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {element.body}
              </ReactMarkdown>
            </div>
          ) : (
            !map && (
              <p className="text-sm text-ink-600">Nothing written here yet.</p>
            )
          )}

          {mentionedIn.length > 0 && (
            <section>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Mentioned in
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {mentionedIn.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(e.id)}
                      className="element-chip"
                    >
                      {displayName(e)}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

interface Detail {
  label: string;
  value: string;
  link?: string;
}

/** Kind-specific facts worth a line under the title. */
function detailsFor(
  element: Element,
  byId: Map<string, ElementSummary>,
  calendar: Calendar,
): Detail[] {
  const out: Detail[] = [];
  switch (element.type) {
    case "session": {
      const s = readSession(element);
      if (s.number !== null) {
        out.push({ label: "Session", value: String(s.number) });
      }
      if (s.date) out.push({ label: "Played", value: formatIsoDate(s.date) });
      out.push({ label: "Status", value: s.status });
      const arc = s.arc ? byId.get(s.arc) : undefined;
      if (arc) out.push({ label: "Arc", value: arc.name, link: arc.id });
      const world = readWorldDate(element.worldDate);
      if (world) {
        out.push({
          label: "In-world",
          value: formatWorldDate(calendar, world),
        });
      }
      break;
    }
    case "arc":
      out.push({ label: "Status", value: readArc(element).status });
      break;
    case "event": {
      const when = readWorldDate(element.when);
      const until = readWorldDate(element.until);
      if (when)
        out.push({ label: "When", value: formatWorldDate(calendar, when) });
      if (when && until && compareDates(calendar, until, when) > 0) {
        out.push({ label: "Until", value: formatWorldDate(calendar, until) });
      }
      break;
    }
    case "journal": {
      const j = readJournal(element);
      if (j.date) out.push({ label: "Written", value: formatIsoDate(j.date) });
      if (j.worldDate) {
        out.push({
          label: "In-world",
          value: formatWorldDate(calendar, j.worldDate),
        });
      }
      if (j.scope.type !== "campaign") {
        out.push({
          label: "About",
          value: scopeLabel(j.scope, Array.from(byId.values())),
          link: byId.has(j.scope.id) ? j.scope.id : undefined,
        });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
