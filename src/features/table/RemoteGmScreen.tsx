import { Laptop, Wifi, WifiOff } from "lucide-react";

import { Button } from "@/components/Button";
import { BibleScreen } from "@/features/bible/BibleScreen";
import { useCampaignStore } from "@/stores/campaign-store";
import { useTableStore } from "@/stores/table-store";

/**
 * A GM at someone's table from a second machine: the ordinary GM screen,
 * with every read and write going to the hosting machine's files over the
 * table. The strip across the top says so, and is the way back.
 */
export function RemoteGmScreen() {
  const session = useTableStore((s) => s.session);
  const connection = useTableStore((s) => s.connection);
  const leave = useTableStore((s) => s.leave);
  const campaign = useCampaignStore((s) => s.campaign);

  if (!session) return null;

  const lost = connection === "reconnecting";

  return (
    <div className="flex h-full flex-col">
      <div
        className={`flex items-center gap-3 border-b px-4 py-1.5 text-xs ${
          lost
            ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
            : "border-ember-500/40 bg-ember-500/10 text-ember-200"
        }`}
      >
        {lost ? <WifiOff size={13} /> : <Wifi size={13} />}
        <span className="flex-1">
          {lost
            ? `Lost the hosting machine at ${session.address}. Trying to reconnect; edits wait until it is back.`
            : `GM at the table from this machine. Everything you change is saved on the hosting machine at ${session.address}, which keeps the files.`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void leave()}>
          <Laptop size={13} /> Leave table
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {campaign ? (
          <BibleScreen />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            Loading the campaign from {session.address}…
          </div>
        )}
      </div>
    </div>
  );
}
