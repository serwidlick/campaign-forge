import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { Focus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { WHEEL, spokeForKind } from "@/features/bible/wheel";
import { readMap } from "@/features/map/map-model";
import { displayName } from "@/features/sessions/session-model";
import { kindById, type ElementSummary } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

/** How two elements are connected. */
type EdgeKind = "link" | "arc" | "pin";

interface GraphNode extends SimulationNodeDatum {
  id: string;
  element: ElementSummary;
  degree: number;
  color: string;
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  kind: EdgeKind;
}

const EDGE_STYLE: Record<EdgeKind, { dash?: string; label: string }> = {
  link: { label: "@ link" },
  arc: { dash: "6 4", label: "session in arc" },
  pin: { dash: "2 4", label: "pinned on map" },
};

/** Builds nodes and deduplicated undirected edges from the campaign. */
function buildGraph(elements: ElementSummary[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const ids = new Set(elements.map((e) => e.id));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();

  const add = (a: string, b: string, kind: EdgeKind) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: a, target: b, kind });
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  };

  for (const e of elements) {
    for (const target of e.links) add(e.id, target, "link");
    if (e.type === "session" && typeof e.arc === "string") {
      add(e.id, e.arc, "arc");
    }
    if (e.type === "map") {
      for (const pin of readMap(e).pins) {
        if (pin.element) add(e.id, pin.element, "pin");
      }
    }
  }

  const nodes: GraphNode[] = elements.map((e) => ({
    id: e.id,
    element: e,
    degree: degree.get(e.id) ?? 0,
    color: spokeForKind(e.type).color,
  }));
  return { nodes, edges };
}

function radiusOf(node: GraphNode): number {
  return 6 + Math.min(10, node.degree * 1.5);
}

/**
 * A force-directed graph of every element and how they connect. Drag nodes to
 * untangle, scroll to zoom, drag the background to pan, hover to see a node's
 * neighbourhood, click to open.
 */
