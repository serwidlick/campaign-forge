import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronLeft,
  Eraser,
  KeyRound,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/Button";
import { elementIdFromHref } from "@/lib/types";
import {
  useAgentStore,
  type UiMessage,
  type UiToolPart,
} from "@/stores/agent-store";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  EFFORTS,
  MODELS,
  PERMISSIONS,
  cacheShare,
  enabledPermissions,
  estimateCostUsd,
  formatTokens,
  formatUsd,
  type Effort,
  type TurnUsage,
} from "./agent-settings";

const FIELD =
  "w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";

export function AgentPane({ onClose }: { onClose: () => void }) {
  const ready = useAgentStore((s) => s.ready);
  const hasApiKey = useAgentStore((s) => s.hasApiKey);
  const permissions = useAgentStore((s) => s.settings.permissions);
  const messages = useAgentStore((s) => s.messages);
  const streaming = useAgentStore((s) => s.streaming);
  const error = useAgentStore((s) => s.error);
  const init = useAgentStore((s) => s.init);
  const send = useAgentStore((s) => s.send);
  const stop = useAgentStore((s) => s.stop);
  const clear = useAgentStore((s) => s.clear);
  const clearError = useAgentStore((s) => s.clearError);

  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "settings">("chat");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Until a key exists there is nothing to chat with: show settings.
  const showSettings = view === "settings" || (ready && !hasApiKey);
  const abilities = enabledPermissions(permissions);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input;
    setInput("");
    void send(text);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <header className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        {showSettings && hasApiKey ? (
          <button
            type="button"
            onClick={() => setView("chat")}
            className="flex items-center gap-1 text-xs text-ink-400 hover:text-ink-200"
          >
            <ChevronLeft size={14} /> Back
          </button>
        ) : (
          <Sparkles size={14} className="text-ember-400" />
        )}
        <h2 className="text-sm font-semibold">
          {showSettings ? "Assistant settings" : "Assistant"}
        </h2>
        <span className="flex-1" />
        {!showSettings && (
          <>
            <IconButton
              label="Clear conversation"
              onClick={clear}
              disabled={messages.length === 0}
            >
              <Eraser size={14} />
            </IconButton>
            <IconButton
              label="Assistant settings"
              onClick={() => setView("settings")}
            >
              <Settings2 size={14} />
            </IconButton>
          </>
        )}
        <IconButton label="Close assistant" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {showSettings ? (
        <SettingsPage onDone={() => setView("chat")} />
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1 text-[11px] text-ink-500">
            <span>Can:</span>
            {abilities.length === 0 ? (
              <span className="text-ink-600">nothing (no tools enabled)</span>
            ) : (
              abilities.map((id) => (
                <span
                  key={id}
                  className={`rounded px-1.5 py-0.5 ${
                    id === "delete"
                      ? "bg-red-500/15 text-red-200"
                      : id === "read"
                        ? "bg-ink-800 text-ink-300"
                        : "bg-ember-500/15 text-ember-200"
                  }`}
                >
                  {PERMISSIONS.find((p) => p.id === id)?.label}
                </span>
              ))
            )}
            <SessionUsage messages={messages} />
            <button
              type="button"
              onClick={() => setView("settings")}
              className="text-ink-500 hover:text-ink-300"
            >
              change
            </button>
          </div>

          <main className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div className="text-xs leading-relaxed text-ink-500">
                <p>
                  Ask about anything in this campaign. The assistant reads your
                  elements through search, list and read tools, and links what
                  it mentions so you can jump straight there.
                </p>
                <p className="mt-2">
                  Try: “What do we know about the Rusty Tankard?” · “Summarise
                  the last played session” · “Which factions has the party not
                  met yet?”
                </p>
                <p className="mt-2 text-ink-600">
                  Your campaign text is sent to Anthropic using your own API
                  key. With Write or Put enabled it can create and change
                  elements; otherwise nothing is saved unless you write it down.
                </p>
              </div>
            )}
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            <div ref={endRef} />
          </main>

          <form
            onSubmit={handleSubmit}
            className="border-t border-ink-800 px-3 py-2"
          >
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  hasApiKey ? "Ask the assistant…" : "Add an API key to start"
                }
                disabled={!hasApiKey || streaming}
                rows={2}
                className={`${FIELD} resize-none disabled:opacity-50`}
              />
              {streaming ? (
                <Button variant="ghost" onClick={stop} aria-label="Stop">
                  <Square size={14} />
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={!hasApiKey || !input.trim()}
                  aria-label="Send"
                >
                  <Send size={14} />
                </Button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-600">
              Enter to send · Shift+Enter for a new line
            </p>
          </form>
        </>
      )}
    </div>
  );
}

