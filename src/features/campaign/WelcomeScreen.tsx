import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderPlus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { JoinTable } from "@/features/table/JoinTable";
import { VersionLine } from "@/features/updates/VersionLine";
import {
  forgetCampaign,
  getRecentCampaigns,
  type RecentCampaign,
} from "@/lib/recent";
import { useCampaignStore } from "@/stores/campaign-store";

async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export function WelcomeScreen() {
  const busy = useCampaignStore((s) => s.busy);
  const openCampaign = useCampaignStore((s) => s.openCampaign);
  const createCampaign = useCampaignStore((s) => s.createCampaign);

  const [recent, setRecent] = useState<RecentCampaign[]>([]);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftSystem, setDraftSystem] = useState("");

  useEffect(() => {
    void getRecentCampaigns().then(setRecent);
  }, []);

  async function handleOpen() {
    const path = await pickFolder("Open a campaign folder");
    if (path) await openCampaign(path);
  }

  async function handleStartCreate() {
    const path = await pickFolder(
      "Choose an empty folder for the new campaign",
    );
    if (!path) return;
    setDraftPath(path);
    setDraftName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!draftPath || !draftName.trim()) return;
    await createCampaign(
      draftPath,
      draftName.trim(),
      draftSystem.trim() || undefined,
    );
  }

  async function handleForget(path: string) {
    await forgetCampaign(path);
    setRecent((r) => r.filter((c) => c.path !== path));
  }

  return (
    <div className="flex h-full flex-col">
      <ErrorBanner />
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          <header className="mb-10">
            <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink-100">
              Campaign Forge
            </h1>
            <p className="mt-2 text-ink-400">
              Your world, in plain files on your own disk. Open a campaign
              folder or start a new one.
            </p>
          </header>

          {draftPath ? (
            <form
              onSubmit={handleCreate}
              className="rounded-lg border border-ink-700 bg-ink-900 p-5"
            >
              <p className="mb-4 text-xs text-ink-400">
                New campaign in{" "}
                <span className="font-mono text-ink-200">{draftPath}</span>
              </p>
              <label className="block text-sm">
                <span className="text-ink-300">Campaign name</span>
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-ink-100 outline-none focus:border-ember-500"
                />
              </label>
              <label className="mt-3 block text-sm">
                <span className="text-ink-300">Game system (optional)</span>
                <input
                  value={draftSystem}
                  onChange={(e) => setDraftSystem(e.target.value)}
                  placeholder="D&D 5e, Daggerheart, Call of Cthulhu…"
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500"
                />
              </label>
              <div className="mt-5 flex gap-2">
                <Button type="submit" disabled={busy || !draftName.trim()}>
                  Create campaign
                </Button>
                <Button variant="ghost" onClick={() => setDraftPath(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex gap-3">
              <Button onClick={handleOpen} disabled={busy}>
                <FolderOpen size={16} /> Open campaign folder
              </Button>
              <Button
                variant="ghost"
                onClick={handleStartCreate}
                disabled={busy}
              >
                <FolderPlus size={16} /> New campaign
              </Button>
            </div>
          )}

          {recent.length > 0 && !draftPath && (
            <section className="mt-10">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Recent
              </h2>
              <ul className="divide-y divide-ink-800 rounded-lg border border-ink-800 bg-ink-900">
                {recent.map((c) => (
                  <li
                    key={c.path}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => void openCampaign(c.path)}
                      disabled={busy}
                      className="flex-1 text-left"
                    >
                      <div className="text-sm text-ink-100">{c.name}</div>
                      <div className="truncate font-mono text-xs text-ink-400">
                        {c.path}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleForget(c.path)}
                      aria-label={`Remove ${c.name} from recent`}
                      className="rounded p-1 text-ink-600 hover:bg-ink-800 hover:text-ink-300"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!draftPath && <JoinTable />}
          <VersionLine />
        </div>
      </main>
    </div>
  );
}
