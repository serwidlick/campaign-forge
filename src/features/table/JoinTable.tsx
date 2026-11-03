import { Radio, Search, Wifi, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { FoundTable } from "@/lib/types";
import { useTableStore } from "@/stores/table-store";

/** How long one press of Find tables keeps listening. */
const SEARCH_MS = 8000;
const POLL_MS = 1000;
const NAME_KEY = "cf.playerName";

const FIELD =
  "mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";
const ACTION =
  "inline-flex h-10 items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-4 text-sm font-medium text-ink-100 transition hover:border-ink-500 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "inline-flex h-10 items-center gap-2 rounded-lg bg-ember-500 px-4 text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The player's way in, as a card on the welcome screen: find a GM's table
 * on the network, or type their address, then sit down with a name and the
 * code the GM reads out.
 */
export function JoinTable({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const found = useTableStore((s) => s.found);
  const joining = useTableStore((s) => s.joining);
  const error = useTableStore((s) => s.error);
  const notice = useTableStore((s) => s.notice);
  const clearNotice = useTableStore((s) => s.clearNotice);
  const discover = useTableStore((s) => s.discover);
  const clearFound = useTableStore((s) => s.clearFound);
  const stopDiscovery = useTableStore((s) => s.stopDiscovery);
  const join = useTableStore((s) => s.join);
  const clearError = useTableStore((s) => s.clearError);

  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState<FoundTable | null>(null);
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchTimers = useRef<{ poll: number; end: number } | null>(null);

  function stopSearch() {
    const t = searchTimers.current;
    if (t) {
      window.clearInterval(t.poll);
      window.clearTimeout(t.end);
      searchTimers.current = null;
    }
    setSearching(false);
    void stopDiscovery();
  }

  /** Listens for a few seconds, polling what has turned up, then stops. */
  function startSearch() {
    stopSearch();
    clearFound();
    setPicked(null);
    setManual(false);
    setSearching(true);
    setSearched(true);
    void discover();
    const poll = window.setInterval(() => void discover(), POLL_MS);
    const end = window.setTimeout(() => {
      void discover().then(() => stopSearch());
    }, SEARCH_MS);
    searchTimers.current = { poll, end };
  }

  // Leaving the screen stops any search in progress.
  useEffect(() => {
    return () => {
      const t = searchTimers.current;
      if (t) {
        window.clearInterval(t.poll);
        window.clearTimeout(t.end);
      }
      void stopDiscovery();
    };
  }, [stopDiscovery]);

  const target = manual ? address.trim() : (picked?.addresses[0] ?? "");
  const canJoin =
    Boolean(target) && name.trim().length > 0 && code.trim().length > 0;

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    if (!canJoin) return;
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* no storage; fine */
    }
    const ok = await join(target, name.trim(), code.trim());
    if (ok) setCode("");
  }

  const formOpen = manual || picked !== null;
  const status = searching
    ? "Listening for a GM hosting on this network…"
    : found.length > 0
      ? `${found.length} ${found.length === 1 ? "table" : "tables"} on this network`
      : searched
        ? "No table found. Is the GM hosting, and are you on the same Wi-Fi?"
        : null;

  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-ink-800 bg-ink-900 p-5">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-ink-200">
          <Radio size={18} />
        </span>
        <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
          <h2 className="text-[15px] font-semibold text-ink-100">{title}</h2>
          <p className="text-[13px] text-[#7d8595]">{description}</p>
        </div>
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={() => {
              setManual((v) => !v);
              setPicked(null);
            }}
            className="text-[13px] text-[#a3abba] hover:text-ember-300"
          >
            {manual ? "Hide address" : "Enter address"}
          </button>
          <button
            type="button"
            onClick={searching ? stopSearch : startSearch}
            className={ACTION}
          >
            {searching ? (
              <Wifi size={16} className="animate-pulse" />
            ) : (
              <Search size={16} />
            )}
            {searching ? "Stop" : searched ? "Search again" : "Find tables"}
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={clearNotice}
            aria-label="Dismiss"
            className="text-amber-200 hover:text-amber-50"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {status && <p className="text-xs text-[#7d8595]">{status}</p>}

      {found.length > 0 && (
        <ul className="divide-y divide-ink-800 overflow-hidden rounded-lg border border-ink-800">
          {found.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-100">{t.name}</div>
                <div className="truncate text-xs text-[#7d8595]">
                  {t.system ? `${t.system} · ` : ""}
                  {t.addresses[0] ?? "no address yet"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPicked(t);
                  setManual(false);
                }}
                disabled={t.addresses.length === 0}
                className={picked?.id === t.id ? PRIMARY : ACTION}
              >
                Join
              </button>
            </li>
          ))}
        </ul>
      )}

      {formOpen && (
        <form
          onSubmit={(e) => void handleJoin(e)}
          className="flex flex-col gap-3 border-t border-ink-800 pt-4"
        >
          {picked && !manual && (
            <p className="text-sm text-ink-300">
              Joining <span className="text-ink-100">{picked.name}</span>
            </p>
          )}
          {manual && (
            <label className="block text-sm">
              <span className="text-ink-300">GM's address</span>
              <input
                autoFocus
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="192.168.1.20:51234"
                className={`${FIELD} font-mono`}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            <label className="block flex-1 text-sm">
              <span className="text-ink-300">Your name</span>
              <input
                autoFocus={!manual}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="As the GM knows you"
                className={FIELD}
              />
            </label>
            <label className="block w-40 text-sm">
              <span className="text-ink-300">Join code</span>
              <input
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                placeholder="6 digits"
                className={`${FIELD} font-mono tracking-[0.2em] placeholder:tracking-normal`}
              />
            </label>
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
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
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!canJoin || joining}
              className={PRIMARY}
            >
              {joining ? "Joining…" : "Sit down"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setManual(false);
              }}
              className={ACTION}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
