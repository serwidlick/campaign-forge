/**
 * Building campaign elements out of a PDF.
 *
 * The Rust side turns the file into plain text per page. This module cuts
 * that text into chunks the model can hold, asks it for the elements each
 * chunk describes as JSON, merges what comes back across chunks and against
 * the campaign, and finally writes the ones the GM ticked as Markdown files
 * linked by id. Nothing touches disk until `writeProposals`.
 *
 * Uses the assistant's key, model and effort; an import is just a batch of
 * model calls with the same client the chat uses.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { createClient, describeError } from "@/features/agent/agent";
import {
  PRICING,
  type Effort,
  type TurnUsage,
} from "@/features/agent/agent-settings";
import { rulesOf } from "@/features/templates/rulesets";
import { templateFor } from "@/features/templates/templates";
import { storage } from "@/lib/tauri";
import {
  ELEMENT_KINDS,
  elementHref,
  extraOf,
  type CampaignMeta,
  type ElementSummary,
  type PdfText,
} from "@/lib/types";

// ---- Options -----------------------------------------------------------------

/** Kinds a book usually describes. Play kinds (arcs, sessions, journals) and
 *  maps/documents are the GM's own and are never proposed. */
export const IMPORTABLE_KINDS = [
  "character",
  "faction",
  "creature",
  "location",
  "item",
  "quest",
  "event",
  "lore",
] as const;

export type ImportableKind = (typeof IMPORTABLE_KINDS)[number];

export interface ImportOptions {
  kinds: ImportableKind[];
  /** Keep the PDF itself as a Document element and cite it from each body. */
  attachDocument: boolean;
  /** 1-based inclusive page range; undefined means the whole file. */
  from?: number;
  to?: number;
  /** A line from the GM about what the book is and what to look for. */
  guidance: string;
}

export const DEFAULT_OPTIONS: ImportOptions = {
  kinds: [...IMPORTABLE_KINDS],
  attachDocument: true,
  guidance: "",
};

// ---- Chunking -----------------------------------------------------------------

/** ~12k tokens of text per call: big enough that a chapter stays together,
 *  small enough that the answer fits in one reply. */
export const CHUNK_CHARS = 48_000;

export interface Chunk {
  index: number;
  firstPage: number;
  lastPage: number;
  text: string;
}

/** Cuts the pages into chunks of whole pages, labelling each page so the
 *  model can cite where it found something. A page longer than a chunk is
 *  split on its own. */
export function chunkPages(pdf: PdfText): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  /** First and last page with text in the buffer. */
  let first = pdf.firstPage;
  let last = pdf.firstPage;
  let page = pdf.firstPage;

  const push = (text: string) => {
    if (buf.length === 0) first = page;
    last = page;
    buf.push(`[Page ${page}]\n${text}`);
    bufChars += text.length;
  };
  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      index: chunks.length,
      firstPage: first,
      lastPage: last,
      text: buf.join("\n\n"),
    });
    buf = [];
    bufChars = 0;
  };

  for (const raw of pdf.pages) {
    const text = raw.trim();
    if (text) {
      if (text.length > CHUNK_CHARS) {
        flush();
        for (let i = 0; i < text.length; i += CHUNK_CHARS) {
          push(text.slice(i, i + CHUNK_CHARS));
          flush();
        }
      } else {
        if (bufChars + text.length > CHUNK_CHARS) flush();
        push(text);
      }
    }
    page += 1;
  }
  flush();
  return chunks;
}

// ---- Cost ---------------------------------------------------------------------

/** Rough tokens for a run of English prose. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.6);
}

/** Order-of-magnitude cost of one pass over `chars` of text. Output is
 *  assumed to be a quarter of the input, which extraction tends to be. */
export function estimateImportCostUsd(
  chars: number,
  chunkCount: number,
  model: string,
): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const input = estimateTokens(chars) + chunkCount * PROMPT_OVERHEAD_TOKENS;
  const output = estimateTokens(chars) / 4;
  return (input * p.input + output * p.output) / 1_000_000;
}

const PROMPT_OVERHEAD_TOKENS = 1_200;

// ---- The model call -------------------------------------------------------------

const ProposalSchema = z.object({
  kind: z.enum(IMPORTABLE_KINDS),
  name: z.string().min(1).max(200),
  summary: z.string().max(400).optional().default(""),
  tags: z.array(z.string().min(1).max(60)).max(8).optional().default([]),
  body: z.string().max(20_000).optional().default(""),
  pages: z.array(z.number().int().min(1)).max(40).optional().default([]),
  fields: z.record(z.string(), z.unknown()).optional(),
});

