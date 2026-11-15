import { open } from "@tauri-apps/plugin-dialog";
import {
  BookOpenCheck,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/Button";
import {
  MODELS,
  estimateCostUsd,
  formatTokens,
  formatUsd,
  loadAgentSettings,
} from "@/features/agent/agent-settings";
import { kindById } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";
import { useImportStore } from "@/stores/import-store";

import {
  CHUNK_CHARS,
  IMPORTABLE_KINDS,
  chunkPages,
  estimateImportCostUsd,
  formatPages,
  type Proposal,
} from "./pdf-import";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";

/**
 * Import a PDF and build elements from it: choose the file, see how much
 * text it holds, say what to look for, let the model read it, tick what to
 * keep, write the files. Runs in the main column like any other panel.
 */
export function ImportPdfPanel({ onClose }: { onClose: () => void }) {
  const stage = useImportStore((s) => s.stage);
  const error = useImportStore((s) => s.error);
  const clearError = useImportStore((s) => s.clearError);
  const reset = useImportStore((s) => s.reset);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-2">
        <BookOpenCheck size={15} className="text-ember-400" />
        <h2 className="text-sm font-semibold">Import a PDF</h2>
        <span className="flex-1" />
        {stage !== "idle" && stage !== "building" && stage !== "writing" && (
          <Button size="sm" variant="ghost" onClick={reset}>
            Start over
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-200"
        >
          <X size={14} />
        </button>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200"
        >
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          {stage === "idle" || stage === "extracting" ? (
            <ChooseStep />
          ) : stage === "ready" ? (
            <OptionsStep />
          ) : stage === "building" ? (
            <BuildingStep />
          ) : stage === "review" || stage === "writing" ? (
            <ReviewStep />
          ) : (
            <DoneStep onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 1. Choose --------------------------------------------------------------------

function ChooseStep() {
  const stage = useImportStore((s) => s.stage);
  const load = useImportStore((s) => s.load);

  async function choose() {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose a PDF or text file to build from",
      filters: [
        { name: "PDF or text", extensions: ["pdf", "txt", "md"] },
        { name: "PDF", extensions: ["pdf"] },
        { name: "Text", extensions: ["txt", "text", "md", "markdown"] },
      ],
    });
    if (typeof picked !== "string") return;
    await load(picked);
  }

  const busy = stage === "extracting";
  return (
    <section className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-ink-700 bg-ink-900/60 px-8 py-12 text-center">
      <FileText size={32} className="text-ink-600" />
      <div className="max-w-md space-y-2 text-sm text-ink-400">
        <p>
          Pick an adventure module, a setting guide or your own notes as a PDF
          or a plain-text file. The app reads its text, the assistant&apos;s
          model picks out the people, places, factions, creatures, items,
          quests, events and lore it describes, and you choose which become
          elements.
        </p>
        <p className="text-xs text-ink-500">
          A scanned PDF needs its OCR text layer; if the archive you got it from
          also offers a full-text file, that is the cleaner choice.
        </p>
        <p className="text-xs text-ink-500">
          The book&apos;s text is sent to Anthropic with your own API key, in
          parts. Nothing is written to the campaign until you press Create.
        </p>
      </div>
      <Button onClick={() => void choose()} disabled={busy}>
        <FileUp size={16} /> {busy ? "Reading…" : "Choose a file"}
      </Button>
    </section>
  );
}

// ---- 2. Options -------------------------------------------------------------------

function OptionsStep() {
  const source = useImportStore((s) => s.source);
  const options = useImportStore((s) => s.options);
  const setOptions = useImportStore((s) => s.setOptions);
  const build = useImportStore((s) => s.build);
  const [model, setModel] = useState<string | null>(null);

  useEffect(() => {
    void loadAgentSettings().then((s) => setModel(s.model));
  }, []);

  const text = source?.text;
  const pageCount = text?.pageCount ?? 0;
  const from = options.from ?? 1;
  const to = options.to ?? pageCount;

  // Text in the chosen range, for the size and cost line.
  const rangeChars = useMemo(() => {
    if (!text) return 0;
    let n = 0;
    for (let i = 0; i < text.pages.length; i++) {
      const page = text.firstPage + i;
      if (page >= from && page <= to) n += text.pages[i]!.length;
    }
    return n;
  }, [text, from, to]);
  const chunkCount = useMemo(() => {
    if (!text) return 0;
    const sliced = {
      ...text,
      firstPage: from,
      pages: text.pages.slice(from - text.firstPage, to - text.firstPage + 1),
    };
    return chunkPages(sliced).length;
  }, [text, from, to]);
  const cost = model
    ? estimateImportCostUsd(rangeChars, chunkCount, model)
    : null;
  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;

  if (!source || !text) return null;

  const emptyShare = text.pages.length
    ? text.emptyPages / text.pages.length
    : 0;
  const scanned = rangeChars < 200 || emptyShare > 0.8;

  function toggleKind(kind: (typeof IMPORTABLE_KINDS)[number]) {
    const has = options.kinds.includes(kind);
    setOptions({
      kinds: has
        ? options.kinds.filter((k) => k !== kind)
        : [...options.kinds, kind],
    });
  }

  function setRange(key: "from" | "to", raw: string) {
    const n = Number.parseInt(raw, 10);
    setOptions({
      [key]: Number.isFinite(n) && n >= 1 && n <= pageCount ? n : undefined,
    });
  }

  return (
    <div className="space-y-6">
      <section className="flex items-start gap-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3">
        <FileText size={18} className="mt-0.5 shrink-0 text-ember-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink-100">
            {source.name}
          </div>
          <div className="text-xs text-ink-400">
            {pageCount} {source.kind === "text" ? "part" : "page"}
            {pageCount === 1 ? "" : "s"} · {formatTokens(text.chars)} characters
            of text
            {text.emptyPages > 0 && <> · {text.emptyPages} without text</>}
            {text.truncated && <> · cut at the size limit</>}
          </div>
          {scanned && (
            <p className="mt-2 text-xs text-amber-200/90">
              Hardly any text came out. This is probably a scanned PDF (pictures
              of pages). It would need OCR in another tool first; the import can
              only read real text.
            </p>
          )}
        </div>
      </section>

      <section>
        <Label>What to look for</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {IMPORTABLE_KINDS.map((k) => {
            const on = options.kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleKind(k)}
                aria-pressed={on}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  on
                    ? "border-ember-500/60 bg-ember-500/15 text-ember-200"
                    : "border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200"
                }`}
              >
                {kindById(k).plural}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <Label>About this book</Label>
        <textarea
          value={options.guidance}
          onChange={(e) => setOptions({ guidance: e.target.value })}
          rows={2}
          placeholder="Optional. e.g. “An adventure for levels 1–5 set in the Sword Coast; the party has already met the villain.” or “Only the bestiary chapter matters.”"
          className={`${FIELD} mt-2 w-full resize-none`}
        />
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div>
          <Label>Pages</Label>
          <div className="mt-2 flex items-center gap-2 text-sm text-ink-300">
            <input
              type="number"
              min={1}
              max={pageCount}
              value={from}
              onChange={(e) => setRange("from", e.target.value)}
              className={`${FIELD} w-20`}
              aria-label="First page"
            />
            <span>to</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={to}
              onChange={(e) => setRange("to", e.target.value)}
              className={`${FIELD} w-20`}
              aria-label="Last page"
            />
            <span className="text-xs text-ink-500">of {pageCount}</span>
          </div>
        </div>
        <div>
          <Label>Keep the file</Label>
          {source.kind === "pdf" ? (
            <label className="mt-2 flex items-start gap-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={options.attachDocument}
                onChange={(e) =>
                  setOptions({ attachDocument: e.target.checked })
                }
                className="mt-0.5 accent-ember-500"
              />
              <span>
                Copy it into the campaign as a Document and cite its pages from
                every element made from it.
              </span>
            </label>
          ) : (
            <p className="mt-2 text-sm text-ink-500">
              A text file is read but not kept; elements cite it by name and
              part. Import the PDF as well if you want the book in the campaign.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3 text-xs text-ink-400">
        <div className="flex flex-wrap items-center gap-x-2">
          <span>
            {chunkCount} model call{chunkCount === 1 ? "" : "s"} of up to{" "}
            {formatTokens(CHUNK_CHARS)} characters each
          </span>
          <span>·</span>
          <span>{modelLabel ?? "assistant model"}</span>
          {cost !== null && (
            <>
              <span>·</span>
              <span>
                roughly {formatUsd(cost)}
                {cost >= 0.005 && cost < 0.05 ? "" : " at list price"}
              </span>
            </>
          )}
        </div>
        <p className="mt-1 text-ink-500">
          The model and effort are the assistant&apos;s; change them in its
          settings (the sparkle button). The estimate is rough: a dense book
          costs more, a sparse one less.
        </p>
      </section>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => void build()}
          disabled={options.kinds.length === 0 || chunkCount === 0}
        >
          <BookOpenCheck size={16} /> Read the book
        </Button>
        {chunkCount === 0 && (
          <span className="text-xs text-ink-500">
            No text in the chosen pages.
          </span>
        )}
      </div>
    </div>
  );
}

// ---- 3. Building ------------------------------------------------------------------

function BuildingStep() {
  const progress = useImportStore((s) => s.progress);
  const proposals = useImportStore((s) => s.proposals);
  const failures = useImportStore((s) => s.failures);
  const cancel = useImportStore((s) => s.cancel);
  if (!progress) return null;
  const pct = progress.chunks
    ? Math.round((progress.chunk / progress.chunks) * 100)
    : 0;
  const cost = estimateCostUsd(progress.usage, progress.model);
  const recent = proposals.slice(-6).reverse();
  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-200">
            Reading part {Math.min(progress.chunk + 1, progress.chunks)} of{" "}
            {progress.chunks}
          </span>
          <span className="text-xs text-ink-500">
            {formatTokens(
              progress.usage.input +
                progress.usage.cacheRead +
                progress.usage.cacheWrite,
            )}{" "}
            in · {formatTokens(progress.usage.output)} out
            {cost !== null && <> · ≈ {formatUsd(cost)}</>}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full bg-ember-500 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-ink-400">
          <span>
            {progress.found} element{progress.found === 1 ? "" : "s"} so far
          </span>
          {progress.failed > 0 && (
            <span className="text-amber-200/80">
              {progress.failed} part{progress.failed === 1 ? "" : "s"} failed
            </span>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={cancel}>
            <Square size={12} /> Stop and review what was found
          </Button>
        </div>
      </section>
      {recent.length > 0 && (
        <section>
          <Label>Latest</Label>
          <ul className="mt-2 space-y-1 text-sm">
            {recent.map((p) => (
              <li key={p.key} className="flex items-center gap-2 text-ink-300">
                <span className="w-20 shrink-0 text-xs text-ink-500">
                  {kindById(p.kind).label}
                </span>
                <span className="truncate">{p.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {failures.length > 0 && <FailureList failures={failures} />}
    </div>
  );
}

function FailureList({ failures }: { failures: string[] }) {
  return (
    <section className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100/90">
      <div className="font-medium">Parts that could not be read</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-200/80">
        {failures.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </section>
  );
}

// ---- 4. Review --------------------------------------------------------------------

function ReviewStep() {
  const stage = useImportStore((s) => s.stage);
  const proposals = useImportStore((s) => s.proposals);
  const failures = useImportStore((s) => s.failures);
  const options = useImportStore((s) => s.options);
  const sourceKind = useImportStore((s) => s.source?.kind);
  const writeProgress = useImportStore((s) => s.writeProgress);
  const toggle = useImportStore((s) => s.toggle);
  const setAll = useImportStore((s) => s.setAll);
  const write = useImportStore((s) => s.write);
  const backToOptions = useImportStore((s) => s.backToOptions);

  const writing = stage === "writing";
  const attaching = options.attachDocument && sourceKind === "pdf";
  const chosen = proposals.filter((p) => p.selected);
  const newCount = chosen.filter((p) => !p.existingId).length;
  const appendCount = chosen.length - newCount;

  const groups = useMemo(() => {
    const map = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const list = map.get(p.kind) ?? [];
      list.push(p);
      map.set(p.kind, list);
    }
    return Array.from(map.entries());
  }, [proposals]);

  if (proposals.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink-400">
          Nothing to propose: the model found no named people, places or things
          of the kinds you ticked in that text.
        </p>
        {failures.length > 0 && <FailureList failures={failures} />}
        <Button variant="ghost" onClick={backToOptions}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-200">
          {proposals.length} found · {chosen.length} ticked
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-xs text-ink-400 hover:text-ink-200"
        >
          Tick all
        </button>
        <button
          type="button"
          onClick={() => setAll(false)}
          className="text-xs text-ink-400 hover:text-ink-200"
        >
          Untick all
        </button>
      </section>

      {failures.length > 0 && <FailureList failures={failures} />}

      {groups.map(([kind, list]) => (
        <section key={kind}>
          <Label>
            {kindById(kind).plural} · {list.length}
          </Label>
          <ul className="mt-2 divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900/60">
            {list.map((p) => (
              <ProposalRow
                key={p.key}
                proposal={p}
                disabled={writing}
                onToggle={() => toggle(p.key)}
              />
            ))}
          </ul>
        </section>
      ))}

      <section className="sticky bottom-0 -mx-6 border-t border-ink-800 bg-ink-950/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void write()}
            disabled={writing || chosen.length === 0}
          >
            {writing
              ? writeProgress
                ? `Writing ${writeProgress.done} of ${writeProgress.total}…`
                : "Writing…"
              : `Create ${newCount} element${newCount === 1 ? "" : "s"}${
                  appendCount > 0 ? ` and add to ${appendCount} existing` : ""
                }${attaching ? " + the document" : ""}`}
          </Button>
          <Button variant="ghost" onClick={backToOptions} disabled={writing}>
            Back
          </Button>
          <span className="text-xs text-ink-500">
            Each element cites its pages and links the others by id. Elements
            already in the campaign get a new section appended instead.
          </span>
        </div>
      </section>
    </div>
  );
}

function ProposalRow({
  proposal: p,
  disabled,
  onToggle,
}: {
  proposal: Proposal;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={p.selected}
          onChange={onToggle}
          disabled={disabled}
          aria-label={`Keep ${p.name}`}
          className="mt-1 accent-ember-500"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-100">{p.name}</span>
            {p.existingId && (
              <span
                className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-300"
                title="An element of this kind and name already exists; ticking it appends a section"
              >
                already here · appends
              </span>
            )}
            {p.pages.length > 0 && (
              <span className="text-[11px] text-ink-500">
                {formatPages(p.pages)}
              </span>
            )}
          </div>
          {p.summary && (
            <p className="mt-0.5 text-xs text-ink-400">{p.summary}</p>
          )}
          {p.tags.length > 0 && (
            <p className="mt-0.5 text-[11px] text-ink-600">
              {p.tags.join(", ")}
            </p>
          )}
          {open && (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-950 px-3 py-2 font-sans text-xs leading-relaxed text-ink-300">
              {p.body || "(no body, only the summary)"}
              {p.fields && (
                <>
                  {"\n\n"}
                  <span className="text-ink-500">
                    fields: {JSON.stringify(p.fields, null, 1)}
                  </span>
                </>
              )}
            </pre>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? "Hide the body" : "Show the body"}
          aria-label={open ? "Hide the body" : "Show the body"}
          aria-expanded={open}
          className="rounded p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
    </li>
  );
}

// ---- 5. Done ----------------------------------------------------------------------

function DoneStep({ onClose }: { onClose: () => void }) {
  const result = useImportStore((s) => s.result);
  const reset = useImportStore((s) => s.reset);
  const navigate = useCampaignStore((s) => s.navigate);
  if (!result) return null;
  const all = [...result.created, ...result.updated];

  function openElement(id: string, pane: boolean) {
    void navigate(id, { pane });
    onClose();
  }

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-base font-semibold text-ink-100">
          {result.created.length} element
          {result.created.length === 1 ? "" : "s"} created
          {result.updated.length > 0 && <>, {result.updated.length} added to</>}
        </h3>
        <p className="mt-1 text-sm text-ink-400">
          Every one is tagged <code className="text-ink-300">imported</code> and
          cites the pages it came from. Read them with the book open and delete
          or rewrite anything the model got wrong: these are notes about the
          text, not the text.
        </p>
      </section>
      {result.documentId && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openElement(result.documentId!, false)}
        >
          <FileText size={14} /> Open the document
        </Button>
      )}
      <ul className="divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900/60">
        {all.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={(ev) => openElement(e.id, ev.ctrlKey || ev.metaKey)}
              title="Click to open · Ctrl+click to open beside"
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-ink-800"
            >
              <span className="w-24 shrink-0 text-xs text-ink-500">
                {kindById(e.kind).label}
              </span>
              <span className="truncate text-ink-100">{e.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={reset}>
          Import another file
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
      {children}
    </h3>
  );
}
