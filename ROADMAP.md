# Campaign Forge roadmap

A prioritised plan for the next stretch of work, written 2026-11-12 against version 0.1.1. Each item names the area it touches, a rough size (S: a day or less, M: a few days, L: a week or more) and what "done" looks like. Items inside a tier are in suggested order; tiers are sequenced so later work lands on firmer ground.

## Where the app stands

Shipped and working: world bible with eight kinds plus arcs, sessions, journals, maps and documents; `@` links by id with backlinks; image maps with pins, routes, territories, scale and travel time; calendar and timeline; overview wheel and graph; 5e character sheets and a charactermancer; pictures and PDFs on elements; a sharing model with `## Players know`; LAN table hosting with live updates and "show to players"; in-app signed updates; an opt-in Anthropic assistant with read/write/put/delete permissions.

Known gaps found while surveying the code:

- Edits made outside the app are only picked up when an element is reopened. There is no file watcher (`notify` is not in `Cargo.toml`).
- The list search matches names and tags only. The Rust `search_elements` command already searches bodies, but only the assistant uses it.
- Deleting an element removes the file with no undo and no trash.
- No frontend tests at all (no vitest in `package.json`); the Rust side has around 35 unit tests, mostly storage round-trips and sharing rules.
- The editor loads Tiptap StarterKit only. The 5e creature template writes a Markdown table, which StarterKit cannot represent, so the "Markdown must round-trip" rule needs checking there.
- `MapPanel.tsx` is 2,136 lines and `Charactermancer5e.tsx` 1,195; both are hard to change safely.
- The README's "Planned" line is still open: map reveal, dice, player notes back to the GM, and a browser join for phones.
- Uncommitted work in the tree: colour themes (`ThemePicker`, `theme-store`, eight themes in `index.css`) and the player character / NPC role split (`CharacterRoleField`, `ListFilter`). Both look complete but have not been checked or committed.

## Tier 0: land what is in flight (this week)

1. **Finish and commit themes + PC/NPC split.** S. Run `pnpm typecheck && pnpm lint && pnpm format:check`, open the app on each theme to check contrast in the editor, map and player view, confirm an old campaign's characters all land under NPCs, then commit as two `feat:` commits. Update `docs/world-bible.md` (role) and `docs/getting-started.md` (theme picker in the footer).

2. **Markdown round-trip audit.** S. Write a creature from the 5e template, save, reopen, and diff the file. If the table is mangled, either add `@tiptap/extension-table` (preferred: tables are useful for stat blocks and loot) or change the template to a definition list. Add the same check for task lists, images in bodies and HTML comments, since GMs paste from everywhere.

## Tier 1: foundations that make everything else safer (next two to three weeks)

3. **Frontend unit tests with vitest.** M. The pure model files are already separated from React and are the highest-value targets: `calendar-model.ts` (date arithmetic across custom months and eras), `dnd5e-build.ts` and `dnd5e-model.ts` (derived numbers, point buy, slots), `map-model.ts` (scale, distance, area, travel time), `journal-model.ts`, `session-model.ts`, and `theme.ts`. Add `pnpm test` to the CI frontend job and to lint-staged. Target: every derived number on the character sheet has a test.

4. **Watch the campaign folder.** M. Add the `notify` crate in `src-tauri/src/storage/`, debounce events per file, and emit a Tauri event with the changed element id (or "rescan" for new/removed files). The frontend bumps the existing `revisions` counter in `campaign-store.ts`, which already remounts editors when the assistant rewrites a file. Ignore the app's own writes by comparing mtimes recorded at save. This makes cloud-drive syncing and hand editing in VS Code or Obsidian actually work, which the docs already promise.

5. **Trash instead of delete.** S. `delete_element` moves the file to `<campaign>/.trash/<kind>/<slug>.md` with the original path noted in frontmatter; a "Recently deleted" entry in the sidebar lists and restores; the folder is pruned after 30 days on campaign open. Keeps "files are the source of truth" while removing the one irreversible action in the app.

6. **Split `MapPanel.tsx`.** M. Extract the Leaflet lifecycle (`useLeafletMap`), the tool state machine (pins, routes, territories, measure), the sidebar panels and the drag-and-drop import into their own files under `src/features/map/`. No behaviour change; the vitest suite from item 3 plus a manual pass over `docs/maps.md` is the safety net. Do this before fog of war (item 13) touches the same file.

## Tier 2: daily GM use (following month)