const ReplySchema = z.object({
  elements: z.array(ProposalSchema).max(200),
});

export type RawProposal = z.infer<typeof ProposalSchema>;

const STATBLOCK_HINT =
  'For a creature in a D&D 5e book, also return fields.statblock as { size, type, alignment, ac, acNote, hp, hpFormula, speed, abilities: { str, dex, con, int, wis, cha } (scores), saves, skills, vulnerabilities, resistances, immunities, conditionImmunities, senses, languages (strings), cr (such as "1/4" or "5"), traits/actions/bonusActions/reactions/legendary: [{ name, text }] }. Leave out anything the text does not give.';

/** The instructions every chunk is read under; stable so the API caches it. */
export function systemPromptFor(
  campaign: CampaignMeta,
  options: ImportOptions,
): string {
  const dnd5e = rulesOf(campaign) === "dnd5e";
  const kinds = ELEMENT_KINDS.filter((k) =>
    (options.kinds as string[]).includes(k.id),
  )
    .map((k) => `${k.id} (${k.label.toLowerCase()})`)
    .join(", ");
  return [
    "You read tabletop RPG books (adventure modules, setting guides, bestiaries, rulebooks) for a game master and pull out the things a campaign manager should know about, as structured data.",
    "",
    `## The campaign`,
    `Name: ${campaign.name}${campaign.system ? ` · System: ${campaign.system}` : ""}`,
    options.guidance.trim()
      ? `The GM says about this book: ${options.guidance.trim()}`
      : null,
    "",
    "## Your answer",
    "Reply with one JSON object and nothing else, no prose, no code fence:",
    '{ "elements": [ { "kind": "...", "name": "...", "summary": "...", "tags": ["..."], "body": "...", "pages": [12, 13] } ] }',
    "",
    `- kind is one of: ${kinds}. Skip anything that fits none of them.`,
    "- name is the proper name as the book writes it (not a description). One element per named thing; a place inside a place is its own location.",
    "- summary is one sentence, GM-facing, for a review list.",
    "- tags: up to five short lower-case words (a region, a role, a theme). Optional.",
    "- body is Markdown for the GM's notes: two to six short paragraphs or bullet lists that paraphrase what the book says about the thing: who or what it is, what it wants or does, how it connects to other things named in the text, and any hooks or secrets. Use ## headings only when the text clearly has sections. Paraphrase, do not copy passages; stat tables and rules text belong in the book, not here. Mention other elements by their exact names in plain text so they can be linked afterwards.",
    "- pages: the page numbers (from the [Page N] labels) where the thing is described.",
    "- Never invent facts. If the text says little, say little. Leave out things that are only mentioned in passing with nothing said about them.",
    "- Skip tables of contents, indexes, legal text, credits and generic rules.",
    "- If this part of the text introduces the book's premise as a whole (an adventure's background, a region's overview), include one lore element named after the book or region that sums it up.",
    dnd5e ? `- ${STATBLOCK_HINT}` : null,
    "- Only return fields for the statblock case above; otherwise omit fields.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Pulls the outermost JSON object out of a reply, tolerating fences and chatter. */
export function parseReply(text: string): RawProposal[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("the reply contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("the reply was not valid JSON");
  }
  const result = ReplySchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `the reply did not match the expected shape (${first?.path.join(".") ?? "?"}: ${first?.message ?? "?"})`,
    );
  }
  return result.data.elements;
}

const MAX_TOKENS = 16_000;

export interface ChunkCallOptions {
  client: Anthropic;
  model: string;
  effort: Effort;
  system: string;
  signal?: AbortSignal;
}

