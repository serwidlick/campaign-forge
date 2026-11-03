import { Plus, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import {
  bySessionNumber,
  displayName,
} from "@/features/sessions/session-model";
import { kindById, type ElementKind, type ElementSummary } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import { WHEEL, type WheelNode } from "./wheel";

const SIZE = 440;
const CENTER = SIZE / 2;
const RING = 165;
const NODE = 76;
const HUB = 92;

function nodePosition(index: number): { x: number; y: number } {
  // Six spokes, first one straight up, clockwise.
  const angle = -Math.PI / 2 + (index * Math.PI) / 3;
  return {
    x: CENTER + RING * Math.cos(angle),
    y: CENTER + RING * Math.sin(angle),
  };
}

/**
 * The "Everything" view: a wheel of the campaign's concerns with a hub in the
 * middle, and below it every element of the chosen spoke (or of all spokes),
 * one click away.
 */
export function OverviewPanel({
  onNew,
}: {
  /** Start creating an element of this kind. */
  onNew: (kind: string) => void;
}) {
  const campaign = useCampaignStore((s) => s.campaign);
  const elements = useCampaignStore((s) => s.elements);
  const navigate = useCampaignStore((s) => s.navigate);

  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const byKind = useMemo(() => {
    const map = new Map<string, ElementSummary[]>();
    for (const e of elements) {
      const list = map.get(e.type) ?? [];
      list.push(e);
      map.set(e.type, list);
    }
    for (const [kind, list] of map) {
      list.sort(
        kind === "session"
          ? bySessionNumber
          : (a, b) => a.name.localeCompare(b.name),
      );
    }
    return map;
  }, [elements]);

  const countOf = (node: WheelNode) =>
    node.kinds.reduce((n, k) => n + (byKind.get(k)?.length ?? 0), 0);

  // Kinds the campaign uses that no spoke claims still get a home, under Story.
  const extraKinds = useMemo(
    () =>
      Array.from(byKind.keys()).filter(
        (k) => !WHEEL.some((n) => n.kinds.includes(k)),
      ),
    [byKind],
  );

  if (!campaign) return null;

  const shown = active ? WHEEL.filter((n) => n.id === active) : WHEEL;
  const lit = hover ?? active;

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-4xl">
        {/* ---- Wheel ---------------------------------------------------- */}
        <div
          className="relative mx-auto select-none"
          style={{ width: SIZE, height: SIZE }}
        >
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="absolute inset-0"
            aria-hidden
          >
            {WHEEL.map((node, i) => {
              const a = nodePosition(i);
              const b = nodePosition((i + 1) % WHEEL.length);
              const next = WHEEL[(i + 1) % WHEEL.length];
              const spokeLit = lit === node.id;
              const edgeLit = lit === node.id || lit === next?.id;
              return (
                <g key={node.id}>
                  <line
                    x1={CENTER}
                    y1={CENTER}
                    x2={a.x}
                    y2={a.y}
                    stroke={spokeLit ? node.color : "var(--color-ink-700)"}
                    strokeOpacity={spokeLit ? 0.9 : 1}
                    strokeWidth={spokeLit ? 2 : 1}
                  />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      edgeLit ? "var(--color-ink-500)" : "var(--color-ink-800)"
                    }
                    strokeWidth={1}
                  />
                </g>
              );
            })}
          </svg>

          {/* Hub */}
          <button
            type="button"
            onClick={() => setActive(null)}
            onMouseEnter={() => setHover(null)}
            title="Show everything"
            aria-pressed={active === null}
            className={`absolute flex flex-col items-center justify-center rounded-full border-2 bg-ink-900 text-ink-100 transition-all ${
              active === null
                ? "border-ink-100 shadow-[0_0_0_6px_rgba(236,238,242,0.08)]"
                : "border-ink-600 hover:border-ink-300"
            }`}
            style={{
              width: HUB,
              height: HUB,
              left: CENTER - HUB / 2,
              top: CENTER - HUB / 2,
            }}
          >
            <Sparkles size={22} className="text-ink-200" />
            <span className="mt-1 max-w-[80px] truncate px-1 text-[11px] font-medium">
              {campaign.name}
            </span>
            <span className="text-[10px] text-ink-500">{elements.length}</span>
          </button>

          {/* Spokes */}
          {WHEEL.map((node, i) => {
            const p = nodePosition(i);
            const Icon = node.icon;
            const isActive = active === node.id;
            const count = countOf(node);
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => setActive(isActive ? null : node.id)}
                onMouseEnter={() => setHover(node.id)}
                onMouseLeave={() => setHover(null)}
                aria-pressed={isActive}
                title={`${node.label}: ${count}`}
                className="absolute flex flex-col items-center justify-center rounded-full border-2 bg-ink-900 transition-transform hover:scale-105"
                style={{
                  width: NODE,
                  height: NODE,
                  left: p.x - NODE / 2,
                  top: p.y - NODE / 2,
                  borderColor: node.color,
                  boxShadow: isActive
                    ? `0 0 0 5px ${node.color}33, 0 0 24px ${node.color}55`
                    : `0 0 0 0 transparent`,
                }}
              >
                <Icon size={20} style={{ color: node.color }} />
                <span className="mt-0.5 text-[11px] font-medium text-ink-100">
                  {node.label}
                </span>
                <span className="text-[10px] text-ink-500">{count}</span>
              </button>
            );
          })}
        </div>

        <p className="mt-2 mb-8 text-center text-xs text-ink-600">
          {active
            ? `Showing ${WHEEL.find((n) => n.id === active)?.label.toLowerCase()}. Click the hub to show everything.`
            : "Click a spoke to focus on it. Ctrl+click any item to open it beside the current one."}
        </p>

        {/* ---- Sections ------------------------------------------------- */}
        {shown.map((node) => (
          <NodeSection
            key={node.id}
            node={node}
            kinds={[
              ...node.kinds.map(kindById),
              ...(node.id === "story" ? extraKinds.map(kindById) : []),
            ]}
            byKind={byKind}
            onOpen={(id, pane) => void navigate(id, { pane })}
            onNew={onNew}
          />
        ))}
      </div>
    </div>
  );
}

