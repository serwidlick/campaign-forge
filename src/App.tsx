import { useEffect } from "react";

import { BibleScreen } from "@/features/bible/BibleScreen";
import { WelcomeScreen } from "@/features/campaign/WelcomeScreen";
import { TableScreen } from "@/features/table/TableScreen";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { useCampaignStore } from "@/stores/campaign-store";
import { useTableStore } from "@/stores/table-store";

export default function App() {
  const campaign = useCampaignStore((s) => s.campaign);
  const restore = useCampaignStore((s) => s.restore);
  const session = useTableStore((s) => s.session);
  const restoreTable = useTableStore((s) => s.restore);

  // On a hot reload the Rust side may still have a campaign open or a table
  // joined; pick them up.
  useEffect(() => {
    void restore();
    void restoreTable();
  }, [restore, restoreTable]);

  const screen = session ? (
    <TableScreen />
  ) : campaign ? (
    <BibleScreen />
  ) : (
    <WelcomeScreen />
  );

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  );
}
