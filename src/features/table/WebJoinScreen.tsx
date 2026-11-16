import { RefreshCw, ShieldAlert, Wifi } from "lucide-react";
import { useEffect, useRef } from "react";

import appIcon from "@/assets/icon.png";
import { Button } from "@/components/Button";
import { ThemePicker } from "@/components/ThemePicker";
import { deviceLabel } from "@/lib/web-table";
import { useTableStore } from "@/stores/table-store";

/**
 * The gate of the `/gm` page a hosting machine serves. There is nothing to
 * type: the browser's own key is the proof, and the table seats this page
 * only when the GM has paired the browser and made that player a GM. It
 * connects on its own; turned away, it says what the GM has to do and
 * offers to try again.
 */
export function WebJoinScreen() {
  const joining = useTableStore((s) => s.joining);
  const error = useTableStore((s) => s.error);
  const notice = useTableStore((s) => s.notice);
  const join = useTableStore((s) => s.join);

  // One attempt as the page opens; after that the button asks again.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    void join(location.host, "GM");
  }, [join]);

  const refused = !joining && (error !== null || notice !== null);

  return (
    <div className="flex h-full flex-col items-center justify-center bg-ink-950 px-6 text-ink-100">
      <div className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 p-6">
        <div className="flex items-center gap-3">
          <img src={appIcon} alt="" width={40} height={40} />
          <div>
            <h1 className="font-serif text-xl font-semibold">Campaign Forge</h1>
            <p className="text-xs text-ink-400">
              The GM's view of the table at {location.host}.
            </p>
          </div>
          <span className="flex-1" />
          <ThemePicker variant="icon" placement="below-end" />
        </div>

        {!refused ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-ink-300">
            <Wifi size={16} className="animate-pulse text-ember-300" />
            Connecting as this browser…
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <span>{notice ?? error}</span>
            </div>
            <Button onClick={() => void join(location.host, "GM")}>
              <RefreshCw size={14} /> Try again
            </Button>
          </div>
        )}

        <p className="mt-6 text-xs text-ink-500">
          This browser shows as “{deviceLabel()}” in the GM's hosting panel.
          Only a browser the GM has paired and made a GM gets past this page;
          everyone else uses the table's main page, which is the player view.
        </p>
      </div>
    </div>
  );
}
