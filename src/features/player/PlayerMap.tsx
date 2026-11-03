import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";

import {
  fitZoom,
  pinName,
  territoryName,
  type MapData,
} from "@/features/map/map-model";
import type { ElementSummary } from "@/lib/types";

const MAP_HEIGHT = 480;

/**
 * Read-only map for players: the image, plus whatever pins, routes and
 * territories were shared. Pan and zoom only; clicking a pin opens what it
 * links to when that is shared too.
 */
export function PlayerMap({
  data,
  elements,
  readAsset,
  onOpen,
}: {
  data: MapData;
  elements: ElementSummary[];
  readAsset: (path: string) => Promise<ArrayBuffer>;
  onOpen: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup>(L.layerGroup());
  const fittedForRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(
    null,
  );
  const imageUrl = loaded && loaded.path === data.image ? loaded.url : null;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const path = data.image;
    if (path) {
      readAsset(path)
        .then((buf) => {
          if (cancelled) return;
          url = URL.createObjectURL(new Blob([buf]));
          setLoaded({ path, url });
        })
        .catch(() => {
          /* the GM's image is missing; the map shows without it */
        });
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data.image, readAsset]);

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
      maxBoundsViscosity: 1,
    });
    layerRef.current.addTo(map);
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    const layer = layerRef.current;
    if (!map || !el) return;
    layer.clearLayers();
    const width = data.width ?? 0;
    const height = data.height ?? 0;
    if (!imageUrl || !width || !height) return;

    const toLatLng = (p: { x: number; y: number }): L.LatLngExpression => [
      height - p.y,
      p.x,
    ];
    const bounds = L.latLngBounds([0, 0], [height, width]);
    L.imageOverlay(imageUrl, bounds).addTo(layer);
    map.setMaxBounds(bounds.pad(0.75));

    for (const t of data.territories) {
      if (t.points.length < 3) continue;
      const poly = L.polygon(t.points.map(toLatLng), {
        color: t.color,
        weight: 1.5,
        opacity: 0.8,
        fillColor: t.color,
        fillOpacity: 0.2,
      });
      poly.bindTooltip(territoryName(t, elements), {
        permanent: true,
        direction: "center",
        className: "cf-territory-label",
      });
      if (t.element) {
        const id = t.element;
        poly.on("click", () => onOpen(id));
      }
      poly.addTo(layer);
    }
    for (const r of data.routes) {
      if (r.points.length < 2) continue;
      L.polyline(r.points.map(toLatLng), {
        color: r.color,
        weight: 3,
        opacity: 0.8,
      })
        .bindTooltip(r.name, { sticky: true, className: "cf-pin-label" })
        .addTo(layer);
    }
    for (const pin of data.pins) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="cf-pin"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const marker = L.marker(toLatLng(pin), { icon, interactive: true });
      marker.bindTooltip(pinName(pin, elements), {
        permanent: true,
        direction: "top",
        offset: [0, -8],
        className: "cf-pin-label",
      });
      if (pin.element) {
        const id = pin.element;
        marker.on("click", () => onOpen(id));
      }
      marker.addTo(layer);
    }

    if (fittedForRef.current !== imageUrl) {
      fittedForRef.current = imageUrl;
      const zoom = fitZoom(
        data.fit,
        el.clientWidth,
        el.clientHeight,
        width,
        height,
      );
      const containZoom = fitZoom(
        "contain",
        el.clientWidth,
        el.clientHeight,
        width,
        height,
      );
      map.setMinZoom(Math.min(zoom, containZoom) - 1);
      map.setView([height / 2, width / 2], zoom, { animate: false });
    }
  }, [data, elements, imageUrl, onOpen]);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-ink-800 bg-ink-900/60"
      style={{ height: MAP_HEIGHT }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {!data.image && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-600">
          This map has no image yet.
        </div>
      )}
    </div>
  );
}
