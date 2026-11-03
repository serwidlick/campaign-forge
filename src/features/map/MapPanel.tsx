import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  CornerLeftUp,
  Hand,
  ImagePlus,
  LandPlot,
  Layers,
  Lock,
  LockOpen,
  MapPin,
  Route as RouteIcon,
  Ruler,
  Scaling,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/Button";
import { errorMessage, storage } from "@/lib/tauri";
import { kindById, type Element, type ElementSummary } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  FIT_MODES,
  PIN_LINK_KIND_ORDER,
  ROUTE_COLORS,
  TERRITORY_COLORS,
  TERRITORY_LINK_KIND_ORDER,
  TRAVEL_MODES,
  fitZoom,
  formatArea,
  formatDistance,
  formatTravelTime,
  imageUrlFromDrag,
  isImagePath,
  newId,
  parentMapsOf,
  pathPixelLength,
  pinName,
  pixelDistance,
  polygonPixelArea,
  readMap,
  routeColor,
  routeSubPath,
  snapToRoute,
  subMapsOf,
  territoryColor,
  territoryName,
  toArea,
  toDistance,
  type FitMode,
  type MapData,
  type MapPin as Pin,
  type MapRoute,
  type MapScale,
  type MapTerritory,
  type Point,
  type RouteSnap,
  type SubMapRef,
} from "./map-model";

type Tool = "pan" | "pin" | "route" | "territory" | "measure" | "scale";
type MeasureMode = "crow" | "route";

const MAP_HEIGHT = 520;

/**
 * Image map with pins, routes, territories, a calibrated scale and a
 * measuring tool. A pin or territory linked to another map nests it.
 * Leaflet runs in CRS.Simple so coordinates are image pixels; we flip y so
 * stored points use a top-left origin like any image editor would.
 */
