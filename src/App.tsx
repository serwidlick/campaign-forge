import { useEffect } from "react";

import { BibleScreen } from "@/features/bible/BibleScreen";
import { WelcomeScreen } from "@/features/campaign/WelcomeScreen";
import {
  GmOnPhoneScreen,
  PlayerWelcomeScreen,
} from "@/features/table/PlayerWelcomeScreen";
import { PresenceBar } from "@/features/table/PresenceBar";
import { RemoteGmScreen } from "@/features/table/RemoteGmScreen";
import { TableScreen } from "@/features/table/TableScreen";
import { WebJoinScreen } from "@/features/table/WebJoinScreen";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { inTauri, isMobile } from "@/lib/platform";
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
      // The phone app has no campaign of its own to pick up.
      if (!isMobile && !useTableStore.getState().session?.gm) void restore();
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

  // A phone is a player's seat and nothing else: joined, it shows the
  // table; otherwise, the way to find one.
  if (isMobile) {
    return (
      <div className="mobile-safe-area flex h-full flex-col">
        <div className="min-h-0 flex-1">
          {session ? (
            session.gm ? (
              <GmOnPhoneScreen />
            ) : (
              <TableScreen />
            )
          ) : (
            <PlayerWelcomeScreen />
          )}
        </div>
        <PresenceBar />
      </div>
    );
  }

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
      <PresenceBar />
    </div>
  );
}
