/**
 * The tools the campaign assistant can call. Each one is gated by a
 * permission from the assistant settings: the model is only shown the tools
 * whose permission is on, and the executor re-checks before running.
 *
 * Every tool validates the model's input with zod before touching anything
 * and returns plain text for the model to read. Writes go through the same
 * Rust commands and store actions the UI uses, so the open editor and the
 * element list stay in step.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { storage } from "@/lib/tauri";
import {
  ELEMENT_KINDS,
  RESERVED_ELEMENT_KEYS,
  characterRoleOf,
  elementHref,
  extraOf,
  type ElementSummary,
} from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import type { Permission } from "./agent-settings";

export interface AgentTool {
  permission: Permission;
  definition: Anthropic.Beta.BetaTool;
  run: (input: unknown) => Promise<string>;
}

const KIND_IDS = ELEMENT_KINDS.map((k) => k.id);
const KIND_ENUM = z.enum(KIND_IDS as [string, ...string[]]);

function invalid(error: z.ZodError): string {
  return `INVALID_INPUT: ${error.issues
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ")}`;
}

/** Frontmatter fields the model cares about, minus the bookkeeping. */
function kindFields(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!RESERVED_ELEMENT_KEYS.has(k) && v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

function summaryLine(e: ElementSummary): string {
  const fields = kindFields(e);
  const extras: string[] = [];
  if (e.type === "session") {
    if (fields.number !== undefined) extras.push(`#${fields.number}`);
    if (fields.status) extras.push(String(fields.status));
    if (fields.date) extras.push(String(fields.date));
  }
  if (e.type === "character") extras.push(characterRoleOf(e));
  if (e.tags.length) extras.push(`tags: ${e.tags.join(", ")}`);
  const tail = extras.length ? ` (${extras.join(" · ")})` : "";
  return `- ${e.type} · ${e.name} · id ${e.id}${tail}`;
}

function nameOf(id: string): string {
  return (
    useCampaignStore.getState().elements.find((e) => e.id === id)?.name ?? id
  );
}

// ---- Read ----------------------------------------------------------------

const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

const searchCampaign: AgentTool = {
  permission: "read",
  definition: {
    name: "search_campaign",
    description:
      "Full-text search across every element's name, tags and body. Case-insensitive substring match. Use this first when you do not know which element holds something. Returns ids you can pass to read_element.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Word or phrase to look for." },
        limit: {
          type: "integer",
          description: "Max results, 1-50. Default 20.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = SearchInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const hits = await storage.searchElements(
      parsed.data.query,
      parsed.data.limit ?? 20,
    );
    if (hits.length === 0) return "No elements match.";
    return hits
      .map(
        (h) =>
          `- ${h.type} · ${h.name} · id ${h.id} · matched in ${h.matchedIn}\n  ${h.snippet}`,
      )
      .join("\n");
  },
};

const ListInput = z.object({
  kind: KIND_ENUM.optional(),
  role: z.enum(["pc", "npc"]).optional(),
});

const listElements: AgentTool = {
  permission: "read",
  definition: {
    name: "list_elements",
    description:
      "List elements with their ids, optionally filtered to one kind. Sessions include their number, status and date; characters include their role (pc or npc). Cheap; use it to get an overview or to find an id by name.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: KIND_IDS,
          description: "Only elements of this kind.",
        },
        role: {
          type: "string",
          enum: ["pc", "npc"],
          description:
            "Only characters with this role: the players' characters (pc) or everyone else (npc). Implies kind = character.",
        },
      },
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = ListInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const all = useCampaignStore.getState().elements;
    const { role } = parsed.data;
    const kind = role ? "character" : parsed.data.kind;
    const items = all.filter(
      (e) =>
        (!kind || e.type === kind) && (!role || characterRoleOf(e) === role),
    );
    if (items.length === 0) return "No elements.";
    return items.map(summaryLine).join("\n");
  },
};

const ReadInput = z.object({ id: z.string().min(1) });

