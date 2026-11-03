import { Radio, Wifi, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/Button";
import type { FoundTable } from "@/lib/types";
import { useTableStore } from "@/stores/table-store";

const DISCOVER_MS = 2000;
const NAME_KEY = "cf.playerName";

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The player's way in: tables found on the network, or a typed address. */
export function JoinTable() {
  const found = useTableStore((s) => s.found);
  const joining = useTableStore((s) => s.joining);
  const error = useTableStore((s) => s.error);
  const notice = useTableStore((s) => s.notice);
  const clearNotice = useTableStore((s) => s.clearNotice);
  const discover = useTableStore((s) => s.discover);
  const stopDiscovery = useTableStore((s) => s.stopDiscovery);
  const join = useTableStore((s) => s.join);
  const clearError = useTableStore((s) => s.clearError);

  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState<FoundTable | null>(null);
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");

  // Browse while this screen is up; stop when it goes away.
  useEffect(() => {
    void discover();
    const id = setInterval(() => void discover(), DISCOVER_MS);
    return () => {
      clearInterval(id);
      void stopDiscovery();
    };
  }, [discover, stopDiscovery]);

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

  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
        <Radio size={12} /> Join a table
      </h2>
      {notice && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
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
      <div className="rounded-lg border border-ink-800 bg-ink-900">
        {found.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-ink-500">
            <Wifi size={14} className="animate-pulse" />
            Looking for a GM hosting on this network…
          </p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {found.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex-1">
                  <div className="text-sm text-ink-100">{t.name}</div>
                  <div className="text-xs text-ink-500">
                    {t.system ? `${t.system} · ` : ""}
                    {t.addresses[0] ?? "no address yet"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={picked?.id === t.id ? "primary" : "ghost"}
                  onClick={() => {
                    setPicked(t);
                    setManual(false);
                  }}
                  disabled={t.addresses.length === 0}
                >
                  Join
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-ink-800 px-4 py-2">
          <button
            type="button"
            onClick={() => {
              setManual((v) => !v);
              setPicked(null);
            }}
            className="text-xs text-ink-400 hover:text-ink-200"
          >
            {manual ? "Hide" : "Join by address instead"}
          </button>
        </div>

        {formOpen && (
          <form
            onSubmit={(e) => void handleJoin(e)}
            className="space-y-3 border-t border-ink-800 px-4 py-4"
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
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500"
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
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500"
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
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono tracking-[0.2em] text-ink-100 outline-none placeholder:tracking-normal placeholder:text-ink-600 focus:border-ember-500"
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
              <Button type="submit" disabled={!canJoin || joining}>
                {joining ? "Joining…" : "Sit down"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPicked(null);
                  setManual(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