export function MapPanel({ element }: { element: Element }) {
  const elements = useCampaignStore((s) => s.elements);
  const saveElement = useCampaignStore((s) => s.saveElement);
  const navigate = useCampaignStore((s) => s.navigate);
  const refreshElements = useCampaignStore((s) => s.refreshElements);
  const setError = useCampaignStore((s) => s.setError);

  const data = useMemo(() => readMap(element), [element]);
  const parents = useMemo(
    () => parentMapsOf(element.id, elements),
    [element.id, elements],
  );
  const subMaps = useMemo(() => subMapsOf(data, elements), [data, elements]);

  const [tool, setTool] = useState<Tool>("pan");
  const [locked, setLocked] = useState(false);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [routeDraft, setRouteDraft] = useState<Point[]>([]);
  const [routeNaming, setRouteNaming] = useState<string | null>(null);
  const [selectedTerritoryId, setSelectedTerritoryId] = useState<string | null>(
    null,
  );
  const [territoryDraft, setTerritoryDraft] = useState<Point[]>([]);
  const [territoryNaming, setTerritoryNaming] = useState<{
    name: string;
    element: string | null;
  } | null>(null);
  const [measureMode, setMeasureMode] = useState<MeasureMode>("crow");
  const [measureRouteId, setMeasureRouteId] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Point[]>([]);
  const [scalePoints, setScalePoints] = useState<Point[]>([]);
  const [scaleDraft, setScaleDraft] = useState<{
    distance: string;
    unit: string;
  } | null>(null);
  const [dropHint, setDropHint] = useState(false);
  const [importing, setImporting] = useState(false);
  // Blob URL for the current image, keyed by its path so a stale URL is never
  // shown for a replaced image.
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(
    null,
  );
  const imageUrl = loaded && loaded.path === data.image ? loaded.url : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.ImageOverlay | null>(null);
  const pinsLayerRef = useRef<L.LayerGroup>(L.layerGroup());
  const territoriesLayerRef = useRef<L.LayerGroup>(L.layerGroup());
  const routesLayerRef = useRef<L.LayerGroup>(L.layerGroup());
  const drawLayerRef = useRef<L.LayerGroup>(L.layerGroup());
  // Mirrors for Leaflet handlers, which would otherwise close over stale state.
  const toolRef = useRef<Tool>("pan");
  const dataRef = useRef<MapData>(data);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const height = data.height ?? 0;
  const toLatLng = useCallback(
    (p: Point): L.LatLngExpression => [height - p.y, p.x],
    [height],
  );
  const fromLatLng = useCallback(
    (ll: L.LatLng): Point => ({
      x: Math.round(ll.lng),
      y: Math.round(height - ll.lat),
    }),
    [height],
  );

  const persist = useCallback(
    (patch: Record<string, unknown>) => void saveElement(element.id, patch),
    [saveElement, element.id],
  );

  // ---- Image bytes -> blob URL -----------------------------------------
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const path = data.image;
    if (path) {
      storage
        .readAsset(path)
        .then((buf) => {
          if (cancelled) return;
          url = URL.createObjectURL(new Blob([buf]));
          setLoaded({ path, url });
        })
        .catch((err) => setError(errorMessage(err)));
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data.image, setError]);

  // ---- Create the Leaflet map once -------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      crs: L.CRS.Simple,
      minZoom: -8,
      maxZoom: 4,
      zoomSnap: 0.1,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 120,
      attributionControl: false,
      doubleClickZoom: false,
      // Solid bounds: the view stops at maxBounds instead of bouncing back.
      maxBoundsViscosity: 1,
    });
    territoriesLayerRef.current.addTo(map);
    routesLayerRef.current.addTo(map);
    pinsLayerRef.current.addTo(map);
    drawLayerRef.current.addTo(map);
    mapRef.current = map;

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- Framing ----------------------------------------------------------
  const applyFit = useCallback(
    (mode: FitMode) => {
      const map = mapRef.current;
      const el = containerRef.current;
      if (!map || !el || !data.width || !data.height) return;
      const zoom = fitZoom(
        mode,
        el.clientWidth,
        el.clientHeight,
        data.width,
        data.height,
      );
      const containZoom = fitZoom(
        "contain",
        el.clientWidth,
        el.clientHeight,
        data.width,
        data.height,
      );
      map.setMinZoom(Math.min(zoom, containZoom) - 1);
      map.setView([data.height / 2, data.width / 2], zoom, { animate: false });
    },
    [data.width, data.height],
  );

  // Swap the overlay when the image changes, then frame it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    overlayRef.current?.remove();
    overlayRef.current = null;
    if (!imageUrl || !data.width || !data.height) return;
    const bounds = L.latLngBounds([0, 0], [data.height, data.width]);
    overlayRef.current = L.imageOverlay(imageUrl, bounds).addTo(map);
    applyFit(data.fit);
  }, [imageUrl, data.width, data.height, data.fit, applyFit]);

  // ---- Lock: the image can never leave the frame -----------------------
  // Locked, the pan limit is the image itself: when the whole image is in
  // view there is nothing to pan, and when zoomed in you can pan only as far
  // as its edges. Unlocked, there is slack around the image. Zoom is never
  // affected either way.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data.width || !data.height) return;
    const bounds = L.latLngBounds([0, 0], [data.height, data.width]);
    map.setMaxBounds(locked ? bounds : bounds.pad(0.75));
  }, [locked, data.width, data.height, imageUrl]);

  // ---- Clicks per tool --------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      const p = fromLatLng(e.latlng);
      switch (toolRef.current) {
        case "pin": {
          const pin: Pin = {
            id: newId(),
            x: p.x,
            y: p.y,
            label: "",
            element: null,
          };
          persist({ pins: [...dataRef.current.pins, pin] });
          setSelectedPinId(pin.id);
          setTool("pan");
          break;
        }
        case "route":
          setRouteDraft((pts) => [...pts, p]);
          break;
        case "territory":
          setTerritoryDraft((pts) => [...pts, p]);
          break;
        case "measure":
          // Two points: a third click starts a new measurement.
          setMeasure((pts) => (pts.length >= 2 ? [p] : [...pts, p]));
          break;
        case "scale":
          setScalePoints((pts) => {
            const next = [...pts, p].slice(-2);
            if (next.length === 2) {
              setScaleDraft({
                distance: "",
                unit: dataRef.current.scale?.unit ?? "miles",
              });
            }
            return next;
          });
          break;
        default:
          setSelectedPinId(null);
          setSelectedRouteId(null);
          setSelectedTerritoryId(null);
      }
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [fromLatLng, persist]);

  useEffect(() => {
    containerRef.current?.classList.toggle("cf-tool-active", tool !== "pan");
  }, [tool]);

  const cancelTool = useCallback(() => {
    setTool("pan");
    setMeasure([]);
    setScalePoints([]);
    setScaleDraft(null);
    setRouteDraft([]);
    setRouteNaming(null);
    setTerritoryDraft([]);
    setTerritoryNaming(null);
  }, []);

  // Escape cancels; Enter finishes a route or territory being drawn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Escape") cancelTool();
      if (e.key === "Enter" && toolRef.current === "route") {
        setRouteDraft((pts) => {
          if (pts.length >= 2) setRouteNaming("");
          return pts;
        });
      }
      if (e.key === "Enter" && toolRef.current === "territory") {
        setTerritoryDraft((pts) => {
          if (pts.length >= 3) setTerritoryNaming({ name: "", element: null });
          return pts;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelTool]);

  // ---- Drag and drop ----------------------------------------------------
  const importFromPath = useCallback(
    async (path: string) => {
      setImporting(true);
      try {
        const img = await storage.importMapImage(element.id, path);
        persist({ image: img.path, width: img.width, height: img.height });
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setImporting(false);
      }
    },
    [element.id, persist, setError],
  );

  // Files dragged from the OS arrive through Tauri's native drop events.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          setDropHint(payload.paths.some(isImagePath));
        } else if (payload.type === "leave") {
          setDropHint(false);
        } else if (payload.type === "drop") {
          setDropHint(false);
          const image = payload.paths.find(isImagePath);
          if (image) void importFromPath(image);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not running inside Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importFromPath]);

  // Images dragged from a browser arrive as HTML5 drops with a URL or a File.
  async function handleHtmlDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropHint(false);
    const file = Array.from(e.dataTransfer.files).find((f) =>
      f.type.startsWith("image/"),
    );
    setImporting(true);
    try {
      if (file) {
        const dataBase64 = await fileToBase64(file);
        const img = await storage.importMapImageBytes(element.id, dataBase64);
        persist({ image: img.path, width: img.width, height: img.height });
        return;
      }
      const url = imageUrlFromDrag(e.dataTransfer);
      if (url) {
        const img = await storage.importMapImageFromUrl(element.id, url);
        persist({ image: img.path, width: img.width, height: img.height });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  // ---- Render pins ------------------------------------------------------
  useEffect(() => {
    const layer = pinsLayerRef.current;
    layer.clearLayers();
    for (const pin of data.pins) {
      const linksMap = elements.some(
        (e) => e.id === pin.element && e.type === "map",
      );
      const classes = [
        "cf-pin",
        pin.id === selectedPinId ? "is-selected" : "",
        linksMap ? "is-map" : "",
      ].join(" ");
      const icon = L.divIcon({
        className: "",
        html: `<div class="${classes}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const marker = L.marker(toLatLng(pin), { icon, draggable: true });
      marker.bindTooltip(pinName(pin, elements), {
        permanent: true,
        direction: "top",
        offset: [0, -8],
        className: "cf-pin-label",
      });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        setSelectedPinId(pin.id);
        setSelectedRouteId(null);
        setSelectedTerritoryId(null);
      });
      marker.on("dblclick", (e) => {
        L.DomEvent.stopPropagation(e);
        if (pin.element) void navigate(pin.element, { pane: false });
      });
      marker.on("dragend", () => {
        const p = fromLatLng(marker.getLatLng());
        persist({
          pins: dataRef.current.pins.map((x) =>
            x.id === pin.id ? { ...x, x: p.x, y: p.y } : x,
          ),
        });
      });
      marker.addTo(layer);
    }
  }, [
    data.pins,
    elements,
    selectedPinId,
    toLatLng,
    fromLatLng,
    persist,
    navigate,
  ]);

  // ---- Render saved routes ---------------------------------------------
  useEffect(() => {
    const layer = routesLayerRef.current;
    layer.clearLayers();
    for (const route of data.routes) {
      if (route.points.length < 2) continue;
      const selected = route.id === selectedRouteId;
      const line = L.polyline(route.points.map(toLatLng), {
        color: route.color,
        weight: selected ? 4 : 3,
        opacity: selected ? 1 : 0.8,
      });
      line.bindTooltip(route.name, {
        sticky: true,
        className: "cf-pin-label",
      });
      line.on("click", (e) => {
        if (toolRef.current !== "pan") return;
        L.DomEvent.stopPropagation(e);
        setSelectedRouteId(route.id);
        setSelectedPinId(null);
        setSelectedTerritoryId(null);
      });
      line.addTo(layer);
    }
  }, [data.routes, selectedRouteId, toLatLng]);

  // ---- Render territories --------------------------------------------
  useEffect(() => {
    const layer = territoriesLayerRef.current;
    layer.clearLayers();
    for (const t of data.territories) {
      if (t.points.length < 3) continue;
      const selected = t.id === selectedTerritoryId;
      const poly = L.polygon(t.points.map(toLatLng), {
        color: t.color,
        weight: selected ? 3 : 1.5,
        opacity: selected ? 1 : 0.8,
        fillColor: t.color,
        fillOpacity: selected ? 0.4 : 0.2,
      });
      poly.bindTooltip(territoryName(t, elements), {
        permanent: true,
        direction: "center",
        className: "cf-territory-label",
      });
      poly.on("click", (e) => {
        if (toolRef.current !== "pan") return;
        L.DomEvent.stopPropagation(e);
        setSelectedTerritoryId(t.id);
        setSelectedPinId(null);
        setSelectedRouteId(null);
      });
      poly.on("dblclick", (e) => {
        if (toolRef.current !== "pan" || !t.element) return;
        L.DomEvent.stopPropagation(e);
        void navigate(t.element, { pane: false });
      });
      poly.addTo(layer);
    }
  }, [data.territories, elements, selectedTerritoryId, toLatLng, navigate]);

  // ---- Measurement -----------------------------------------------------
  const measureRoute =
    data.routes.find((r) => r.id === measureRouteId) ?? data.routes[0] ?? null;

  const snaps = useMemo<[RouteSnap, RouteSnap] | null>(() => {
    if (measureMode !== "route" || !measureRoute || measure.length < 2) {
      return null;
    }
    const [a, b] = measure;
    if (!a || !b) return null;
    const s1 = snapToRoute(measureRoute.points, a);
    const s2 = snapToRoute(measureRoute.points, b);
    return s1 && s2 ? [s1, s2] : null;
  }, [measureMode, measureRoute, measure]);

  const measurePx =
    measureMode === "route"
      ? snaps
        ? Math.abs(snaps[0].along - snaps[1].along)
        : 0
      : pathPixelLength(measure);
  const measureDistance = data.scale ? toDistance(measurePx, data.scale) : null;
  const measureLabel =
    measureDistance !== null && data.scale
      ? formatDistance(measureDistance, data.scale.unit)
      : `${Math.round(measurePx)} px`;

  // ---- Render drafts: route being drawn, measurement, scale points -----
  useEffect(() => {
    const layer = drawLayerRef.current;
    layer.clearLayers();

    const dot = (p: Point, color: string, radius = 4) =>
      L.circleMarker(toLatLng(p), {
        radius,
        color,
        weight: 2,
        fillColor: "#0e0f13",
        fillOpacity: 1,
      }).addTo(layer);

    const dashed = (pts: Point[], color: string, label?: string) => {
      if (pts.length < 2) return;
      const line = L.polyline(pts.map(toLatLng), {
        color,
        weight: 2,
        dashArray: "6 4",
      }).addTo(layer);
      const last = pts[pts.length - 1];
      if (label && last) {
        line.bindTooltip(label, {
          permanent: true,
          direction: "right",
          className: "cf-measure-label",
        });
        line.openTooltip(toLatLng(last));
      }
    };

    // Route draft
    const draftColor = routeColor(data.routes.length);
    for (const p of routeDraft) dot(p, draftColor);
    dashed(routeDraft, draftColor);

    // Territory draft: the outline so far, plus a preview of the closed area.
    const tColor = territoryColor(data.territories.length);
    for (const p of territoryDraft) dot(p, tColor);
    dashed(territoryDraft, tColor);
    if (territoryDraft.length >= 3) {
      L.polygon(territoryDraft.map(toLatLng), {
        color: tColor,
        weight: 1,
        dashArray: "4 4",
        fillColor: tColor,
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(layer);
    }

    // Measurement
    if (measureMode === "crow") {
      for (const p of measure) dot(p, "#e69a57");
      dashed(
        measure,
        "#e69a57",
        measure.length >= 2 ? measureLabel : undefined,
      );
    } else {
      for (const p of measure) dot(p, "#e69a57", 3);
      if (snaps && measureRoute) {
        for (const s of snaps) dot(s.point, "#ffffff", 5);
        // Thin leaders from each click to where it snapped on the route.
        const [a, b] = measure;
        if (a) dashed([a, snaps[0].point], "#7d8595");
        if (b) dashed([b, snaps[1].point], "#7d8595");
        const sub = routeSubPath(measureRoute.points, snaps[0], snaps[1]);
        const highlight = L.polyline(sub.map(toLatLng), {
          color: "#ffffff",
          weight: 6,
          opacity: 0.9,
        }).addTo(layer);
        const end = sub[sub.length - 1];
        if (end) {
          highlight.bindTooltip(measureLabel, {
            permanent: true,
            direction: "right",
            className: "cf-measure-label",
          });
          highlight.openTooltip(toLatLng(end));
        }
      }
    }

    // Scale calibration
    for (const p of scalePoints) dot(p, "#7dd3fc");
    dashed(scalePoints, "#7dd3fc");
  }, [
    routeDraft,
    measure,
    measureMode,
    measureLabel,
    snaps,
    measureRoute,
    scalePoints,
    territoryDraft,
    data.routes.length,
    data.territories.length,
    toLatLng,
  ]);

  // ---- Actions ----------------------------------------------------------
  async function handleImport() {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose a map image",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    });
    if (typeof picked === "string") await importFromPath(picked);
  }

  function finishRoute(name: string) {
    if (routeDraft.length < 2) return;
    const route: MapRoute = {
      id: newId(),
      name: name.trim() || `Route ${data.routes.length + 1}`,
      color: routeColor(data.routes.length),
      points: routeDraft,
    };
    persist({ routes: [...data.routes, route] });
    setRouteDraft([]);
    setRouteNaming(null);
    setTool("pan");
    setSelectedRouteId(route.id);
  }

  function updateRoute(id: string, patch: Partial<MapRoute>) {
    persist({
      routes: data.routes.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  }

  function deleteRoute(id: string) {
    persist({ routes: data.routes.filter((r) => r.id !== id) });
    setSelectedRouteId(null);
    if (measureRouteId === id) setMeasureRouteId(null);
  }

  function finishTerritory(name: string, elementId: string | null) {
    if (territoryDraft.length < 3) return;
    const territory: MapTerritory = {
      id: newId(),
      name: name.trim(),
      color: territoryColor(data.territories.length),
      element: elementId,
      points: territoryDraft,
    };
    persist({ territories: [...data.territories, territory] });
    setTerritoryDraft([]);
    setTerritoryNaming(null);
    setTool("pan");
    setSelectedTerritoryId(territory.id);
  }

  function updateTerritory(id: string, patch: Partial<MapTerritory>) {
    persist({
      territories: data.territories.map((t) =>
        t.id === id ? { ...t, ...patch } : t,
      ),
    });
  }

  function deleteTerritory(id: string) {
    persist({ territories: data.territories.filter((t) => t.id !== id) });
    setSelectedTerritoryId(null);
  }

  function zoomTo(points: Point[]) {
    if (points.length === 0) return;
    mapRef.current?.fitBounds(L.latLngBounds(points.map(toLatLng)), {
      padding: [40, 40],
      animate: true,
    });
  }

  /** New map for a pin's place, linked from the pin, then opened. */
  async function createSubMap(pin: Pin) {
    const name = pin.label.trim() || `${element.name} · detail`;
    try {
      const created = await storage.createElement("map", name, {});
      await saveElement(element.id, {
        pins: dataRef.current.pins.map((p) =>
          p.id === pin.id ? { ...p, element: created.id } : p,
        ),
      });
      await refreshElements();
      await navigate(created.id, { pane: false });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function applyScale() {
    const [a, b] = scalePoints;
    const distance = Number(scaleDraft?.distance);
    if (
      !a ||
      !b ||
      !scaleDraft ||
      !Number.isFinite(distance) ||
      distance <= 0
    ) {
      return;
    }
    const scale: MapScale = {
      pixels: Math.round(pixelDistance(a, b)),
      distance,
      unit: scaleDraft.unit.trim() || "miles",
    };
    persist({ scale });
    setScalePoints([]);
    setScaleDraft(null);
    setTool("pan");
  }

  function pickTool(next: Tool) {
    cancelTool();
    setTool(next === tool ? "pan" : next);
  }

  const selectedPin = data.pins.find((p) => p.id === selectedPinId) ?? null;
  const selectedRoute =
    data.routes.find((r) => r.id === selectedRouteId) ?? null;
  const selectedTerritory =
    data.territories.find((t) => t.id === selectedTerritoryId) ?? null;

  const hint =
    tool === "pin"
      ? "Click the map to place a pin"
      : tool === "route"
        ? "Click to add points · Enter or Finish when done"
        : tool === "territory"
          ? "Click around the area · Enter or Finish when done"
          : tool === "measure"
            ? measureMode === "crow"
              ? "Click a start and an end point"
              : data.routes.length === 0
                ? "Draw a route first"
                : "Click two points near the route"
            : tool === "scale"
              ? "Click two points a known distance apart"
              : null;

  // ---- UI ----------------------------------------------------------------
  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/60">
      <MapNesting
        parents={parents}
        subMaps={subMaps}
        onOpen={(id, pane) => void navigate(id, { pane })}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-ink-800 px-2 py-1.5">
        <ToolButton
          active={tool === "pan"}
          onClick={() => pickTool("pan")}
          label="Pan"
        >
          <Hand size={14} />
        </ToolButton>
        <ToolButton
          active={tool === "pin"}
          onClick={() => pickTool("pin")}
          label="Add pin"
          disabled={!data.image}
        >
          <MapPin size={14} />
        </ToolButton>
        <ToolButton
          active={tool === "route"}
          onClick={() => pickTool("route")}
          label="Draw route"
          disabled={!data.image}
        >
          <RouteIcon size={14} />
        </ToolButton>
        <ToolButton
          active={tool === "territory"}
          onClick={() => pickTool("territory")}
          label="Draw territory"
          disabled={!data.image}
        >
          <LandPlot size={14} />
        </ToolButton>
        <ToolButton
          active={tool === "measure"}
          onClick={() => pickTool("measure")}
          label="Measure"
          disabled={!data.image}
        >
          <Ruler size={14} />
        </ToolButton>
        <ToolButton
          active={tool === "scale"}
          onClick={() => pickTool("scale")}
          label="Set scale"
          disabled={!data.image}
        >
          <Scaling size={14} />
        </ToolButton>

        <span className="mx-1 h-4 w-px bg-ink-800" />

        <ToolButton
          active={locked}
          onClick={() => setLocked((v) => !v)}
          label={
            locked
              ? "Unlock: allow panning past the image edges"
              : "Lock: keep the image in frame (pan only when zoomed in)"
          }
          disabled={!data.image}
        >
          {locked ? <Lock size={14} /> : <LockOpen size={14} />}
        </ToolButton>

        <select
          value={data.fit}
          onChange={(e) => {
            const fit = e.target.value as FitMode;
            persist({ fit });
            applyFit(fit);
          }}
          disabled={!data.image}
          title="How the image is framed"
          className="rounded-md border border-ink-700 bg-ink-900 px-1.5 py-1 text-xs text-ink-200 outline-none disabled:opacity-40"
        >
          {FIT_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>

        <span className="ml-2 text-[11px] text-ink-500">
          {hint ??
            (data.scale
              ? `Scale: ${data.scale.pixels} px = ${formatDistance(data.scale.distance, data.scale.unit)}`
              : data.image
                ? "No scale set"
                : "")}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleImport()}
          disabled={importing}
        >
          <ImagePlus size={14} />{" "}
          {importing
            ? "Importing…"
            : data.image
              ? "Replace image"
              : "Import image"}
        </Button>
      </div>

      {/* Map */}
      <div
        className="relative"
        style={{ height: MAP_HEIGHT }}
        onDragOver={(e) => {
          e.preventDefault();
          setDropHint(true);
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={(e) => void handleHtmlDrop(e)}
      >
        <div ref={containerRef} className="h-full w-full" />
        {!data.image && !dropHint && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm text-ink-600">
            <span>Import an image to start this map.</span>
            <span className="text-xs text-ink-700">
              You can also drop an image here from Explorer or a browser.
            </span>
          </div>
        )}
        {dropHint && (
          <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center border-2 border-dashed border-ember-500 bg-ink-950/70 text-sm text-ember-200">
            Drop to {data.image ? "replace" : "set"} the map image
          </div>
        )}
      </div>

      {/* Route drawing */}
      {tool === "route" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (routeNaming === null) {
              if (routeDraft.length >= 2) setRouteNaming("");
            } else {
              finishRoute(routeNaming);
            }
          }}
          className="flex items-center gap-2 border-t border-ink-800 px-3 py-2 text-xs"
        >
          {routeNaming === null ? (
            <>
              <span className="text-ink-400">
                {routeDraft.length} point{routeDraft.length === 1 ? "" : "s"}
                {routeDraft.length >= 2 && data.scale && (
                  <>
                    {" "}
                    ·{" "}
                    {formatDistance(
                      toDistance(pathPixelLength(routeDraft), data.scale),
                      data.scale.unit,
                    )}
                  </>
                )}
              </span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRouteDraft((pts) => pts.slice(0, -1))}
                disabled={routeDraft.length === 0}
              >
                Undo point
              </Button>
              <Button size="sm" type="submit" disabled={routeDraft.length < 2}>
                Finish route
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelTool}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="text-ink-400">Name this route</span>
              <input
                autoFocus
                value={routeNaming}
                onChange={(e) => setRouteNaming(e.target.value)}
                placeholder={`Route ${data.routes.length + 1}`}
                className="w-56 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none focus:border-ember-500"
              />
              <Button size="sm" type="submit">
                Save route
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRouteNaming(null)}
              >
                Back
              </Button>
            </>
          )}
        </form>
      )}

      {/* Territory drawing */}
      {tool === "territory" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (territoryNaming === null) {
              if (territoryDraft.length >= 3) {
                setTerritoryNaming({ name: "", element: null });
              }
            } else {
              finishTerritory(territoryNaming.name, territoryNaming.element);
            }
          }}
          className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-3 py-2 text-xs"
        >
          {territoryNaming === null ? (
            <>
              <span className="text-ink-400">
                {territoryDraft.length} point
                {territoryDraft.length === 1 ? "" : "s"}
                {territoryDraft.length >= 3 && data.scale && (
                  <>
                    {" "}
                    ·{" "}
                    {formatArea(
                      toArea(polygonPixelArea(territoryDraft), data.scale),
                      data.scale.unit,
                    )}
                  </>
                )}
              </span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTerritoryDraft((pts) => pts.slice(0, -1))}
                disabled={territoryDraft.length === 0}
              >
                Undo point
              </Button>
              <Button
                size="sm"
                type="submit"
                disabled={territoryDraft.length < 3}
              >
                Finish territory
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelTool}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="text-ink-400">Name</span>
              <input
                autoFocus
                value={territoryNaming.name}
                onChange={(e) =>
                  setTerritoryNaming({
                    ...territoryNaming,
                    name: e.target.value,
                  })
                }
                placeholder="Leave blank to use the linked element's name"
                className="w-64 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none placeholder:text-ink-600 focus:border-ember-500"
              />
              <span className="text-ink-400">Belongs to</span>
              <LinkSelect
                value={territoryNaming.element}
                onChange={(id) =>
                  setTerritoryNaming({ ...territoryNaming, element: id })
                }
                elements={elements}
                excludeId={element.id}
                order={TERRITORY_LINK_KIND_ORDER}
                className="w-56"
              />
              <Button size="sm" type="submit">
                Save territory
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTerritoryNaming(null)}
              >
                Back
              </Button>
            </>
          )}
        </form>
      )}

      {/* Scale entry */}
      {tool === "scale" && scaleDraft && scalePoints.length === 2 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyScale();
          }}
          className="flex items-end gap-2 border-t border-ink-800 px-3 py-2"
        >
          <span className="text-xs text-ink-400">
            Those two points are{" "}
            <span className="font-mono text-ink-200">
              {Math.round(pixelDistance(scalePoints[0]!, scalePoints[1]!))} px
            </span>{" "}
            apart. That is
          </span>
          <input
            autoFocus
            type="number"
            min={0}
            step="any"
            value={scaleDraft.distance}
            onChange={(e) =>
              setScaleDraft({ ...scaleDraft, distance: e.target.value })
            }
            className="w-24 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none focus:border-ember-500"
          />
          <input
            value={scaleDraft.unit}
            onChange={(e) =>
              setScaleDraft({ ...scaleDraft, unit: e.target.value })
            }
            className="w-24 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none focus:border-ember-500"
          />
          <Button size="sm" type="submit">
            Set scale
          </Button>
          <Button size="sm" variant="ghost" onClick={cancelTool}>
            Cancel
          </Button>
        </form>
      )}

      {/* Measurement */}
      {tool === "measure" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-800 px-3 py-2 text-xs">
          <div className="flex overflow-hidden rounded-md border border-ink-700">
            <SegmentButton
              active={measureMode === "crow"}
              onClick={() => {
                setMeasureMode("crow");
                setMeasure([]);
              }}
            >
              As the crow flies
            </SegmentButton>
            <SegmentButton
              active={measureMode === "route"}
              onClick={() => {
                setMeasureMode("route");
                setMeasure([]);
              }}
              disabled={data.routes.length === 0}
            >
              Along a route
            </SegmentButton>
          </div>
          {measureMode === "route" && data.routes.length > 1 && (
            <select
              value={measureRoute?.id ?? ""}
              onChange={(e) => {
                setMeasureRouteId(e.target.value);
                setMeasure([]);
              }}
              className="rounded-md border border-ink-700 bg-ink-900 px-1.5 py-1 text-xs text-ink-200 outline-none"
            >
              {data.routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          {measure.length >= 2 && (measureMode === "crow" || snaps) ? (
            <>
              <span className="text-ink-200">{measureLabel}</span>
              {measureDistance !== null ? (
                TRAVEL_MODES.map((m) => (
                  <span key={m.id} className="text-ink-400">
                    {m.label}:{" "}
                    <span className="text-ink-200">
                      {formatTravelTime(measureDistance, m.perDay)}
                    </span>
                  </span>
                ))
              ) : (
                <span className="text-ink-500">
                  Set a scale to see distance and travel time.
                </span>
              )}
            </>
          ) : (
            <span className="text-ink-500">{hint}</span>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setMeasure([])}>
            Clear
          </Button>
        </div>
      )}

      {/* All routes */}
      {data.routes.length > 0 && tool !== "route" && (
        <RoutesList
          routes={data.routes}
          scale={data.scale}
          selectedId={selectedRouteId}
          onSelect={(route) => {
            setTool("pan");
            setSelectedPinId(null);
            setSelectedTerritoryId(null);
            setSelectedRouteId(route.id);
            if (route.points.length >= 2) zoomTo(route.points);
          }}
          onMeasure={(route) => {
            setMeasureRouteId(route.id);
            setMeasureMode("route");
            setMeasure([]);
            setTool("measure");
          }}
          onDelete={(route) => deleteRoute(route.id)}
        />
      )}

      {/* All territories */}
      {data.territories.length > 0 && tool !== "territory" && (
        <TerritoriesList
          territories={data.territories}
          elements={elements}
          scale={data.scale}
          selectedId={selectedTerritoryId}
          onSelect={(t) => {
            setTool("pan");
            setSelectedPinId(null);
            setSelectedRouteId(null);
            setSelectedTerritoryId(t.id);
            zoomTo(t.points);
          }}
          onDelete={(t) => deleteTerritory(t.id)}
        />
      )}

      {/* Selected territory */}
      {selectedTerritory && tool === "pan" && (
        <TerritoryEditor
          key={selectedTerritory.id}
          territory={selectedTerritory}
          elements={elements}
          currentMapId={element.id}
          scale={data.scale}
          onChange={(patch) => updateTerritory(selectedTerritory.id, patch)}
          onDelete={() => deleteTerritory(selectedTerritory.id)}
          onOpen={(id, pane) => void navigate(id, { pane })}
        />
      )}

      {/* Selected route */}
      {selectedRoute && tool === "pan" && (
        <RouteEditor
          key={selectedRoute.id}
          route={selectedRoute}
          scale={data.scale}
          onChange={(patch) => updateRoute(selectedRoute.id, patch)}
          onDelete={() => deleteRoute(selectedRoute.id)}
          onMeasure={() => {
            setMeasureRouteId(selectedRoute.id);
            setMeasureMode("route");
            setMeasure([]);
            setTool("measure");
          }}
        />
      )}

      {/* Selected pin */}
      {selectedPin && tool === "pan" && (
        <PinEditor
          key={selectedPin.id}
          pin={selectedPin}
          elements={elements}
          currentMapId={element.id}
          onChange={(patch) =>
            persist({
              pins: data.pins.map((p) =>
                p.id === selectedPin.id ? { ...p, ...patch } : p,
              ),
            })
          }
          onDelete={() => {
            persist({
              pins: data.pins.filter((p) => p.id !== selectedPin.id),
            });
            setSelectedPinId(null);
          }}
          onOpen={(id, pane) => void navigate(id, { pane })}
          onCreateSubMap={() => void createSubMap(selectedPin)}
        />
      )}
    </section>
  );
}

// ---- Small pieces ---------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function ToolButton({
  active,
  onClick,
  label,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded-md p-1.5 transition-colors disabled:opacity-30 ${
        active
          ? "bg-ember-500/25 text-ember-200"
          : "text-ink-300 hover:bg-ink-800"
      }`}
    >
      {children}
    </button>
  );
}

function SegmentButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-2.5 py-1 disabled:opacity-40 ${
        active
          ? "bg-ember-500/25 text-ember-200"
          : "text-ink-300 hover:bg-ink-800"
      }`}
    >
      {children}
    </button>
  );
}

function RoutesList({
  routes,
  scale,
  selectedId,
  onSelect,
  onMeasure,
  onDelete,
}: {
  routes: MapRoute[];
  scale: MapScale | null;
  selectedId: string | null;
  onSelect: (route: MapRoute) => void;
  onMeasure: (route: MapRoute) => void;
  onDelete: (route: MapRoute) => void;
}) {
  return (
    <div className="border-t border-ink-800 px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        Routes
        <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
          {routes.length}
        </span>
      </div>
      <ul className="divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
        {routes.map((route) => {
          const px = pathPixelLength(route.points);
          const distance = scale ? toDistance(px, scale) : null;
          const active = route.id === selectedId;
          return (
            <li
              key={route.id}
              className={`flex items-center gap-3 px-3 py-1.5 text-xs ${
                active ? "bg-ink-800/70" : "hover:bg-ink-850"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(route)}
                className="flex flex-1 items-center gap-3 text-left"
                title="Select and zoom to this route"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: route.color }}
                />
                <span className="truncate text-sm text-ink-100">
                  {route.name}
                </span>
                <span className="shrink-0 text-ink-300">
                  {distance !== null && scale
                    ? formatDistance(distance, scale.unit)
                    : `${Math.round(px)} px`}
                </span>
                {distance !== null && (
                  <span className="hidden shrink-0 gap-3 text-ink-500 md:flex">
                    {TRAVEL_MODES.map((m) => (
                      <span key={m.id}>
                        {m.label.replace("On ", "").replace("By ", "")}{" "}
                        <span className="text-ink-300">
                          {formatTravelTime(distance, m.perDay)}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => onMeasure(route)}
                title="Measure along this route"
                aria-label={`Measure along ${route.name}`}
                className="rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
              >
                <Ruler size={13} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(route)}
                title="Delete route"
                aria-label={`Delete ${route.name}`}
                className="rounded p-1 text-ink-600 hover:bg-ink-800 hover:text-red-300"
              >
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RouteEditor({
  route,
  scale,
  onChange,
  onDelete,
  onMeasure,
}: {
  route: MapRoute;
  scale: MapScale | null;
  onChange: (patch: Partial<MapRoute>) => void;
  onDelete: () => void;
  onMeasure: () => void;
}) {
  const [name, setName] = useState(route.name);
  const px = pathPixelLength(route.points);
  const distance = scale ? toDistance(px, scale) : null;

  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-ink-800 px-3 py-2">
      <label className="text-[11px] text-ink-400">
        Route
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name !== route.name && onChange({ name })
          }
          className="mt-1 block w-48 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none focus:border-ember-500"
        />
      </label>
      <div className="text-[11px] text-ink-400">
        Colour
        <div className="mt-1.5 flex gap-1">
          {ROUTE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange({ color: c })}
              aria-label={`Use colour ${c}`}
              className={`h-5 w-5 rounded-full border-2 ${
                c === route.color ? "border-ink-100" : "border-transparent"
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <div className="text-xs text-ink-400">
        <div className="text-[11px]">Length</div>
        <div className="mt-1 text-ink-200">
          {distance !== null && scale
            ? formatDistance(distance, scale.unit)
            : `${Math.round(px)} px`}
          <span className="ml-2 text-ink-500">
            {route.points.length} points
          </span>
        </div>
      </div>
      {distance !== null && (
        <div className="text-xs text-ink-400">
          <div className="text-[11px]">Travel</div>
          <div className="mt-1 flex gap-3">
            {TRAVEL_MODES.map((m) => (
              <span key={m.id}>
                {m.label.replace("On ", "").replace("By ", "")}:{" "}
                <span className="text-ink-200">
                  {formatTravelTime(distance, m.perDay)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={onMeasure}>
        <Ruler size={14} /> Measure along
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={onDelete}
        aria-label="Delete route"
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function PinEditor({
  pin,
  elements,
  currentMapId,
  onChange,
  onDelete,
  onOpen,
  onCreateSubMap,
}: {
  pin: Pin;
  elements: ElementSummary[];
  currentMapId: string;
  onChange: (patch: Partial<Pin>) => void;
  onDelete: () => void;
  onOpen: (id: string, pane: boolean) => void;
  onCreateSubMap: () => void;
}) {
  const [label, setLabel] = useState(pin.label);
  const linked = pin.element
    ? elements.find((e) => e.id === pin.element)
    : undefined;

  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-ink-800 px-3 py-2">
      <label className="text-[11px] text-ink-400">
        Pin label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== pin.label && onChange({ label })}
          placeholder={linked ? linked.name : "Name this place"}
          className="mt-1 block w-48 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none placeholder:text-ink-600 focus:border-ember-500"
        />
      </label>
      <label className="text-[11px] text-ink-400">
        Linked element
        <LinkSelect
          value={pin.element}
          onChange={(id) => onChange({ element: id })}
          elements={elements}
          excludeId={currentMapId}
          order={PIN_LINK_KIND_ORDER}
          className="mt-1 block w-56"
        />
      </label>
      {linked ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => onOpen(linked.id, e.ctrlKey || e.metaKey)}
          title="Click to open here · Ctrl+click to open beside · or double-click the pin"
        >
          {linked.type === "map" ? <Layers size={14} /> : null}
          Open {linked.name}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={onCreateSubMap}
          title="Create a new map for this place and link the pin to it"
        >
          <Layers size={14} /> New sub-map
        </Button>
      )}
      <span className="font-mono text-[11px] text-ink-600">
        {pin.x}, {pin.y}
      </span>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="danger"
        onClick={onDelete}
        aria-label="Delete pin"
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function TerritoriesList({
  territories,
  elements,
  scale,
  selectedId,
  onSelect,
  onDelete,
}: {
  territories: MapTerritory[];
  elements: ElementSummary[];
  scale: MapScale | null;
  selectedId: string | null;
  onSelect: (territory: MapTerritory) => void;
  onDelete: (territory: MapTerritory) => void;
}) {
  return (
    <div className="border-t border-ink-800 px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        Territories
        <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
          {territories.length}
        </span>
      </div>
      <ul className="divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
        {territories.map((t) => {
          const linked = t.element
            ? elements.find((e) => e.id === t.element)
            : undefined;
          const px = polygonPixelArea(t.points);
          const area = scale ? toArea(px, scale) : null;
          const active = t.id === selectedId;
          return (
            <li
              key={t.id}
              className={`flex items-center gap-3 px-3 py-1.5 text-xs ${
                active ? "bg-ink-800/70" : "hover:bg-ink-850"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(t)}
                className="flex flex-1 items-center gap-3 text-left"
                title="Select and zoom to this territory"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-sm"
                  style={{ background: t.color }}
                />
                <span className="truncate text-sm text-ink-100">
                  {territoryName(t, elements)}
                </span>
                {linked && (
                  <span className="truncate text-ink-500">
                    {kindById(linked.type).label} · {linked.name}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-ink-300">
                  {area !== null && scale
                    ? formatArea(area, scale.unit)
                    : `${t.points.length} points`}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(t)}
                title="Delete territory"
                aria-label={`Delete ${territoryName(t, elements)}`}
                className="rounded p-1 text-ink-600 hover:bg-ink-800 hover:text-red-300"
              >
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TerritoryEditor({
  territory,
  elements,
  currentMapId,
  scale,
  onChange,
  onDelete,
  onOpen,
}: {
  territory: MapTerritory;
  elements: ElementSummary[];
  currentMapId: string;
  scale: MapScale | null;
  onChange: (patch: Partial<MapTerritory>) => void;
  onDelete: () => void;
  onOpen: (id: string, pane: boolean) => void;
}) {
  const [name, setName] = useState(territory.name);
  const linked = territory.element
    ? elements.find((e) => e.id === territory.element)
    : undefined;
  const px = polygonPixelArea(territory.points);
  const area = scale ? toArea(px, scale) : null;

  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-ink-800 px-3 py-2">
      <label className="text-[11px] text-ink-400">
        Territory
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== territory.name && onChange({ name })}
          placeholder={linked ? linked.name : "Name this area"}
          className="mt-1 block w-48 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm outline-none placeholder:text-ink-600 focus:border-ember-500"
        />
      </label>
      <label className="text-[11px] text-ink-400">
        Belongs to
        <LinkSelect
          value={territory.element}
          onChange={(id) => onChange({ element: id })}
          elements={elements}
          excludeId={currentMapId}
          order={TERRITORY_LINK_KIND_ORDER}
          className="mt-1 block w-56"
        />
      </label>
      <div className="text-[11px] text-ink-400">
        Colour
        <div className="mt-1.5 flex gap-1">
          {TERRITORY_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange({ color: c })}
              aria-label={`Use colour ${c}`}
              className={`h-5 w-5 rounded-sm border-2 ${
                c === territory.color ? "border-ink-100" : "border-transparent"
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <div className="text-xs text-ink-400">
        <div className="text-[11px]">Area</div>
        <div className="mt-1 text-ink-200">
          {area !== null && scale
            ? formatArea(area, scale.unit)
            : `${Math.round(px).toLocaleString()} px²`}
          <span className="ml-2 text-ink-500">
            {territory.points.length} points
          </span>
        </div>
      </div>
      {linked && (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => onOpen(linked.id, e.ctrlKey || e.metaKey)}
          title="Click to open here · Ctrl+click to open beside · or double-click the area"
        >
          {linked.type === "map" ? <Layers size={14} /> : null}
          Open {linked.name}
        </Button>
      )}
      <span className="flex-1" />
      <Button
        size="sm"
        variant="danger"
        onClick={onDelete}
        aria-label="Delete territory"
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

/** Element picker grouped by kind, in the order the caller finds likeliest. */
function LinkSelect({
  value,
  onChange,
  elements,
  excludeId,
  order,
  className = "",
  autoFocus,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  elements: ElementSummary[];
  excludeId: string;
  order: string[];
  className?: string;
  autoFocus?: boolean;
}) {
  const groups = useMemo(() => {
    const byKind = new Map<string, ElementSummary[]>();
    for (const e of elements) {
      if (e.id === excludeId) continue;
      const list = byKind.get(e.type) ?? [];
      list.push(e);
      byKind.set(e.type, list);
    }
    const ordered = [
      ...order,
      ...Array.from(byKind.keys()).filter((k) => !order.includes(k)),
    ];
    return ordered
      .filter((k) => byKind.has(k))
      .map((k) => ({
        kind: kindById(k),
        items: (byKind.get(k) ?? []).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      }));
  }, [elements, excludeId, order]);

  return (
    <select
      autoFocus={autoFocus}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={`rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500 ${className}`}
    >
      <option value="">None</option>
      {groups.map((g) => (
        <optgroup key={g.kind.id} label={g.kind.plural}>
          {g.items.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Where this map sits: the maps it is pinned on, and the maps nested in it. */
function MapNesting({
  parents,
  subMaps,
  onOpen,
}: {
  parents: ElementSummary[];
  subMaps: SubMapRef[];
  onOpen: (id: string, pane: boolean) => void;
}) {
  if (parents.length === 0 && subMaps.length === 0) return null;
  const chip =
    "inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-900 px-2 py-0.5 text-[11px] text-ink-200 hover:border-ember-500 hover:text-ember-200";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-ink-800 px-3 py-1.5 text-[11px] text-ink-500">
      {parents.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          <CornerLeftUp size={12} />
          Within
          {parents.map((m) => (
            <button
              key={m.id}
              type="button"
              className={chip}
              onClick={(e) => onOpen(m.id, e.ctrlKey || e.metaKey)}
              title="Open the parent map · Ctrl+click opens beside"
            >
              {m.name}
            </button>
          ))}
        </span>
      )}
      {subMaps.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          <Layers size={12} />
          Maps inside
          {subMaps.map((s) => (
            <button
              key={s.map.id}
              type="button"
              className={chip}
              onClick={(e) => onOpen(s.map.id, e.ctrlKey || e.metaKey)}
              title={`Reached through the ${s.via} "${s.label}" · Ctrl+click opens beside`}
            >
              {s.map.name}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