const readElement: AgentTool = {
  permission: "read",
  definition: {
    name: "read_element",
    description:
      "Read one element in full: its kind, name, tags, kind-specific fields (a session's beats, a map's pins, a session's arc...) and its Markdown body. Links inside the body look like [Name](cf://element/<id>).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The element id." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = ReadInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const e = await storage.readElement(parsed.data.id);
    const fields = kindFields(e);
    const all = useCampaignStore.getState().elements;
    const linksTo = e.links
      .map((id) => all.find((x) => x.id === id))
      .filter((x): x is ElementSummary => Boolean(x))
      .map((x) => `${x.name} (${x.type}, ${elementHref(x.id)})`);
    const linkedFrom = all
      .filter((x) => x.links.includes(e.id) && x.id !== e.id)
      .map((x) => `${x.name} (${x.type}, ${elementHref(x.id)})`);
    const header = [
      `# ${e.name}`,
      `kind: ${e.type}`,
      `id: ${e.id}`,
      `link: ${elementHref(e.id)}`,
      e.tags.length ? `tags: ${e.tags.join(", ")}` : null,
      Object.keys(fields).length
        ? `fields: ${JSON.stringify(fields, null, 1)}`
        : null,
      linksTo.length ? `links to: ${linksTo.join("; ")}` : null,
      linkedFrom.length ? `linked from: ${linkedFrom.join("; ")}` : null,
      `updated: ${e.updatedAt}`,
    ]
      .filter(Boolean)
      .join("\n");
    return `${header}\n\n---\n\n${e.body.trim() || "(empty body)"}`;
  },
};

const ReadDocumentInput = z
  .object({
    id: z.string().min(1),
    from: z.number().int().min(1).optional(),
    to: z.number().int().min(1).optional(),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.to >= v.from, {
    message: "to must not be before from",
  });

/** Pages per read_document call; a tool result is cut at ~8 KB anyway, and
 *  a dense rulebook page is 3-4 KB. */
const MAX_DOCUMENT_PAGES = 4;

const readDocument: AgentTool = {
  permission: "read",
  definition: {
    name: "read_document",
    description:
      "Read the text of a Document element's PDF, a few pages at a time (at most 4 per call). Use it when the GM asks about a rulebook, module or handout they attached. Start with the first pages or the ones the GM named, then ask for more. Pages without text (scans, art) come back empty, unless the book was imported with its pages read as pictures and the text kept.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The document element's id." },
        from: {
          type: "integer",
          description: "First page, 1-based. Default 1.",
        },
        to: {
          type: "integer",
          description: "Last page, inclusive. Default: from + 3.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = ReadDocumentInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const e = await storage.readElement(parsed.data.id);
    const file = typeof e.file === "string" ? e.file : null;
    if (e.type !== "document" || !file) {
      return `INVALID_INPUT: "${e.name}" is not a document with a PDF attached.`;
    }
    const from = parsed.data.from ?? 1;
    const to = Math.min(
      parsed.data.to ?? from + MAX_DOCUMENT_PAGES - 1,
      from + MAX_DOCUMENT_PAGES - 1,
    );
    const text = await storage.readDocumentText(file, from, to);
    const lines = [
      `# ${e.name} · pages ${text.firstPage}–${text.firstPage + text.pages.length - 1} of ${text.pageCount}`,
    ];
    text.pages.forEach((page, i) => {
      lines.push("", `[Page ${text.firstPage + i}]`, page || "(no text)");
    });
    if (text.firstPage + text.pages.length - 1 < text.pageCount) {
      lines.push(
        "",
        `(${text.pageCount - (text.firstPage + text.pages.length - 1)} more pages follow; call read_document again with a later range.)`,
      );
    }
    return lines.join("\n");
  },
};

// ---- Write (create) --------------------------------------------------------

const FieldsSchema = z.record(z.string(), z.unknown()).optional();

const CreateInput = z.object({
  kind: KIND_ENUM,
  name: z.string().min(1).max(200),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  fields: FieldsSchema,
});

const createElement: AgentTool = {
  permission: "create",
  definition: {
    name: "create_element",
    description:
      "Create a new element. Give it a kind, a name, and optionally a Markdown body, tags and kind-specific fields (for a session: arc, number, date, status, beats; see read_element on an existing one for the shape). Link other elements in the body as [Name](cf://element/<id>). Returns the new id.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_IDS },
        name: { type: "string" },
        body: { type: "string", description: "Markdown body." },
        tags: { type: "array", items: { type: "string" } },
        fields: {
          type: "object",
          description: "Kind-specific frontmatter fields.",
          additionalProperties: true,
        },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = CreateInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const { kind, name, body, tags, fields } = parsed.data;
    const created = await storage.createElement(kind, name, fields);
    let final = created;
    if (body !== undefined || tags !== undefined) {
      final = await storage.saveElement({
        id: created.id,
        name: created.name,
        tags: tags ?? created.tags,
        body: body ?? created.body,
        extra: extraOf(created),
      });
    }
    await useCampaignStore.getState().refreshElements();
    return `Created ${final.type} "${final.name}" · id ${final.id} · ${elementHref(final.id)} · file ${final.path}`;
  },
};

// ---- Put (update) ----------------------------------------------------------

const UpdateInput = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    tags: z.array(z.string()).optional(),
    body: z.string().optional(),
    append: z.string().optional(),
    fields: FieldsSchema,
  })
  .refine((v) => !(v.body !== undefined && v.append !== undefined), {
    message: "give either body (replace) or append, not both",
  });