export function GraphPanel() {
  const elements = useCampaignStore((s) => s.elements);
  const selectedId = useCampaignStore((s) => s.selectedId);
  const navigate = useCampaignStore((s) => s.navigate);

  const [showOrphans, setShowOrphans] = useState(true);
  const [spokes, setSpokes] = useState<Set<string>>(
    () => new Set(WHEEL.map((n) => n.id)),
  );
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [layout, setLayout] = useState<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  }>({
    nodes: [],
    edges: [],
  });
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });

  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<GraphNode, GraphEdge> | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const dragRef = useRef<{
    node: GraphNode | null;
    panStart: { x: number; y: number; tx: number; ty: number } | null;
  }>({ node: null, panStart: null });

  // Filtered graph.
  const graph = useMemo(() => {
    const visibleKinds = new Set(
      WHEEL.filter((n) => spokes.has(n.id)).flatMap((n) => n.kinds),
    );
    const full = buildGraph(
      elements.filter(
        (e) =>
          visibleKinds.has(e.type) ||
          !WHEEL.some((n) => n.kinds.includes(e.type)),
      ),
    );
    const nodes = showOrphans
      ? full.nodes
      : full.nodes.filter((n) => n.degree > 0);
    return { nodes, edges: full.edges };
  }, [elements, spokes, showOrphans]);

  // (Re)start the simulation when the graph changes. Positions of nodes that
  // survive the change are carried over so the layout does not jump.
  useEffect(() => {
    const el = containerRef.current;
    const width = el?.clientWidth ?? 800;
    const height = el?.clientHeight ?? 600;
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes = graph.nodes.map((n) => {
      const old = previous.get(n.id);
      return old ? { ...n, x: old.x, y: old.y, vx: 0, vy: 0 } : n;
    });
    const edges = graph.edges.map((e) => ({ ...e }));
    nodesRef.current = nodes;
    edgesRef.current = edges;

    simRef.current?.stop();
    const sim = forceSimulation<GraphNode, GraphEdge>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphEdge>(edges)
          .id((d) => d.id)
          .distance(70)
          .strength(0.6),
      )
      .force("charge", forceManyBody<GraphNode>().strength(-220))
      .force("center", forceCenter(width / 2, height / 2))
      .force(
        "collide",
        forceCollide<GraphNode>().radius((d) => radiusOf(d) + 14),
      )
      .alphaDecay(0.03)
      .on("tick", () => setLayout({ nodes: [...nodes], edges }));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [graph]);

  // ---- Interaction --------------------------------------------------------
  const toGraphPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const x = clientX - (rect?.left ?? 0);
      const y = clientY - (rect?.top ?? 0);
      return {
        x: (x - transform.x) / transform.k,
        y: (y - transform.y) / transform.k,
      };
    },
    [transform],
  );

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setTransform((t) => {
      const k = Math.min(4, Math.max(0.2, t.k * factor));
      // Zoom around the cursor.
      const x = px - ((px - t.x) * k) / t.k;
      const y = py - ((py - t.y) * k) / t.k;
      return { x, y, k };
    });
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    dragRef.current.panStart = {
      x: e.clientX,
      y: e.clientY,
      tx: transform.x,
      ty: transform.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onNodePointerDown(e: React.PointerEvent, node: GraphNode) {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current.node = node;
    node.fx = node.x;
    node.fy = node.y;
    simRef.current?.alphaTarget(0.3).restart();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (d.node) {
      const p = toGraphPoint(e.clientX, e.clientY);
      d.node.fx = p.x;
      d.node.fy = p.y;
    } else if (d.panStart) {
      setTransform((t) => ({
        ...t,
        x: d.panStart!.tx + (e.clientX - d.panStart!.x),
        y: d.panStart!.ty + (e.clientY - d.panStart!.y),
      }));
    }
  }

  // Distinguish click from drag on nodes.
  const dragMoved = useRef(false);

  function onPointerUp(e: React.PointerEvent, node?: GraphNode) {
    const d = dragRef.current;
    if (d.node) {
      // The node stays pinned where it was dropped; a plain click opens it.
      simRef.current?.alphaTarget(0);
      const clicked = node && d.node.id === node.id && !dragMoved.current;
      d.node = null;
      if (clicked && node) {
        void navigate(node.id, { pane: e.ctrlKey || e.metaKey });
      }
    }
    d.panStart = null;
    dragMoved.current = false;
  }
  function onNodePointerMove(e: React.PointerEvent) {
    if (dragRef.current.node && (e.movementX !== 0 || e.movementY !== 0)) {
      dragMoved.current = true;
    }
  }

  function fitToView() {
    const nodes = nodesRef.current;
    const el = containerRef.current;
    if (!el || nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x ?? 0);
      minY = Math.min(minY, n.y ?? 0);
      maxX = Math.max(maxX, n.x ?? 0);
      maxY = Math.max(maxY, n.y ?? 0);
    }
    const pad = 60;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const k = Math.min(
      4,
      Math.max(0.2, Math.min(el.clientWidth / w, el.clientHeight / h)),
    );
    setTransform({
      k,
      x: el.clientWidth / 2 - ((minX + maxX) / 2) * k,
      y: el.clientHeight / 2 - ((minY + maxY) / 2) * k,
    });
  }

  // ---- Derived for render ---------------------------------------------------
  const { nodes, edges } = layout;
  const q = query.trim().toLowerCase();
  const matches = q
    ? new Set(
        nodes
          .filter((n) => n.element.name.toLowerCase().includes(q))
          .map((n) => n.id),
      )
    : null;
  const focus = hover ?? selectedId;
  const neighbours = new Set<string>();
  if (focus) {
    for (const e of edges) {
      const s = typeof e.source === "object" ? e.source.id : String(e.source);
      const t = typeof e.target === "object" ? e.target.id : String(e.target);
      if (s === focus) neighbours.add(t);
      if (t === focus) neighbours.add(s);
    }
  }
  const dim = (id: string) =>
    (focus && id !== focus && !neighbours.has(id)) ||
    (matches && !matches.has(id));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2 text-xs">
        {WHEEL.map((n) => {
          const on = spokes.has(n.id);
          return (
            <button
              key={n.id}
              type="button"
              onClick={() =>
                setSpokes((s) => {
                  const next = new Set(s);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                })
              }
              aria-pressed={on}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
                on ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:bg-ink-850"
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: n.color, opacity: on ? 1 : 0.35 }}
              />
              {n.label}
            </button>
          );
        })}
        <label className="ml-2 flex items-center gap-1.5 text-ink-400">
          <input
            type="checkbox"
            checked={showOrphans}
            onChange={(e) => setShowOrphans(e.target.checked)}
            className="accent-ember-500"
          />
          Unconnected
        </label>
        <span className="flex-1" />
        <div className="flex items-center gap-2 rounded-md bg-ink-900 px-2 py-1">
          <Search size={13} className="text-ink-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Highlight…"
            className="w-32 bg-transparent text-xs text-ink-100 outline-none placeholder:text-ink-600"
          />
        </div>
        <button
          type="button"
          onClick={fitToView}
          title="Fit to view"
          aria-label="Fit to view"
          className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-200"
        >
          <Focus size={14} />
        </button>
        <span className="text-ink-600">
          {nodes.length} nodes · {edges.length} links
        </span>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 cursor-grab overflow-hidden bg-ink-950 active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onPointerLeave={(e) => onPointerUp(e)}
      >
        {nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-600">
            Nothing to show. Link elements with @ and they appear here.
          </div>
        ) : (
          <svg className="h-full w-full">
            <g
              transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}
            >
              {edges.map((e, i) => {
                const s = e.source as GraphNode;
                const t = e.target as GraphNode;
                if (typeof s !== "object" || typeof t !== "object") return null;
                const faded = dim(s.id) && dim(t.id);
                const lit = focus && (s.id === focus || t.id === focus);
                return (
                  <line
                    key={i}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={
                      lit ? "var(--color-ember-400)" : "var(--color-ink-600)"
                    }
                    strokeOpacity={faded ? 0.15 : lit ? 0.9 : 0.6}
                    strokeWidth={lit ? 1.8 / transform.k : 1 / transform.k}
                    strokeDasharray={EDGE_STYLE[e.kind].dash}
                  >
                    <title>{EDGE_STYLE[e.kind].label}</title>
                  </line>
                );
              })}
              {nodes.map((n) => {
                const r = radiusOf(n);
                const faded = dim(n.id);
                const isFocus = n.id === focus;
                const showLabel =
                  transform.k > 0.7 ||
                  isFocus ||
                  neighbours.has(n.id) ||
                  n.degree >= 3;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x ?? 0} ${n.y ?? 0})`}
                    opacity={faded ? 0.25 : 1}
                    className="cursor-pointer"
                    onPointerDown={(e) => onNodePointerDown(e, n)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={(e) => onPointerUp(e, n)}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <circle
                      r={r}
                      fill={n.color}
                      fillOpacity={isFocus ? 1 : 0.85}
                      stroke={isFocus ? "#ffffff" : "var(--color-ink-950)"}
                      strokeWidth={
                        isFocus ? 2.5 / transform.k : 1.5 / transform.k
                      }
                    />
                    {showLabel && (
                      <text
                        y={r + 11 / transform.k}
                        textAnchor="middle"
                        fontSize={11 / transform.k}
                        fill="var(--color-ink-200)"
                        stroke="var(--color-ink-950)"
                        strokeWidth={3 / transform.k}
                        paintOrder="stroke"
                        style={{ pointerEvents: "none" }}
                      >
                        {displayName(n.element)}
                      </text>
                    )}
                    <title>
                      {`${n.element.name} · ${kindById(n.element.type).label} · ${n.degree} link${n.degree === 1 ? "" : "s"}`}
                    </title>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-ink-600">
          Drag nodes · drag background to pan · scroll to zoom · click to open ·
          Ctrl+click opens beside
        </div>
      </div>
    </div>
  );
}