7. **Quick switcher and command palette.** M. `Ctrl+K` opens a palette that fuzzy-matches element names across all kinds and lists actions (new element of kind, open timeline, host table, toggle assistant, switch theme). Enter opens in the main column, `Ctrl+Enter` in a side column, matching the existing Ctrl+click convention. Reuse `ElementSummary` from the store; no new Rust.

8. **Full-text search.** M. A second mode in the same palette, or a search view, backed by the existing `search_elements` command with its excerpts. Show kind, name, and the matching line with the term highlighted. Add a "find in bodies" toggle to the list column too. Consider `tantivy` later only if campaigns get large; a linear scan over a few hundred Markdown files is fine for now.

9. **Initiative and encounter tracker.** L. A new `encounter` panel attached to a session beat: combatants pulled from characters (PC sheets give AC, HP, initiative bonus) and creatures, initiative rolled or typed, round and turn tracking, HP and conditions, with the state written to the session file so it survives a restart. Share the turn order to players at the table as a read-only strip. This is the most-requested kind of feature in GM tools and the 5e sheet already holds the numbers it needs.

10. **Dice.** S. A roller in the sidebar and `/roll 2d6+3`-style inline rolls in the editor and the encounter tracker, with a short history. Over the table, rolls can be broadcast to players (item 12 covers the channel).

11. **Structured creature stat blocks for 5e.** M. The same approach as the character sheet: a `statblock` frontmatter object with AC, HP, speed, abilities, saves, skills, senses, CR, traits, actions. Renders as a familiar stat block above the body and feeds item 9. Keep the generic-rules template as plain Markdown.

## Tier 3: the table (the README's planned list)

12. **Player-to-GM channel.** M. Today the table is one-way HTTP from GM to players. Add `POST /api/notes` (player notes and questions) and `POST /api/rolls` (player dice) to `server.rs`, show them in the hosting panel, and let the GM pin a note to a session as a journal entry. Still LAN only, still no accounts.

13. **Map reveal (fog of war).** L. A per-map `revealed` polygon set stored in the map element; GM paints or erases reveal with a brush or polygon tool; `share.rs` masks the image for players by sending the reveal geometry and letting `PlayerMap.tsx` draw the cover. Depends on item 6.

14. **Browser join for phones.** L. Serve a static player view from the axum server at `http://<gm-ip>:<port>/` so players without the desktop app, especially on phones, can join with the code. The player screen is already a separate React tree (`PlayerScreen.tsx`, `PlayerMap.tsx`) so the work is a second Vite entry point built into the Rust binary with `include_dir`, a touch-friendly layout, and a mobile PDF viewer fallback. This is the single biggest growth feature: every player at a physical table has a phone, few have a laptop.

15. **Handouts to the table.** S. "Show to players" already exists for elements; extend it to a single image or PDF page so a GM can flash a letter or a portrait without creating an element first.

## Tier 4: getting things out (afterwards)

16. **Export handouts and sessions.** M. Print or save as PDF for any element's player-facing text, a session recap, or a whole arc, using the webview's print with a print stylesheet. Export the player view as a static HTML folder for GMs who want to email a bible to the group.

17. **Campaign snapshots.** S. "Back up now" zips the campaign folder to a chosen location, and an optional reminder before each hosted session. Cheap insurance for the "no undo" feel that remains for body edits.

18. **Assistant: session helpers.** M. Three canned actions using existing tools: draft tonight's recap from the previous session's body and journal entries; "what do the players know about X" built from `## Players know` sections; and turn a session's ticked beats into a journal entry after play. Add a streaming cancel button and a per-campaign spend cap in the agent settings.

19. **Accessibility and keyboard pass.** S. Focus order through the three columns, visible focus rings on every theme, `aria-label` on icon-only toolbar buttons (the new `ToolbarButton` component is the place), and a shortcuts cheat sheet reachable from the palette.

## Deliberately not planned

- Cloud sync, accounts, or a hosted server. The local-first contract is the product.
- A general-purpose VTT with tokens and grid combat. The map stays a reference map; the encounter tracker handles the numbers.
- More rulesets beyond 5e before the generic templates and stat blocks are in good shape.

## Suggested release cut

- **0.2.0:** Tier 0 and items 3 to 5 (themes, PC/NPC, tests, watcher, trash).
- **0.3.0:** items 6 to 11 (map refactor, palette, search, encounters, dice, stat blocks).
- **0.4.0:** items 12 to 15 (two-way table, fog of war, browser join, handouts).
- **0.5.0:** items 16 to 19.
