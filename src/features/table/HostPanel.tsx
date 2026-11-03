import { Eye, Presentation, Radio, Square, Users, X } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/Button";
import { isShared } from "@/features/player/player-model";
import { useCampaignStore } from "@/stores/campaign-store";
import { useTableStore } from "@/stores/table-store";

const STATUS_POLL_MS = 3000;

/**
 * The GM's hosting controls: start or stop the table, read out the code and
 * address, and see who has joined.
 */
export function HostPanel({
  onClose,
  onPreview,
}: {
  onClose: () => void;
  onPreview: () => void;
}) {
  const elements = useCampaignStore((s) => s.elements);
  const hosting = useTableStore((s) => s.hosting);
  const hostBusy = useTableStore((s) => s.hostBusy);
  const error = useTableStore((s) => s.error);
  const startHosting = useTableStore((s) => s.startHosting);
  const stopHosting = useTableStore((s) => s.stopHosting);
  const refreshHost = useTableStore((s) => s.refreshHost);
  const showToPlayers = useTableStore((s) => s.showToPlayers);
  const navigate = useCampaignStore((s) => s.navigate);
  const clearError = useTableStore((s) => s.clearError);

  const sharedCount = elements.filter(isShared).length;
  const showing = hosting?.spotlight
    ? elements.find((e) => e.id === hosting.spotlight)
    : undefined;

  // Who is at the table, kept fresh while this panel is open.
  useEffect(() => {
    if (!hosting) return;
    const id = setInterval(() => void refreshHost(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [hosting, refreshHost]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-800 px-6 py-4">
        <div className="flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Table
          </div>
          <h2 className="mt-0.5 font-serif text-2xl font-semibold text-ink-100">
            {hosting ? "Hosting a table" : "Host a table"}
          </h2>
          <p className="mt-1 text-xs text-ink-400">
            Players on the same network join from their own Campaign Forge and
            see what you have shared, live.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </Button>
      </header>

      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
        {error && (
          <div className="flex items-start gap-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={clearError}
              aria-label="Dismiss"
              className="text-red-300 hover:text-red-100"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {!hosting ? (
          <section className="space-y-4">
            <p className="text-sm text-ink-300">
              {sharedCount === 0
                ? "Nothing is shared yet. Players would join an empty table; mark some elements as Shared first."
                : `${sharedCount} shared ${sharedCount === 1 ? "element" : "elements"} will be visible to players.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void startHosting()} disabled={hostBusy}>
                <Radio size={16} /> {hostBusy ? "Starting…" : "Start hosting"}
              </Button>
              <Button variant="ghost" onClick={onPreview}>
                <Eye size={16} /> Preview as a player
              </Button>
            </div>
            <p className="text-xs text-ink-500">
              Windows may ask whether to allow Campaign Forge on private
              networks the first time. Say yes, or players cannot reach you.
              Nothing leaves your network.
            </p>
          </section>
        ) : (
          <>
            <section>
              <SectionTitle>Tell your players</SectionTitle>
              <div className="flex flex-wrap items-stretch gap-4">
                <div className="rounded-lg border border-ember-500/40 bg-ember-500/10 px-6 py-4">
                  <div className="text-[11px] uppercase tracking-wider text-ember-300/80">
                    Join code
                  </div>
                  <div className="mt-1 font-mono text-4xl font-semibold tracking-[0.3em] text-ember-200">
                    {hosting.code}
                  </div>
                </div>
                <div className="flex-1 rounded-lg border border-ink-800 bg-ink-900 px-5 py-4">
                  <div className="text-[11px] uppercase tracking-wider text-ink-500">
                    If the table does not show up for them
                  </div>
                  {hosting.addresses.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {hosting.addresses.map((a) => (
                        <li key={a} className="font-mono text-lg text-ink-100">
                          {a}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-ink-400">
                      No network address found. Are you connected to Wi-Fi or a
                      cable?
                    </p>
                  )}
                  <p className="mt-2 text-xs text-ink-500">
                    They type one of these under Join by address.
                  </p>
                </div>
              </div>
              {hosting.announceError && (
                <p className="mt-3 text-xs text-amber-300/90">
                  The table is up but could not be announced on the network (
                  {hosting.announceError}). Players can still join by address.
                </p>
              )}
            </section>

            <section>
              <SectionTitle>
                <Users size={12} className="mr-1 inline" />
                At the table
                <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
                  {hosting.players.length}
                </span>
              </SectionTitle>
              {hosting.players.length === 0 ? (
                <p className="text-sm text-ink-500">
                  Nobody yet. The table is announced as “
                  {useCampaignStore.getState().campaign?.name}”.
                </p>
              ) : (
                <ul className="divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
                  {hosting.players.map((p) => (
                    <li
                      key={`${p.name}-${p.joinedAt}`}
                      className="flex items-center gap-3 px-3 py-2 text-sm"
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          isRecent(p.lastSeen) ? "bg-green-400" : "bg-ink-600"
                        }`}
                      />
                      <span className="flex-1 text-ink-100">{p.name}</span>
                      <span className="text-xs text-ink-500">
                        {isRecent(p.lastSeen)
                          ? "connected"
                          : `last seen ${ago(p.lastSeen)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <SectionTitle>
                <Presentation size={12} className="mr-1 inline" />
                Showing everyone
              </SectionTitle>
              {showing ? (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm">
                  <button
                    type="button"
                    onClick={() => void navigate(showing.id)}
                    className="text-green-100 hover:underline"
                  >
                    {showing.name}
                  </button>
                  <span className="text-xs text-green-300/80">
                    is open on every player's screen
                  </span>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void showToPlayers(null)}
                  >
                    Stop showing
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-ink-500">
                  Nothing right now. Open any element and press{" "}
                  <span className="text-ink-300">Show to players</span> in its
                  header to put it on every screen.
                </p>
              )}
            </section>

            <section>
              <SectionTitle>Sharing</SectionTitle>
              <p className="text-sm text-ink-300">
                {sharedCount} shared{" "}
                {sharedCount === 1 ? "element" : "elements"}. Toggle Shared on
                anything and players see it within a second.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="ghost" onClick={onPreview}>
                  <Eye size={16} /> Preview as a player
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void stopHosting()}
                  disabled={hostBusy}
                >
                  <Square size={14} /> Stop hosting
                </Button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
      {children}
    </h3>
  );
}

/** Players poll every few seconds; anything older than a minute is gone. */
function isRecent(iso: string): boolean {
  return Date.now() - Date.parse(iso) < 60_000;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
