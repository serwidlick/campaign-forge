import { Download, X } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/Button";

import { useUpdateStore } from "./updater";

/** Checks shortly after launch so a slow network never delays the window. */
const FIRST_CHECK_MS = 4000;
/** And again every few hours while the app stays open. */
const RECHECK_MS = 4 * 60 * 60 * 1000;

/**
 * A strip across the top when a newer version is on GitHub. One click
 * downloads, installs and relaunches. Dismissable until the next version.
 */
export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase);
  const update = useUpdateStore((s) => s.update);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const check = useUpdateStore((s) => s.check);
  const install = useUpdateStore((s) => s.install);
  const dismiss = useUpdateStore((s) => s.dismiss);

  useEffect(() => {
    const first = setTimeout(() => void check(), FIRST_CHECK_MS);
    const again = setInterval(() => void check(), RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [check]);

  if (!update || dismissed) return null;
  if (
    phase !== "available" &&
    phase !== "downloading" &&
    phase !== "ready" &&
    phase !== "error"
  ) {
    return null;
  }

  const busy = phase === "downloading" || phase === "ready";
  const notes = update.body?.trim();

  return (
    <div className="flex items-center gap-3 border-b border-ember-500/40 bg-ember-500/10 px-4 py-1.5 text-xs text-ember-100">
      <Download size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {phase === "error" ? (
          <>
            Update to {update.version} failed: {error}
          </>
        ) : busy ? (
          <>
            Installing {update.version}
            {progress !== null ? ` · ${Math.round(progress * 100)}%` : "…"}
            {phase === "ready" && " · restarting"}
          </>
        ) : (
          <>
            Campaign Forge {update.version} is available
            {notes ? (
              <span className="text-ember-200/70"> · {firstLine(notes)}</span>
            ) : null}
          </>
        )}
      </span>
      {!busy && (
        <Button size="sm" onClick={() => void install()}>
          {phase === "error" ? "Try again" : "Install and restart"}
        </Button>
      )}
      {!busy && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          title="Not now"
          className="text-ember-200 hover:text-ember-50"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.replace(/^[#*\-\s]+/, "").slice(0, 120);
}