/** One chunk → the model → proposals. Throws on API or parse failure. */
export async function extractFromChunk(
  chunk: Chunk,
  opts: ChunkCallOptions,
): Promise<{ proposals: RawProposal[]; usage: TurnUsage }> {
  const supportsFallback = !opts.model.includes("haiku");
  const stream = opts.client.beta.messages.stream(
    {
      model: opts.model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: opts.effort },
      system: [
        {
          type: "text",
          text: opts.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Pages ${chunk.firstPage}–${chunk.lastPage} of the book follow. Return the elements they describe as JSON.\n\n${chunk.text}`,
        },
      ],
      ...(supportsFallback
        ? {
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default" as const,
          }
        : {}),
    },
    { signal: opts.signal },
  );
  const message = await stream.finalMessage();
  const usage: TurnUsage = {
    input: message.usage.input_tokens ?? 0,
    output: message.usage.output_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    calls: 1,
  };
  if (message.stop_reason === "refusal") {
    throw new Error("the model declined this part of the text");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("the reply for this part was too long to finish");
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { proposals: parseReply(text), usage };
}

// ---- Merging -------------------------------------------------------------------

export interface Proposal {
  /** kind + normalised name; stable across chunks. */
  key: string;
  kind: ImportableKind;
  name: string;
  summary: string;
  tags: string[];
  body: string;
  pages: number[];
  fields?: Record<string, unknown>;
  /** An element of this kind and name already exists: writing appends. */
  existingId: string | null;
  selected: boolean;
}

export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function proposalKey(kind: string, name: string): string {
  return `${kind}:${normaliseName(name)}`;
}

/** Folds a chunk's proposals into the running list: same kind and name
 *  merge (bodies appended, tags and pages unioned); new ones are appended. */
export function mergeProposals(
  current: Proposal[],
  incoming: RawProposal[],
  existing: ElementSummary[],
): Proposal[] {
  const byKey = new Map(current.map((p) => [p.key, p]));
  const order = current.map((p) => p.key);
  for (const raw of incoming) {
    const name = raw.name.trim();
    if (!name) continue;
    const key = proposalKey(raw.kind, name);
    const prev = byKey.get(key);
    const tags = raw.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    const pages = raw.pages.slice().sort((a, b) => a - b);
    if (prev) {
      byKey.set(key, {
        ...prev,
        summary: prev.summary || raw.summary,
        tags: unique([...prev.tags, ...tags]),
        body: joinBodies(prev.body, raw.body),
        pages: unique([...prev.pages, ...pages]).sort((a, b) => a - b),
        fields: prev.fields ?? raw.fields,
      });
      continue;
    }
    const match = existing.find(
      (e) =>
        e.type === raw.kind && normaliseName(e.name) === normaliseName(name),
    );
    byKey.set(key, {
      key,
      kind: raw.kind,
      name,
      summary: raw.summary.trim(),
      tags: unique(tags),
      body: raw.body.trim(),
      pages,
      fields: raw.fields,
      existingId: match?.id ?? null,
      // Things already in the campaign are opt-in: the GM wrote those.
      selected: !match,
    });
    order.push(key);
  }
  return order.map((k) => byKey.get(k)!);
}

function joinBodies(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right || left.includes(right)) return left;
  return `${left}\n\n${right}`;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export const KIND_ORDER: string[] = ELEMENT_KINDS.map((k) => k.id);

export function sortProposals(list: Proposal[]): Proposal[] {
  return [...list].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );
}

// ---- Writing --------------------------------------------------------------------

export interface WriteResult {
  created: { id: string; name: string; kind: string }[];
  updated: { id: string; name: string; kind: string }[];
  documentId: string | null;
}

export interface WriteOptions {
  campaign: CampaignMeta;
  proposals: Proposal[];
  /** What the citations call the source: the file name without extension. */
  sourceName: string;
  /** Path of a PDF to keep as a Document element, or null to cite by name. */
  attach: string | null;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Writes the selected proposals. New elements start from the ruleset's
 * template (so a 5e character has its sheet) with the proposal's body in
 * place of the skeleton; existing ones get a dated section appended. Once
 * every file exists, plain-text mentions of other imported elements become
 * id links, and each body cites the source pages.
 */
export async function writeProposals(opts: WriteOptions): Promise<WriteResult> {
  const { campaign } = opts;
  const chosen = opts.proposals.filter((p) => p.selected);
  const total = chosen.length + (opts.attach ? 1 : 0);
  let done = 0;
  const tick = () => opts.onProgress?.(++done, total);

  let documentId: string | null = null;
  let sourceLabel = opts.sourceName;
  if (opts.attach) {
    const imported = await storage.importDocument(opts.attach);
    const doc = await storage.createElement("document", imported.name, {
      file: imported.path,
      fileName: imported.name,
      fileBytes: imported.bytes,
    });
    await storage.saveElement({
      id: doc.id,
      name: doc.name,
      tags: ["imported"],
      body: `# ${doc.name}\n\nImported on ${today()}. The elements built from this book cite it by page.\n`,
      extra: extraOf(doc),
    });
    documentId = doc.id;
    sourceLabel = doc.name;
    tick();
  }

  const rules = rulesOf(campaign);
  const written: {
    id: string;
    name: string;
    kind: string;
    body: string;
    tags: string[];
    isNew: boolean;
  }[] = [];

  for (const p of chosen) {
    const cite = citation(p, sourceLabel, documentId);
    if (p.existingId) {
      const existing = await storage.readElement(p.existingId);
      const section = `\n\n## From ${sourceLabel}\n\n${p.body || p.summary}\n\n${cite}\n`;
      const body = `${existing.body.trimEnd()}${section}`;
      const extra = { ...extraOf(existing) };
      if (p.fields) {
        for (const [k, v] of Object.entries(p.fields)) {
          if (!(k in extra) && v !== null && v !== undefined) extra[k] = v;
        }
      }
      const saved = await storage.saveElement({
        id: existing.id,
        name: existing.name,
        tags: unique([...existing.tags, ...p.tags]),
        body,
        extra,
      });
      written.push({
        id: saved.id,
        name: saved.name,
        kind: saved.type,
        body,
        tags: saved.tags,
        isNew: false,
      });
    } else {
      const template = templateFor(rules, p.kind);
      const extra: Record<string, unknown> = { ...template.extra };
      for (const [k, v] of Object.entries(p.fields ?? {})) {
        if (v !== null && v !== undefined) extra[k] = v;
      }
      const created = await storage.createElement(p.kind, p.name, extra);
      const body = `${p.body || p.summary || `# ${p.name}`}\n\n${cite}\n\n## Players know\n\n`;
      const saved = await storage.saveElement({
        id: created.id,
        name: created.name,
        tags: unique(["imported", ...p.tags]),
        body,
        extra: extraOf(created),
      });
      written.push({
        id: saved.id,
        name: saved.name,
        kind: saved.type,
        body,
        tags: saved.tags,
        isNew: true,
      });
    }
    tick();
  }

  // Second pass: turn plain mentions into id links now every id exists.
  const targets = written.map((w) => ({ id: w.id, name: w.name }));
  for (const w of written) {
    const linked = linkMentions(w.body, targets, w.id);
    if (linked !== w.body) {
      await storage.saveElement({
        id: w.id,
        name: w.name,
        tags: w.tags,
        body: linked,
        extra: extraOf(await storage.readElement(w.id)),
      });
    }
  }

  return {
    created: written
      .filter((w) => w.isNew)
      .map(({ id, name, kind }) => ({ id, name, kind })),
    updated: written
      .filter((w) => !w.isNew)
      .map(({ id, name, kind }) => ({ id, name, kind })),
    documentId,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function citation(
  p: Proposal,
  sourceLabel: string,
  documentId: string | null,
): string {
  const where = documentId
    ? `[${sourceLabel}](${elementHref(documentId)})`
    : sourceLabel;
  const pages = formatPages(p.pages);
  return `_Source: ${where}${pages ? `, ${pages}` : ""}_`;
}

export function formatPages(pages: number[]): string {
  if (pages.length === 0) return "";
  const sorted = unique(pages).sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  runs.push(start === prev ? `${start}` : `${start}–${prev}`);
  return `${runs.length === 1 && start === prev ? "p." : "pp."} ${runs.join(", ")}`;
}

/**
 * Links the first plain-text mention of each other element's name. Names
 * shorter than four characters are skipped (too many false hits), longer
 * names are tried first so "Castle Ravenloft" wins over "Ravenloft", and
 * text already inside a Markdown link or heading is left alone.
 */
export function linkMentions(
  body: string,
  targets: { id: string; name: string }[],
  selfId: string,
): string {
  const candidates = targets
    .filter((t) => t.id !== selfId && t.name.trim().length >= 4)
    .sort((a, b) => b.name.length - a.name.length);
  let out = body;
  for (const t of candidates) {
    if (out.includes(elementHref(t.id))) continue;
    // Global so a skipped match (a heading, say) does not end the search;
    // `linked` stops it after the first eligible one.
    const re = new RegExp(
      `(^|[^\\w\\[\\]/#-])(${escapeRegExp(t.name)})(?![\\w\\]\\(])`,
      "gmu",
    );
    const source = out;
    let linked = false;
    out = source.replace(
      re,
      (whole, lead: string, hit: string, offset: number) => {
        if (linked) return whole;
        // Skip headings and anything inside [...] or (...) of an existing link.
        const lineStart = source.lastIndexOf("\n", offset) + 1;
        const line = source.slice(lineStart, offset + whole.length);
        if (/^\s*#/.test(line)) return whole;
        const before = source.slice(lineStart, offset + lead.length);
        if (/\[[^\]]*$/.test(before) || /\]\([^)]*$/.test(before)) return whole;
        linked = true;
        return `${lead}[${hit}](${elementHref(t.id)})`;
      },
    );
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { describeError, createClient };
