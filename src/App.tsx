import { useEffect } from "react";

import { BibleScreen } from "@/features/bible/BibleScreen";
import { WelcomeScreen } from "@/features/campaign/WelcomeScreen";
import { useCampaignStore } from "@/stores/campaign-store";

export default function App() {
  const campaign = useCampaignStore((s) => s.campaign);
  const restore = useCampaignStore((s) => s.restore);

  // On a hot reload the Rust side may still have a campaign open; pick it up.
  useEffect(() => {
    void restore();
  }, [restore]);

  return campaign ? <BibleScreen /> : <WelcomeScreen />;
}