function NodeSection({
  node,
  kinds,
  byKind,
  onOpen,
  onNew,
}: {
  node: WheelNode;
  kinds: ElementKind[];
  byKind: Map<string, ElementSummary[]>;
  onOpen: (id: string, pane: boolean) => void;
  onNew: (kind: string) => void;
}) {
  const Icon = node.icon;
  const total = kinds.reduce((n, k) => n + (byKind.get(k.id)?.length ?? 0), 0);
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-center gap-2 border-b border-ink-800 pb-2">
        <Icon size={14} style={{ color: node.color }} />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
          {node.label}
        </h2>
        <span className="text-[11px] text-ink-600">{total}</span>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {kinds.map((kind) => {
          const items = byKind.get(kind.id) ?? [];
          return (
            <div key={kind.id}>
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="text-sm font-medium text-ink-200">
                  {kind.plural}
                </h3>
                <span className="text-[11px] text-ink-600">{items.length}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onNew(kind.id)}
                  title={`New ${kind.label.toLowerCase()}`}
                  aria-label={`New ${kind.label.toLowerCase()}`}
                  className="rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
                >
                  <Plus size={13} />
                </button>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-ink-700">None yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {items.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={(ev) => onOpen(e.id, ev.ctrlKey || ev.metaKey)}
                        title={
                          e.tags.length
                            ? `${e.tags.join(", ")} · Ctrl+click opens beside`
                            : "Ctrl+click opens beside"
                        }
                        className="rounded-md bg-ink-850 px-2.5 py-1 text-xs text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-100"
                        style={{ boxShadow: `inset 2px 0 0 ${node.color}66` }}
                      >
                        {displayName(e)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
