import { useEffect } from "react";

import { BibleScreen } from "@/features/bible/BibleScreen";
import { WelcomeScreen } from "@/features/campaign/WelcomeScreen";
import { RemoteGmScreen } from "@/features/table/RemoteGmScreen";
import { TableScreen } from "@/features/table/TableScreen";
import { WebJoinScreen } from "@/features/table/WebJoinScreen";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { inTauri } from "@/lib/platform";
import { storage } from "@/lib/tauri";
import { useCampaignStore } from "@/stores/campaign-store";
import { useTableStore } from "@/stores/table-store";

export default function App() {
  const campaign = useCampaignStore((s) => s.campaign);
  const restore = useCampaignStore((s) => s.restore);
  const session = useTableStore((s) => s.session);
  const restoreTable = useTableStore((s) => s.restore);

  // On a hot reload the Rust side may still have a campaign open or a table
  // joined; pick them up. The table first: a GM's device shows the hosted
  // campaign, not whatever this machine has open.
  useEffect(() => {
    void restoreTable().then(() => {
      if (!useTableStore.getState().session?.gm) void restore();
    });
  }, [restore, restoreTable]);

  // Edits to the campaign folder made elsewhere: a sync client (OneDrive,
  // Google Drive...), another program, a player at the table, or, for a GM
  // at someone's table, anything that changed on the hosting machine.
  useEffect(() => {
    const unlisten = storage.onFilesChanged(
      (changes) => void useCampaignStore.getState().applyDiskChanges(changes),
    );
    return () => void unlisten.then((stop) => stop());
  }, []);

  const screen = session ? (
    session.gm ? (
      <RemoteGmScreen />
    ) : (
      <TableScreen />
    )
  ) : campaign ? (
    <BibleScreen />
  ) : inTauri ? (
    <WelcomeScreen />
  ) : (
    // The /gm page a hosting machine serves: this browser is at that table
    // or nowhere, so there are no campaigns of its own to show.
    <WebJoinScreen />
  );

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  );
}
