import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowRight, FolderOpen, FolderPlus, Shield, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import appIcon from "@/assets/icon.png";
import { ErrorBanner } from "@/components/ErrorBanner";
import { JoinTable } from "@/features/table/JoinTable";
import { VersionLine } from "@/features/updates/VersionLine";
import {
  forgetCampaign,
  getRecentCampaigns,
  relativeOpened,
  type RecentCampaign,
} from "@/lib/recent";
import {
  DEFAULT_RULES,
  RULESETS,
  rulesetById,
  type RulesId,
} from "@/features/templates/rulesets";
import { useCampaignStore } from "@/stores/campaign-store";

const GUIDE_URL = "https://serwidlick.github.io/campaign-forge/guide/";

const PRIMARY =
  "inline-flex h-[46px] items-center gap-2.5 rounded-lg bg-ember-500 px-5 text-[15px] font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";
const GHOST =
  "inline-flex h-[46px] items-center gap-2.5 rounded-lg border border-ink-700 px-5 text-[15px] font-medium text-ink-100 transition hover:border-ink-500 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50";
const FIELD =
  "mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";

async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

function initialOf(name: string): string {
  return (name.replace(/^the\s+/i, "").trim()[0] ?? "?").toUpperCase();
}

/**
 * The first screen. A returning GM gets their recent campaigns with the
 * latest one ready to continue; a first run explains what a campaign is.
 * Players find the table from here too.
 *
 * Wide windows show two columns; narrow ones a single column in the order
 * identity, recents, join, footer.
 */
