import { spokeForKind } from "@/features/bible/wheel";

import { initialOf, usePortraitUrl, type AssetLoader } from "./portrait-model";

/**
 * An element's picture, or its initial on the colour of its kind. Square,
 * with softly rounded corners.
 */
export function Portrait({
  path,
  name,
  kind,
  size = 28,
  scope,
  load,
  className = "",
}: {
  path: string | null | undefined;
  name: string;
  kind: string;
  size?: number;
  scope: string;
  load: AssetLoader;
  className?: string;
}) {
  const url = usePortraitUrl(path, scope, load);
  const color = spokeForKind(kind).color;
  const radius = Math.max(4, Math.round(size / 6));
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: radius }}
        className={`shrink-0 object-cover ${className}`}
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `color-mix(in srgb, ${color} 22%, transparent)`,
        color,
        fontSize: Math.max(10, Math.round(size * 0.45)),
      }}
      className={`flex shrink-0 select-none items-center justify-center font-semibold ${className}`}
    >
      {initialOf(name)}
    </span>
  );
}
