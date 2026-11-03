# Campaign Forge

A local-first desktop campaign manager for tabletop game masters. World bible, map, sessions, timeline and journals, with everything stored as plain Markdown files in a folder you choose. No account, no server, works offline.

Built with Tauri 2, React, TypeScript and Tailwind.

## Status

Early scaffold. What works today:

- Create or open a campaign folder
- World bible: create, edit, tag and delete elements across eight kinds (characters, factions, creatures, locations, items, quests, events, lore)
- Rich text editing that reads and writes Markdown
- Links between elements: type `@` to insert one, Ctrl+click to follow, and every element lists what it links to and what links to it
- Arcs and sessions: a session has a number, date, status and an ordered list of beats, with one beat marked as the main encounter and one as the cliffhanger; an arc lists its sessions in play order
- Maps: import an image (file picker, or drag and drop from Explorer or a browser), pan and zoom or lock the view, choose how the image is framed, drop pins linked to elements, draw named routes, calibrate a scale once, then measure as the crow flies or along a route for distance and travel time at each of the campaign's travel paces (on foot, horseback and by wagon by default; edit, add or remove paces and the hours travelled per day from any map's Paces button); outline territories (a faction's reach, a kingdom, a forest) with area in map units; nest maps by linking a pin or territory to another map, or create a sub-map straight from a pin
- Assistant: an opt-in chat pane that answers questions about the campaign by searching, listing and reading your elements, and links everything it mentions. Uses your own Anthropic API key, stored in the OS credential manager
- Player view: mark any element as shared, and on maps choose which pins, routes and territories players may see; a Preview as player button shows the campaign exactly as they will get it, with links to private elements turned back into plain text
- Split screen: Ctrl+click any element reference (list row, link, backlink, pin, session, assistant chip) to open it in a column beside the current one; columns swap, close, and are remembered per campaign
- Timeline: a campaign calendar you define (months of any length, weekday names, eras, the in-world today), events with a date and optional end date, sessions with an in-world date, and a Timeline view listing everything in order with a today marker
- Overview wheel and graph: the Everything view is a wheel of six spokes (Play, People, Factions, Places, Things, Story) with every element one click away, and the Graph view is a force-directed map of how elements connect through links, arcs and map pins
- Journal: dated entries that belong to the campaign, an arc or a session, listed newest first in a Journal view and under each arc and session, with an optional in-world date that places them on the timeline
- Recent campaigns list

- Play at a table over the local network: the GM presses Host a table and reads out a six-digit code; players open Campaign Forge on their own laptops, pick the table from the list (or type the GM address) and get the player view live, updating within a second of the GM sharing or editing something. Nothing leaves the network and there are no accounts.

Planned: table tools (show this to everyone, map reveal, dice, player notes back to the GM) and a browser join for phones.

## On-disk format

```
<campaign folder>/
  campaign.json            name, system, and settings such as the calendar
  elements/
    character/
      the-rusty-tankard-keeper.md
    location/
      the-rusty-tankard.md
    map/
      sword-coast.md
  assets/
    maps/
      sword-coast.png
```

Each element is a Markdown file with YAML frontmatter:

```markdown
---
id: 7f0c6a2e-...
type: location
name: The Rusty Tankard
tags: [tavern, waterdeep]
createdAt: 2026-11-02T20:41:00Z
updatedAt: 2026-11-02T20:55:12Z
---

# The Rusty Tankard

A dockside tavern...
```

The `id` is the stable identity. File names are derived from the element's name at creation and never used for linking, so renaming is safe.

Links between elements are ordinary Markdown links with the `cf://element/<id>` scheme, for example `[The Rusty Tankard](cf://element/7f0c6a2e-...)`. The link text is a label chosen when the link was made; the id is what resolves.

Kind-specific fields live in the same frontmatter. A session, for example, carries `arc`, `number`, `date`, `status` and a `beats` list; unknown keys written by other tools are preserved on save.

## Installing

Send people to the download page: **https://serwidlick.github.io/campaign-forge/**. It offers the right installer for their system from the latest release. Every version is also on the [Releases](https://github.com/serwidlick/campaign-forge/releases) page.

- **Windows:** run `Campaign Forge_<version>_x64-setup.exe`. It installs for the current user only, so no admin rights are needed. Windows SmartScreen may warn that the publisher is unknown because the build is not code-signed; choose _More info → Run anyway_.
- **macOS:** open the `.dmg` and drag Campaign Forge to Applications. The first launch needs a right-click → _Open_, because the app is not notarised.
- **Linux:** the `.AppImage` runs on any distribution (`chmod +x` it first); the `.deb` is for Debian and Ubuntu.

Players only need the same installer. They do not need a campaign folder; they join a table from the welcome screen.

### Making a release

Installers are built by the [Release workflow](.github/workflows/release.yml) on GitHub Actions for Windows, macOS (Apple Silicon) and Linux. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, commit, then tag and push:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The workflow publishes the release with all installers attached, and the download page picks it up by itself. The page lives in `site/` and is deployed to GitHub Pages by the [Pages workflow](.github/workflows/pages.yml) whenever it changes. Both need the repository to be public. To build an installer for the current machine only, run `pnpm tauri:build`; it lands in `src-tauri/target/release/bundle/`.

## Development

Prerequisites: Node 22, pnpm, a Rust toolchain, and on Windows the Visual Studio C++ build tools. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri:dev       # run the desktop app with hot reload
pnpm tauri:build     # produce installers for the current OS
```

Checks:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm rust:check
pnpm rust:clippy
```

Husky runs lint-staged, typecheck and (when cargo is available) `cargo check` before each commit, and commitlint on the commit message.

## Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/): `type: subject`. Allowed types are feat, fix, docs, style, refactor, perf, test, build, ci, chore and revert. Scopes are allowed by commitlint but not used here. CI lints every commit on a pull request.

## Project layout

- `src-tauri/src/storage/` — Rust storage layer. All file IO lives here.
- `src-tauri/src/commands.rs` — Tauri commands exposed to the frontend.
- `src/lib/tauri.ts` — typed wrappers for those commands.
- `src/features/` — one folder per screen area.
- `src/stores/` — zustand stores.