export function WelcomeScreen() {
  const busy = useCampaignStore((s) => s.busy);
  const openCampaign = useCampaignStore((s) => s.openCampaign);
  const createCampaign = useCampaignStore((s) => s.createCampaign);
  const setError = useCampaignStore((s) => s.setError);

  const [recent, setRecent] = useState<RecentCampaign[] | null>(null);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftSystem, setDraftSystem] = useState("");
  const [draftRules, setDraftRules] = useState<RulesId>(DEFAULT_RULES);

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
    const ruleset = rulesetById(draftRules);
    const system =
      ruleset.id === "generic" ? draftSystem.trim() : ruleset.system;
    await createCampaign(
      draftPath,
      draftName.trim(),
      system || undefined,
      draftRules,
    );
  }

  async function handleForget(path: string) {
    await forgetCampaign(path);
    setRecent((r) => (r ?? []).filter((c) => c.path !== path));
  }

  async function handleReveal(path: string) {
    try {
      await revealItemInDir(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const list = recent ?? [];
  const firstRun = recent !== null && list.length === 0;
  const [latest, ...others] = list;

  return (
    <div className="relative h-full overflow-auto bg-ink-950 text-ink-100">
      <ErrorBanner />
      <Contours />
      <div className="relative mx-auto flex min-h-full max-w-[660px] flex-col gap-10 px-10 pt-20 pb-7 lg:max-w-[1160px] lg:gap-12 lg:px-12 lg:pt-[72px]">
        <div className="grid flex-1 gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,42fr)_minmax(0,46fr)] lg:items-start">
          {/* ---- Identity and actions ------------------------------------ */}
          <section className="order-1 flex min-w-0 flex-col gap-[22px] lg:col-start-1 lg:row-start-1 lg:gap-8">
            <div className="flex flex-col gap-5">
              <img
                src={appIcon}
                alt=""
                width={80}
                height={80}
                className="h-20 w-20 rounded-[18px] lg:h-[72px] lg:w-[72px] lg:rounded-2xl"
                draggable={false}
              />
              <div className="flex flex-col gap-3">
                <p className="text-xs font-semibold tracking-[0.14em] text-ember-500 uppercase">
                  {firstRun ? "Welcome" : "For game masters"}
                </p>
                <h1 className="font-serif text-[52px] leading-[1.05] font-semibold tracking-[-0.01em] text-ink-100">
                  {firstRun ? "Start your first campaign" : "Campaign Forge"}
                </h1>
                <p className="max-w-[480px] text-[17px] leading-[1.55] text-[#a3abba] lg:max-w-[440px]">
                  {firstRun
                    ? "Pick an empty folder and Campaign Forge will set it up. Already have one? Open it and carry on."
                    : "Your world, in plain Markdown files on your own disk. No account, no server, works offline."}
                </p>
              </div>
            </div>

            {draftPath ? (
              <form
                onSubmit={handleCreate}
                className="flex flex-col gap-3 rounded-xl border border-ink-800 bg-ink-900 p-5"
              >
                <p className="text-xs text-[#7d8595]">
                  New campaign in{" "}
                  <span className="font-mono text-ink-200">{draftPath}</span>
                </p>
                <label className="block text-sm">
                  <span className="text-ink-300">Campaign name</span>
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className={FIELD}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-300">Rules</span>
                  <select
                    value={draftRules}
                    onChange={(e) => setDraftRules(e.target.value as RulesId)}
                    className={FIELD}
                  >
                    {RULESETS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-[#7d8595]">
                    {rulesetById(draftRules).blurb}
                  </span>
                </label>
                {draftRules === "generic" && (
                  <label className="block text-sm">
                    <span className="text-ink-300">Game system (optional)</span>
                    <input
                      value={draftSystem}
                      onChange={(e) => setDraftSystem(e.target.value)}
                      placeholder="Daggerheart, Call of Cthulhu, Pathfinder…"
                      className={FIELD}
                    />
                  </label>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || !draftName.trim()}
                    className={PRIMARY}
                  >
                    Create campaign
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftPath(null)}
                    className={GHOST}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() =>
                    void (firstRun ? handleStartCreate() : handleOpen())
                  }
                  disabled={busy}
                  className={PRIMARY}
                >
                  {firstRun ? (
                    <>
                      <FolderPlus size={18} /> New campaign
                    </>
                  ) : (
                    <>
                      <FolderOpen size={18} /> Open campaign folder
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void (firstRun ? handleOpen() : handleStartCreate())
                  }
                  disabled={busy}
                  className={GHOST}
                >
                  {firstRun ? (
                    <>
                      <FolderOpen size={18} /> Open campaign folder
                    </>
                  ) : (
                    <>
                      <FolderPlus size={18} /> New campaign
                    </>
                  )}
                </button>
              </div>
            )}
          </section>

          {/* ---- Recents, or what a campaign is -------------------------- */}
          <section className="order-2 flex min-w-0 flex-col gap-3.5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            {recent === null ? null : firstRun ? (
              <FolderExplainer />
            ) : (
              <>
                <div className="flex items-baseline justify-between">
                  <h2 className="text-xs font-semibold tracking-[0.12em] text-[#7d8595] uppercase">
                    Recent campaigns
                  </h2>
                  <button
                    type="button"
                    onClick={() => void handleOpen()}
                    className="text-xs text-[#a3abba] hover:text-ember-300"
                  >
                    Open another folder…
                  </button>
                </div>

                {latest && (
                  <div className="flex flex-col gap-[18px] rounded-xl border border-ink-700 bg-ink-900 p-6 lg:p-[22px]">
                    <div className="flex items-start gap-4">
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[10px] bg-[#2a2119] font-serif text-[26px] font-semibold text-ember-500 lg:h-[52px] lg:w-[52px] lg:text-2xl">
                        {initialOf(latest.name)}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="text-xs font-semibold text-ember-500">
                          Last opened {relativeOpened(latest.openedAt)}
                        </span>
                        <span className="font-serif text-2xl font-semibold text-ink-100 lg:text-[22px]">
                          {latest.name}
                        </span>
                        <span className="truncate font-mono text-xs text-[#7d8595]">
                          {latest.path}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => void openCampaign(latest.path)}
                        disabled={busy}
                        className="inline-flex h-[42px] items-center gap-2 rounded-lg bg-ember-500 px-[18px] text-sm font-semibold text-ink-950 transition hover:brightness-110 disabled:opacity-50 lg:h-10 lg:px-4"
                      >
                        Continue <ArrowRight size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReveal(latest.path)}
                        className="inline-flex h-[42px] items-center rounded-lg border border-ink-700 px-3.5 text-sm text-ink-200 transition hover:border-ink-500 hover:bg-ink-800 lg:h-10"
                      >
                        Show folder
                      </button>
                    </div>
                  </div>
                )}

                {others.length > 0 && (
                  <ul className="flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
                    {others.map((c, i) => (
                      <li
                        key={c.path}
                        className={`flex items-center gap-3.5 py-3 pr-3 pl-4 hover:bg-ink-850 ${
                          i > 0 ? "border-t border-ink-800" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => void openCampaign(c.path)}
                          disabled={busy}
                          className="flex min-h-11 min-w-0 flex-1 items-center gap-3.5 text-left"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-800 font-serif text-base font-semibold text-ink-200">
                            {initialOf(c.name)}
                          </span>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium text-ink-100">
                              {c.name}
                            </span>
                            <span className="truncate font-mono text-xs text-[#7d8595]">
                              {c.path}
                            </span>
                          </span>
                        </button>
                        <span className="text-xs whitespace-nowrap text-[#7d8595]">
                          {relativeOpened(c.openedAt)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleForget(c.path)}
                          aria-label={`Remove ${c.name} from recent`}
                          title="Remove from recent"
                          className="flex h-8 w-8 items-center justify-center rounded-md text-[#7d8595] hover:bg-ink-800 hover:text-ink-200"
                        >
                          <X size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {/* ---- Join a table ---------------------------------------------- */}
          <section className="order-3 min-w-0 lg:col-start-1 lg:row-start-2">
            <JoinTable
              title={firstRun ? "Here to play?" : "Join a table"}
              description={
                firstRun
                  ? "Players don't need a campaign folder. Join your GM's table on this network."
                  : "Playing, not running? Find your GM's table on this network."
              }
            />
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-850 pt-5 text-xs text-[#7d8595]">
          <span>
            <VersionLine />
            {" · "}
            <button
              type="button"
              onClick={() => void openUrl(GUIDE_URL)}
              className="text-[#a3abba] hover:text-ember-300"
            >
              Guide
            </button>
          </span>
          <span className="inline-flex items-center gap-2">
            <Shield size={14} /> Everything stays in folders you choose
          </span>
        </footer>
      </div>
    </div>
  );
}

/** The tree and three promises shown on a first run. */
function FolderExplainer() {
  return (
    <>
      <h2 className="text-xs font-semibold tracking-[0.12em] text-[#7d8595] uppercase">
        A campaign is just a folder
      </h2>
      <div className="flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
        <div className="flex items-center gap-2 border-b border-ink-800 px-[18px] py-3 font-mono text-xs text-[#7d8595]">
          <span className="h-2 w-2 rounded-full bg-ember-500" /> my-campaign
        </div>
        <pre className="overflow-x-auto px-[18px] pt-[18px] pb-5 font-mono text-[13px] leading-[1.9] text-ink-200">
          {"campaign.json        "}
          <span className="text-[#7d8595]">name, system, calendar</span>
          {
            "\nelements/\n  character/\n    harbourmaster-ivel.md\n  location/\n    the-rusty-tankard.md\n  map/\n    sword-coast.md\nassets/\n  maps/sword-coast.png"
          }
        </pre>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          [
            "Plain Markdown",
            "Open, edit or back up any file with the tools you already use.",
          ],
          [
            "Works offline",
            "No account and no server. Your world stays on your disk.",
          ],
          [
            "Safe to rename",
            "Links follow each element's id, so renames never break them.",
          ],
        ].map(([title, text]) => (
          <div
            key={title}
            className="flex flex-col gap-1.5 rounded-[10px] border border-ink-800 bg-ink-900 p-4"
          >
            <span className="text-sm font-semibold text-ink-100">{title}</span>
            <span className="text-[13px] leading-[1.45] text-[#7d8595]">
              {text}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

const CONTOUR_PATHS = [
  "M400 120c120-6 250 60 282 180 30 116-26 250-140 300-120 52-280 30-354-74-70-98-50-250 40-330 46-40 104-72 172-76z",
  "M402 165c98-4 200 50 226 148 24 94-20 202-112 244-98 42-226 24-286-60-56-80-40-202 32-268 38-34 84-60 140-64z",
  "M404 210c76-3 152 38 172 114 18 72-16 156-86 188-76 32-174 18-220-46-44-62-30-156 26-206 28-26 64-46 108-50z",
  "M406 256c52-2 104 26 118 78 12 50-12 106-60 128-52 22-118 12-150-32-30-42-20-106 18-140 20-18 44-32 74-34z",
  "M408 300c30-1 60 16 68 46 8 28-6 60-34 72-30 14-68 8-86-18-18-24-12-60 10-80 12-10 26-18 42-20z",
  "M398 74c150-8 312 74 352 224 38 146-32 312-176 376-150 64-350 36-442-94-88-122-62-312 50-412 58-50 130-90 216-94z",
  "M394 28c178-10 370 88 418 266 44 172-38 370-208 446-178 76-414 42-524-112-104-144-74-370 60-488 68-60 152-106 254-112z",
];

/** Faint contour lines, like a map's: top-right always, bottom-left when narrow. */
function Contours() {
  return (
    <>
      <svg
        aria-hidden="true"
        viewBox="0 0 800 800"
        fill="none"
        stroke="#1d2028"
        strokeWidth="1.25"
        className="pointer-events-none absolute -top-[300px] -right-[340px] h-[860px] w-[860px] lg:-top-[260px] lg:-right-[220px] lg:h-[900px] lg:w-[900px]"
      >
        {CONTOUR_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 800 800"
        fill="none"
        stroke="#191b22"
        strokeWidth="1.25"
        className="pointer-events-none absolute -bottom-[380px] -left-[420px] h-[820px] w-[820px] lg:hidden"
      >
        {[0, 2, 5, 6].map((i) => (
          <path key={i} d={CONTOUR_PATHS[i]} />
        ))}
      </svg>
    </>
  );
}
