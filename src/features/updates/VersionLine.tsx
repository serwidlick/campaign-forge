import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

import { useUpdateStore } from "./updater";

/** "Campaign Forge 0.1.0 · Check for updates", for the welcome screen. */
export function VersionLine() {
  const [version, setVersion] = useState<string | null>(null);
  const phase = useUpdateStore((s) => s.phase);
  const upToDate = useUpdateStore((s) => s.upToDate);
  const error = useUpdateStore((s) => s.error);
  const update = useUpdateStore((s) => s.update);
  const check = useUpdateStore((s) => s.check);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const status =
    phase === "checking"
      ? "Checking…"
      : phase === "error" && error
        ? `Could not check: ${error}`
        : update
          ? `${update.version} is available`
          : upToDate
            ? "Up to date"
            : null;

  return (
    <p className="mt-10 text-xs text-ink-600">
      Campaign Forge {version ?? ""}
      {" · "}
      <button
        type="button"
        onClick={() => void check({ manual: true })}
        disabled={phase === "checking"}
        className="text-ink-500 hover:text-ink-300 disabled:opacity-60"
      >
        Check for updates
      </button>
      {status && <span className="ml-2 text-ink-500">{status}</span>}
    </p>
  );
}
