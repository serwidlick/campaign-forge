import { getVersion } from "@tauri-apps/api/app";
import { ArrowLeft, Monitor } from "lucide-react";
import { useEffect, useState } from "react";

import appIcon from "@/assets/icon.png";
import { Button } from "@/components/Button";
import { ThemePicker } from "@/components/ThemePicker";
import { JoinTable } from "@/features/table/JoinTable";
import { useTableStore } from "@/stores/table-store";

/**
 * The first screen of the mobile app, which is for players only. There is
 * no campaign to open: find the GM's table on the network and sit down.
 */
export function PlayerWelcomeScreen() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-ink-950 text-ink-100">
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col gap-6 px-4 py-6">
        <header className="flex items-center gap-3">
          <img src={appIcon} alt="" width={44} height={44} />
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-2xl font-semibold">
              Campaign Forge
            </h1>
            <p className="text-xs text-ink-400">For players at the table</p>
          </div>
          <ThemePicker variant="icon" placement="below-end" />
        </header>

        <JoinTable
          title="Join your GM's table"
          description="On the same Wi-Fi as the GM, find their table, then sit down with your name and the code they read out."
        />

        <p className="text-[13px] leading-relaxed text-ink-400">
          Once seated you see what the GM shares: your character sheet, the map,
          the people and places you have met, and which dice to roll when the GM
          asks. Running a campaign happens in Campaign Forge on a computer,
          where the campaign folder lives.
        </p>

        <footer className="mt-auto flex items-center justify-between text-xs text-ink-500">
          <span>Campaign Forge {version ?? ""}</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * The GM paired this phone as a GM device. The phone app has no GM screen,
 * so say what happened and offer the way out instead of a broken view.
 */
export function GmOnPhoneScreen() {
  const session = useTableStore((s) => s.session);
  const leave = useTableStore((s) => s.leave);

  return (
    <div className="flex h-full flex-col items-center justify-center bg-ink-950 px-6 text-ink-100">
      <div className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-ink-200">
            <Monitor size={18} />
          </span>
          <h1 className="font-serif text-xl font-semibold">
            This device is a GM
          </h1>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-ink-300">
          The GM at {session?.info.name ?? "the table"} made this device a GM.
          The phone app only has the player view. To run the table from here,
          open the hosting machine's address in a browser instead; to play, ask
          the GM to pair this device with your character.
        </p>
        <div className="mt-5">
          <Button onClick={() => void leave()}>
            <ArrowLeft size={14} /> Leave table
          </Button>
        </div>
      </div>
    </div>
  );
}
