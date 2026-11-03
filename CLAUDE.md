# Campaign Forge

A local-first desktop campaign manager for tabletop game masters (world bible, map, sessions, timeline, journals). Everything the user writes lives as plain Markdown files in a folder they choose. No accounts, no server.

## Stack

- **Shell:** Tauri 2 (Rust) — `src-tauri/`
- **UI:** React 19 + TypeScript + Vite + Tailwind 4 — `src/`
- **Editor:** Tiptap 3 with `@tiptap/markdown` (Markdown in, Markdown out)
- **Layout:** `react-resizable-panels`
- **State:** zustand
- **Package manager:** pnpm (see `packageManager` in `package.json`)

## Layout

- `src-tauri/src/storage/` — Rust storage layer. Owns all file IO. Elements are `elements/<kind>/<slug>.md` with YAML frontmatter; campaign metadata is `campaign.json`.
- `src-tauri/src/commands.rs` — Tauri commands exposed to the frontend. Thin wrappers over `storage`.
- `src-tauri/src/table/` — hosting and joining a table over the LAN (axum server, mDNS discovery, reqwest client, sharing rules).
- `src/lib/tauri.ts` — typed `invoke` wrappers. The only place the frontend calls Rust.
- `src/features/<area>/` — one folder per screen area (`campaign`, `bible`, later `map`, `sessions`, `agent`).
- `src/stores/` — zustand stores.

## Rules

- **Files are the source of truth.** Never cache campaign content anywhere the user cannot see. Every write goes through the Rust storage layer, never `plugin-fs` from the frontend.
- **Link by ID, never by title.** Every element has a stable `id` in its frontmatter. Renames must not break links.
- **Markdown must round-trip.** If the editor cannot represent something, preserve it rather than drop it.
- **No network calls** except the opt-in AI agent (user's own API key) and the LAN table (`src-tauri/src/table/`: the GM hosts an HTTP API for players on the same network; what it serves is decided only by `table/share.rs`).

## Conventional Commits

Commit subjects follow `type: subject` and are enforced by commitlint + husky. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Scopes are allowed by commitlint but not used here: write `feat: subject`, not `feat(map): subject`. Keep subjects imperative, lower-case, no trailing full stop. CI lints every PR's commits.

## Git

Do not commit, push, tag, merge, rebase, or open PRs unless the user asks for it in the current session. Stop at "files edited, checks pass" and summarise. When asked to commit, use the format above. Commits are authored only by real people: never add a `Co-Authored-By` trailer for Claude or any other AI tool to a commit message or PR description, including messages drafted for the user to paste.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm rust:check        # needs a Rust toolchain
pnpm tauri:dev         # run the app
```

## Code graph

[graphify](https://github.com/Graphify-Labs/graphify) turns the repo into a queryable knowledge graph. It is installed as a uv tool and registered project-wide: the `/graphify` skill lives in `.claude/skills/graphify/`, and `.claude/settings.json` has `PreToolUse` hooks that point Claude Code at the graph before raw searches and reads. `graphify-out/` is gitignored; rebuild it locally.

```bash
uv tool install graphifyy    # once per machine, from your own terminal (winget install astral-sh.uv first on Windows)
graphify update .            # (re)build graphify-out/ from the AST, no API key, a few seconds
graphify query "<question>"  # scoped subgraph; also: path "A" "B", explain "X", god-nodes
```

Installing from inside a Claude Code desktop session needs `UV_TOOL_DIR` set to a path outside `AppData` first (the app container virtualises `AppData` writes, so a default install is invisible to your own shell). This machine has it as a user env var pointing at `~/.local/share/uv/tools`.

In a Claude Code session, `/graphify .` runs the full pipeline (adds a semantic pass over docs) and `/graphify query "..."` asks the graph. `graphify label . --backend claude-cli` names the communities; without it they carry hub-derived names.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