// ---- Settings page ---------------------------------------------------------

function SettingsPage({ onDone }: { onDone: () => void }) {
  const hasApiKey = useAgentStore((s) => s.hasApiKey);
  const settings = useAgentStore((s) => s.settings);
  const setApiKey = useAgentStore((s) => s.setApiKey);
  const clearApiKey = useAgentStore((s) => s.clearApiKey);
  const setModel = useAgentStore((s) => s.setModel);
  const setEffort = useAgentStore((s) => s.setEffort);
  const setPermission = useAgentStore((s) => s.setPermission);

  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSaveKey(e: FormEvent) {
    e.preventDefault();
    if (!keyDraft.trim()) return;
    setSaving(true);
    await setApiKey(keyDraft.trim());
    setSaving(false);
    setKeyDraft("");
    onDone();
  }

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm">
      {/* Key */}
      <section>
        <SectionTitle icon={<KeyRound size={13} />}>
          Anthropic API key
        </SectionTitle>
        <form onSubmit={handleSaveKey} className="mt-2">
          <input
            type="password"
            autoComplete="off"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={
              hasApiKey
                ? "A key is saved · paste a new one to replace it"
                : "sk-ant-…"
            }
            className={FIELD}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={!keyDraft.trim() || saving}
            >
              {saving ? "Saving…" : hasApiKey ? "Replace key" : "Save key"}
            </Button>
            {hasApiKey && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => void clearApiKey()}
              >
                Remove key
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Stored in your operating system&apos;s credential manager, never in
            the campaign folder or the app&apos;s settings file. Requests go
            straight from this app to Anthropic.
          </p>
        </form>
      </section>

      {/* Model */}
      <section>
        <SectionTitle>Model</SectionTitle>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <label className="text-xs text-ink-400">
            Model
            <select
              value={settings.model}
              onChange={(e) => void setModel(e.target.value)}
              className={`mt-1 ${FIELD}`}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-ink-600">
              {MODELS.find((m) => m.id === settings.model)?.note}
            </span>
          </label>
          <label className="text-xs text-ink-400">
            Effort
            <select
              value={settings.effort}
              onChange={(e) => void setEffort(e.target.value as Effort)}
              className={`mt-1 ${FIELD}`}
            >
              {EFFORTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-ink-600">
              Higher effort thinks longer and costs more.
            </span>
          </label>
        </div>
      </section>

      {/* Permissions */}
      <section>
        <SectionTitle icon={<ShieldAlert size={13} />}>
          Permissions
        </SectionTitle>
        <p className="mt-1 text-xs text-ink-500">
          Each switch adds or removes a set of tools. The assistant cannot call
          a tool it has not been given, and every call is checked again before
          it runs. Changes apply from the next message.
        </p>
        <ul className="mt-3 divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-850">
          {PERMISSIONS.map((p) => {
            const on = settings.permissions[p.id];
            return (
              <li key={p.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="flex-1">
                  <div
                    className={`text-sm font-medium ${
                      p.danger && on ? "text-red-200" : "text-ink-100"
                    }`}
                  >
                    {p.label}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-500">{p.detail}</div>
                </div>
                <Toggle
                  checked={on}
                  danger={p.danger}
                  label={`${p.label} permission`}
                  onChange={(next) => void setPermission(p.id, next)}
                />
              </li>
            );
          })}
        </ul>
        {!settings.permissions.read && (
          <p className="mt-2 text-xs text-amber-200/80">
            With Read off the assistant cannot look anything up, so it will
            answer from the element index alone.
          </p>
        )}
      </section>

      {hasApiKey && (
        <div className="pt-2">
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

function SectionTitle({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
      {icon}
      {children}
    </h3>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  danger,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  danger?: boolean;
}) {
  const onClass = danger ? "bg-red-500" : "bg-ember-500";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative mt-0.5 inline-block h-5 w-9 shrink-0 rounded-full border border-transparent transition-colors ${
        checked ? onClass : "bg-ink-700"
      }`}
    >
      {/* 36px track, 16px knob, 2px inset: travel is 36 - 16 - 2*2 = 16px */}
      <span
        aria-hidden
        className={`absolute top-[1px] left-[1px] h-4 w-4 rounded-full bg-ink-100 shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ---- Messages --------------------------------------------------------------

function MessageView({ message }: { message: UiMessage }) {
  const select = useCampaignStore((s) => s.select);
  const isUser = message.role === "user";

  if (isUser) {
    const text = message.parts
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
      .map((p) => p.text)
      .join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] whitespace-pre-wrap rounded-xl border border-ember-500/30 bg-ember-500/10 px-3 py-2 text-sm text-ink-100">
          {text}
        </div>
      </div>
    );
  }

  const empty = message.parts.length === 0 && !message.error;
  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] space-y-2 text-sm text-ink-100">
        {empty && (
          <span className="inline-flex items-center gap-2 text-xs text-ink-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-ember-400" />
            Thinking…
          </span>
        )}
        {message.parts.map((part, i) =>
          part.kind === "text" ? (
            <div key={i} className="chat-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => {
                    const id = elementIdFromHref(href);
                    if (id) {
                      return (
                        <button
                          type="button"
                          onClick={() => void select(id)}
                          className="element-chip"
                        >
                          {children}
                        </button>
                      );
                    }
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) void openUrl(href);
                        }}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {part.text}
              </ReactMarkdown>
            </div>
          ) : (
            <ToolCard key={i} part={part} />
          ),
        )}
        {message.error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {message.error}
          </div>
        )}
        {message.usage && (
          <UsageLine usage={message.usage} model={message.model} />
        )}
      </div>
    </div>
  );
}

