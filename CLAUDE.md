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
- `src/lib/tauri.ts` — typed `invoke` wrappers. The only place the frontend calls Rust.
- `src/features/<area>/` — one folder per screen area (`campaign`, `bible`, later `map`, `sessions`, `agent`).
- `src/stores/` — zustand stores.

## Rules

- **Files are the source of truth.** Never cache campaign content anywhere the user cannot see. Every write goes through the Rust storage layer, never `plugin-fs` from the frontend.
- **Link by ID, never by title.** Every element has a stable `id` in its frontmatter. Renames must not break links.
- **Markdown must round-trip.** If the editor cannot represent something, preserve it rather than drop it.
- **No network calls** except the opt-in AI agent, which uses the user's own API key.

## Conventional Commits

Commit subjects follow `type(scope): subject` and are enforced by commitlint + husky. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Scope is optional and kebab-case (`bible`, `storage`, `agent`, `ui`, `build`). Keep subjects imperative, lower-case, no trailing full stop. CI lints every PR's commits.

## Git

Do not commit, push, tag, merge, rebase, or open PRs unless the user asks for it in the current session. Stop at "files edited, checks pass" and summarise. When asked to commit, use the format above.

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm rust:check        # needs a Rust toolchain
pnpm tauri:dev         # run the app
```
