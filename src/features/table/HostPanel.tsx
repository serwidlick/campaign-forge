import { Eye, Presentation, Radio, Square, Users, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { Button } from "@/components/Button";
import { isShared } from "@/features/player/player-model";
import { inTauri } from "@/lib/platform";
import { table } from "@/lib/tauri";
import type { PlayerRecord, TablePlayer } from "@/lib/types";

import { playersOf, shortFingerprint } from "./players-model";
import { useCampaignStore } from "@/stores/campaign-store";
import { useTableStore } from "@/stores/table-store";

/** Longest GM name the roster shows; it cuts longer ones short anyway. */
const GM_NAME_LIMIT = 40;

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
  const campaign = useCampaignStore((s) => s.campaign);
  const reloadCampaignMeta = useCampaignStore((s) => s.reloadCampaignMeta);
  const updateCampaignSettings = useCampaignStore(
    (s) => s.updateCampaignSettings,
  );
  const bindDevice = useTableStore((s) => s.bindDevice);
  const registry = playersOf(campaign);
  const hosting = useTableStore((s) => s.hosting);
  const hostBusy = useTableStore((s) => s.hostBusy);
  const error = useTableStore((s) => s.error);
  const startHosting = useTableStore((s) => s.startHosting);
  const stopHosting = useTableStore((s) => s.stopHosting);
  const refreshHost = useTableStore((s) => s.refreshHost);
  const showToPlayers = useTableStore((s) => s.showToPlayers);
  const navigate = useCampaignStore((s) => s.navigate);
  const clearError = useTableStore((s) => s.clearError);
  // This machine is a GM's second device: the table is hosted elsewhere and
  // what we show here is its status, read over the network.
  const remote = useTableStore((s) => s.session?.gm === true);
  const hostAddress = useTableStore((s) => s.session?.address ?? "");

  const sharedCount = elements.filter(isShared).length;

  // A QR for phones: the mDNS name when the table is announced (the same on
  // every network, and the same origin next week so phones stay paired),
  // else the most likely IP; or whichever the GM picks.
  const [qrChoice, setQrChoice] = useState<string | null>(null);
  const port = hosting?.port ?? 0;
  const nameUrl = hosting?.hostName
    ? browserUrlOf(hosting.hostName, port)
    : null;
  const ipUrls = (hosting?.addresses ?? []).map((a) =>
    a.startsWith("https://")
      ? a + "/"
      : browserUrlOf(a.split(":")[0] ?? a, port),
  );
  const browserUrls = nameUrl ? [nameUrl, ...ipUrls] : ipUrls;
  const browserUrl =
    qrChoice && browserUrls.includes(qrChoice)
      ? qrChoice
      : (browserUrls[0] ?? null);
  const [qr, setQr] = useState<{ url: string; data: string } | null>(null);
  useEffect(() => {
    if (!browserUrl) return;
    let cancelled = false;
    QRCode.toDataURL(browserUrl, {
      margin: 1,
      width: 168,
      color: { dark: "#eceef2", light: "#15171d" },
    })
      .then((data) => {
        if (!cancelled) setQr({ url: browserUrl, data });
      })
      .catch(() => {
        /* no QR; the address is still shown */
      });
    return () => {
      cancelled = true;
    };
  }, [browserUrl]);
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
            {remote
              ? "At the table as GM"
              : hosting
                ? "Hosting a table"
                : "Host a table"}
          </h2>
          <p className="mt-1 text-xs text-ink-400">
            {remote
              ? `The table is hosted by the machine at ${hostAddress}, which keeps the files. You run it from here.`
              : "Players on the same network join from their own Campaign Forge and see what you have shared, live."}
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
            {remote && (
              <p className="text-sm text-amber-200/90">
                The hosting machine has not answered with the table's status
                yet. If it stopped hosting, this device is back to the welcome
                screen in a moment.
              </p>
            )}
            <p className="text-sm text-ink-300">
              {sharedCount === 0
                ? "Nothing is shared yet. Players would join an empty table; mark some elements as Shared first."
                : `${sharedCount} shared ${sharedCount === 1 ? "element" : "elements"} will be visible to players.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {!remote && (
                <Button onClick={() => void startHosting()} disabled={hostBusy}>
                  <Radio size={16} /> {hostBusy ? "Starting…" : "Start hosting"}
                </Button>
              )}
              <Button variant="ghost" onClick={onPreview}>
                <Eye size={16} /> Preview as a player
              </Button>
            </div>
            {!remote && (
              <p className="text-xs text-ink-500">
                Windows may ask whether to allow Campaign Forge on private
                networks the first time. Say yes, or players cannot reach you.
                Nothing leaves your network.
              </p>
            )}
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

            {browserUrl && (
              <section>
                <SectionTitle>Phones and tablets</SectionTitle>
                <div className="flex flex-wrap items-center gap-5 rounded-lg border border-ink-800 bg-ink-900 px-5 py-4">
                  {qr?.url === browserUrl && (
                    <img
                      src={qr.data}
                      alt="QR code for the table's web page"
                      width={168}
                      height={168}
                      className="rounded-md"
                    />
                  )}
                  <div className="min-w-0 flex-1 text-sm text-ink-300">
                    <p>
                      Anyone on this Wi-Fi can open the table in a browser, no
                      install needed. Scan the code or type the address, then
                      the name and join code as usual.
                    </p>
                    <p className="mt-2 font-mono text-lg text-ink-100">
                      {browserUrl}
                    </p>
                    {browserUrls.length > 1 && (
                      <label className="mt-2 block text-xs text-ink-400">
                        {nameUrl
                          ? "The name is the same every session. If a phone cannot open it (older Android, guest Wi-Fi), use an address instead:"
                          : "This machine has several addresses. If the code does not open, try another:"}
                        <select
                          value={browserUrl ?? ""}
                          onChange={(e) => setQrChoice(e.target.value)}
                          className="mt-1 block rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-sm text-ink-100 outline-none"
                        >
                          {browserUrls.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <p className="mt-2 text-xs text-ink-500">
                      The page reads what is shared, opens maps, pictures and
                      PDFs, and follows Show to players. Editing a character
                      needs the app.
                    </p>
                    <p className="mt-2 text-xs text-ink-400">
                      Your own laptop, with no install: sit down from its
                      browser on the address above, pair it and press Make GM
                      below, then open{" "}
                      <span className="font-mono text-ink-200">
                        {browserUrl}gm
                      </span>{" "}
                      in the same browser. That page is the whole GM view,
                      working on this machine's files, and turns every other
                      device away.
                    </p>
                  </div>
                </div>
              </section>
            )}

            <section>
              <SectionTitle>
                <Users size={12} className="mr-1 inline" />
                At the table
                <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
                  {hosting.players.length}
                </span>
              </SectionTitle>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <GmNameField
                  value={
                    typeof campaign?.gmName === "string" ? campaign.gmName : ""
                  }
                  onSave={(gmName) =>
                    void updateCampaignSettings({ gmName: gmName || null })
                  }
                />
                <PlayerMessagesToggle />
              </div>
              {hosting.players.length === 0 ? (
                <p className="text-sm text-ink-500">
                  Nobody yet. The table is announced as “
                  {useCampaignStore.getState().campaign?.name}”.
                </p>
              ) : (
                <ul className="divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
                  {hosting.players.map((p) => (
                    <ConnectionRow
                      key={p.token}
                      p={p}
                      registry={registry}
                      onBind={async (playerId, name) => {
                        await bindDevice(p.token, playerId, name);
                        await reloadCampaignMeta();
                      }}
                    />
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
                    is offered to every player: they see a bar and choose to
                    look
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

            <PlayersSection
              players={registry}
              onSetGm={(id, gm) =>
                void updateCampaignSettings({
                  players: registry.map((p) =>
                    p.id === id ? { ...p, gm } : p,
                  ),
                })
              }
              onRemovePlayer={(id) =>
                void updateCampaignSettings({
                  players: registry.filter((p) => p.id !== id),
                })
              }
              onRemoveDevice={(id, fingerprint) =>
                void updateCampaignSettings({
                  players: registry.map((p) =>
                    p.id === id
                      ? {
                          ...p,
                          devices: p.devices.filter(
                            (d) => d.fingerprint !== fingerprint,
                          ),
                        }
                      : p,
                  ),
                })
              }
            />

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
                {!remote && (
                  <Button
                    variant="danger"
                    onClick={() => void stopHosting()}
                    disabled={hostBusy}
                  >
                    <Square size={14} /> Stop hosting
                  </Button>
                )}
              </div>
              {remote && (
                <p className="mt-3 text-xs text-ink-500">
                  Only the hosting machine can stop the table. Leave table at
                  the top of the sidebar takes this device back to its own
                  campaigns.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** One connection at the table, with pairing for devices the GM has not seen. */
function ConnectionRow({
  p,
  registry,
  onBind,
}: {
  p: TablePlayer;
  registry: PlayerRecord[];
  onBind: (playerId: string | null, name: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const paired = p.playerId
    ? registry.find((r) => r.id === p.playerId)
    : undefined;
  async function bind(playerId: string | null, name: string | null) {
    setBusy(true);
    try {
      await onBind(playerId, name);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <span
        className={`h-2 w-2 rounded-full ${
          p.online ? "bg-green-400" : "bg-ink-600"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="text-ink-100">{p.name}</span>
        <span className="ml-2 text-xs text-ink-500">
          {p.device
            ? `${p.device.label || "device"} · ${shortFingerprint(p.device.fingerprint)}`
            : "browser"}
        </span>
      </span>
      <span className="text-xs text-ink-500">
        {p.online ? "connected" : `last seen ${ago(p.lastSeen)}`}
      </span>
      {paired ? (
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] ${
            paired.gm
              ? "border-ember-500/40 bg-ember-500/10 text-ember-200"
              : "border-green-500/40 bg-green-500/10 text-green-200"
          }`}
        >
          {paired.gm ? "GM" : "paired"} · {paired.name}
        </span>
      ) : p.device ? (
        <span className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => void bind(null, p.name)}
            disabled={busy}
            title="Create a player with this name and pair this device to them"
          >
            Pair as new player
          </Button>
          {registry.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) void bind(e.target.value, null);
              }}
              disabled={busy}
              className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-200 outline-none"
              aria-label="Pair with an existing player"
            >
              <option value="">or an existing player…</option>
              {registry.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </span>
      ) : (
        <span
          className="text-[11px] text-ink-600"
          title="This browser could not make a device key, so it cannot be paired"
        >
          guest
        </span>
      )}
    </li>
  );
}

/** Every paired player of the campaign and their devices. */
function PlayersSection({
  players,
  onSetGm,
  onRemovePlayer,
  onRemoveDevice,
}: {
  players: PlayerRecord[];
  onSetGm: (id: string, gm: boolean) => void;
  onRemovePlayer: (id: string) => void;
  onRemoveDevice: (id: string, fingerprint: string) => void;
}) {
  return (
    <section>
      <SectionTitle>
        Players
        <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
          {players.length}
        </span>
      </SectionTitle>
      {players.length === 0 ? (
        <p className="text-sm text-ink-500">
          Nobody paired yet. When someone joins, press{" "}
          <span className="text-ink-300">Pair as new player</span> on their row
          above. Paired devices and browsers never need the code again, and you
          can assign pages and characters to them. Pair your own laptop the same
          way and press <span className="text-ink-300">Make GM</span> to run the
          table from it.
        </p>
      ) : (
        <ul className="divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
          {players.map((p) => (
            <li key={p.id} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-ink-100">
                  {p.name}
                  {p.gm && (
                    <span className="ml-2 rounded-full border border-ember-500/40 bg-ember-500/10 px-1.5 py-px text-[10px] text-ember-200">
                      GM
                    </span>
                  )}
                </span>
                {p.lastSeen && (
                  <span className="text-xs text-ink-500">
                    last at the table {ago(p.lastSeen)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSetGm(p.id, !p.gm)}
                  aria-pressed={p.gm}
                  className={`text-xs ${
                    p.gm
                      ? "text-ember-300 hover:text-ink-300"
                      : "text-ink-500 hover:text-ember-300"
                  }`}
                  title={
                    p.gm
                      ? "Their devices go back to the player view the moment you click"
                      : "Their devices get your whole campaign, editable, at the table: for your own laptop while this machine keeps the files"
                  }
                >
                  {p.gm ? "Revoke GM" : "Make GM"}
                </button>
                <button
                  type="button"
                  onClick={() => onRemovePlayer(p.id)}
                  className="text-xs text-ink-500 hover:text-red-300"
                  title="Remove this player; their devices will need the code again"
                >
                  Remove
                </button>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
                {p.devices.map((d) => (
                  <li key={d.fingerprint} className="flex items-center gap-2">
                    <span className="text-ink-400">{d.label || "device"}</span>
                    <span className="font-mono">{d.fingerprint}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveDevice(p.id, d.fingerprint)}
                      className="text-ink-600 hover:text-red-300"
                      aria-label={`Forget device ${d.fingerprint}`}
                    >
                      forget
                    </button>
                  </li>
                ))}
                {p.devices.length === 0 && <li>No devices paired.</li>}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What the GM is called in everyone's roster; saved with the campaign. */
function GmNameField({
  value,
  onSave,
}: {
  value: string;
  onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // Follow a change made elsewhere (another GM device) when not editing.
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  function commit() {
    const name = draft.trim().slice(0, GM_NAME_LIMIT);
    setDraft(name);
    if (name !== value) onSave(name);
  }
  return (
    <label className="flex items-center gap-2 text-xs text-ink-400">
      Your name at the table
      <input
        value={draft}
        maxLength={GM_NAME_LIMIT}
        placeholder="Game Master"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-40 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 placeholder:text-ink-600"
      />
    </label>
  );
}

/**
 * Whether players may message each other (they can always message the GM,
 * and the GM anyone). Only the hosting machine decides it: a GM's second
 * device does not see the switch.
 */
function PlayerMessagesToggle() {
  const hostingHere = useTableStore((s) => inTauri && s.session === null);
  // Read from the host status, never through the chat snapshot: that would
  // restart the hosting window's message cursor.
  const fromHost = useTableStore(
    (s) => s.hosting?.messageRules?.playersMayMessage,
  );
  const refreshHost = useTableStore((s) => s.refreshHost);
  const [pending, setPending] = useState<boolean | null>(null);
  if (!hostingHere || fromHost === undefined) return null;
  const allowed = pending ?? fromHost;
  return (
    <label className="flex items-center gap-2 text-xs text-ink-400">
      <input
        type="checkbox"
        checked={allowed}
        onChange={(e) => {
          const next = e.target.checked;
          setPending(next);
          void table
            .setMessageRules(next)
            .then(() => refreshHost())
            .catch(() => {})
            .finally(() => setPending(null));
        }}
        className="accent-ember-400"
      />
      Players can message each other
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
      {children}
    </h3>
  );
}

/** The phone page's address for a host name or IP; port 80 is left off. */
function browserUrlOf(host: string, port: number): string {
  return port === 80 ? `http://${host}/` : `http://${host}:${port}/`;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