const updateElement: AgentTool = {
  permission: "update",
  definition: {
    name: "update_element",
    description:
      "Change an existing element. Any of: name, tags (replaces the list), body (replaces the whole Markdown body), append (adds Markdown at the end, preferred for notes), fields (merged into the kind-specific fields; set a field to null to remove it). Read the element first so you do not overwrite what the GM wrote.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string", description: "New Markdown body (replaces)." },
        append: {
          type: "string",
          description: "Markdown to add at the end of the body.",
        },
        fields: {
          type: "object",
          description: "Kind-specific fields to merge. null removes a field.",
          additionalProperties: true,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = UpdateInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const { id, name, tags, body, append, fields } = parsed.data;
    const existing = await storage.readElement(id);

    const nextBody =
      body !== undefined
        ? body
        : append !== undefined
          ? `${existing.body.trimEnd()}\n\n${append.trim()}\n`
          : existing.body;
    const extra: Record<string, unknown> = { ...extraOf(existing) };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === null || v === undefined) delete extra[k];
      else extra[k] = v;
    }

    const saved = await storage.saveElement({
      id,
      name: name ?? existing.name,
      tags: tags ?? existing.tags,
      body: nextBody,
      extra,
    });

    const store = useCampaignStore.getState();
    await store.refreshElements();
    await store.reloadElement(id);

    const changed = [
      name !== undefined ? "name" : null,
      tags !== undefined ? "tags" : null,
      body !== undefined ? "body" : null,
      append !== undefined ? "appended to body" : null,
      fields ? `fields (${Object.keys(fields).join(", ")})` : null,
    ].filter(Boolean);
    return `Updated ${saved.type} "${saved.name}" · ${elementHref(saved.id)} · changed: ${changed.join(", ") || "nothing"}`;
  },
};

// ---- Delete ----------------------------------------------------------------

const DeleteInput = z.object({ id: z.string().min(1) });

const deleteElement: AgentTool = {
  permission: "delete",
  definition: {
    name: "delete_element",
    description:
      "Delete an element. Its file moves to the campaign's Recently deleted list, where the GM can restore it for 30 days. Only use this when the GM explicitly asked for that element to be deleted, and name it back to them first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  async run(raw) {
    const parsed = DeleteInput.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const name = nameOf(parsed.data.id);
    await useCampaignStore.getState().deleteElement(parsed.data.id);
    return `Deleted "${name}" (${parsed.data.id}). It can be restored from Recently deleted.`;
  },
};

// ---- Registry --------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  searchCampaign,
  listElements,
  readElement,
  readDocument,
  createElement,
  updateElement,
  deleteElement,
];

export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.definition.name === name);
}
