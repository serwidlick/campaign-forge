import { useMemo } from "react";

import { ErrorBanner } from "@/components/ErrorBanner";
import { PlayerScreen } from "@/features/player/PlayerScreen";
import { remoteSource } from "@/features/player/player-model";
import { readCalendar } from "@/features/timeline/calendar-model";
import { useTableStore } from "@/stores/table-store";

/** A player sitting at a GM's table: the player view, fed over the network. */
export function TableScreen() {
  const session = useTableStore((s) => s.session);
  const elements = useTableStore((s) => s.elements);
  const connection = useTableStore((s) => s.connection);
  const spotlight = useTableStore((s) => s.spotlight);
  const leave = useTableStore((s) => s.leave);

  const source = useMemo(() => remoteSource(elements), [elements]);
  const calendar = useMemo(
    () => readCalendar({ calendar: session?.info.calendar ?? undefined }),
    [session?.info.calendar],
  );

  if (!session) return null;

  const banner =
    connection === "reconnecting"
      ? `Lost the GM. Trying to reconnect to ${session.address}…`
      : `At the table as ${session.playerName}. The GM can change what you see at any time.`;

  return (
    <div className="flex h-full flex-col">
      <ErrorBanner />
      <PlayerScreen
        source={source}
        calendar={calendar}
        title={session.info.name}
        subtitle={session.info.system ?? undefined}
        banner={banner}
        exitLabel="Leave table"
        onExit={() => void leave()}
        focus={
          spotlight ? { id: spotlight.id, nonce: spotlight.seq } : undefined
        }
      />
    </div>
  );
}