// ---- Usage -----------------------------------------------------------------

function UsageLine({
  usage,
  model,
}: {
  usage: TurnUsage;
  model: string | undefined;
}) {
  const cost = estimateCostUsd(usage, model);
  const cached = cacheShare(usage);
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const title = [
    `Prompt ${usage.input.toLocaleString()} fresh + ${usage.cacheRead.toLocaleString()} cache read + ${usage.cacheWrite.toLocaleString()} cache write`,
    `Output ${usage.output.toLocaleString()}`,
    `${usage.calls} model call${usage.calls === 1 ? "" : "s"}`,
    model ? `Priced as ${model}` : "Unknown model price",
  ].join("\n");
  return (
    <div
      className="flex flex-wrap gap-x-2 text-[11px] text-ink-600"
      title={title}
    >
      <span>{formatTokens(prompt)} in</span>
      <span>·</span>
      <span>{formatTokens(usage.output)} out</span>
      {prompt > 0 && (
        <>
          <span>·</span>
          <span>{Math.round(cached * 100)}% cached</span>
        </>
      )}
      {usage.calls > 1 && (
        <>
          <span>·</span>
          <span>{usage.calls} calls</span>
        </>
      )}
      {cost !== null && (
        <>
          <span>·</span>
          <span>≈ {formatUsd(cost)}</span>
        </>
      )}
    </div>
  );
}

function SessionUsage({ messages }: { messages: UiMessage[] }) {
  let tokens = 0;
  let cost = 0;
  let priced = true;
  for (const m of messages) {
    if (!m.usage) continue;
    tokens +=
      m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output;
    const c = estimateCostUsd(m.usage, m.model);
    if (c === null) priced = false;
    else cost += c;
  }
  if (tokens === 0) return <span className="ml-auto" />;
  return (
    <span
      className="ml-auto text-ink-600"
      title="This conversation: all tokens in and out, and the approximate cost at list prices"
    >
      Session {formatTokens(tokens)} tokens
      {priced && <> · ≈ {formatUsd(cost)}</>}
    </span>
  );
}

const TOOL_LABELS: Record<string, string> = {
  search_campaign: "Searched",
  list_elements: "Listed",
  read_element: "Read",
  create_element: "Created",
  update_element: "Updated",
  delete_element: "Deleted",
};

function ToolCard({ part }: { part: UiToolPart }) {
  const [open, setOpen] = useState(false);
  const status = part.result
    ? part.result.isError
      ? "failed"
      : "done"
    : "running";
  const isWrite = /^(create|update|delete)_/.test(part.name);
  const inputText = (() => {
    if (!part.input || typeof part.input !== "object") {
      return String(part.input ?? "");
    }
    const o = part.input as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => {
        const text = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
      })
      .join(" · ");
  })();

  return (
    <div
      className={`rounded-md border text-xs ${
        isWrite
          ? "border-ember-500/30 bg-ember-500/5"
          : "border-ink-800 bg-ink-950/60"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            status === "failed"
              ? "bg-red-400"
              : status === "done"
                ? "bg-emerald-400"
                : "animate-pulse bg-amber-300"
          }`}
        />
        <span className={isWrite ? "text-ember-200" : "text-ink-300"}>
          {TOOL_LABELS[part.name] ?? part.name}
        </span>
        <span className="truncate font-mono text-ink-500">{inputText}</span>
      </button>
      {open && part.result && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-ink-800 px-2.5 py-2 font-mono text-[11px] text-ink-400">
          {part.result.preview}
        </pre>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded-md p-1.5 transition-colors disabled:opacity-30 ${
        active
          ? "bg-ember-500/25 text-ember-200"
          : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
      }`}
    >
      {children}
    </button>
  );
}
