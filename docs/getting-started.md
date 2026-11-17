# Getting started

## Install

Download the installer for your system from the [download page](https://serwidlick.github.io/campaign-forge/). It picks the right file for you; every version is also on the GitHub releases page.

- **Windows:** run the `.exe`. It installs for your user only, so no admin prompt. SmartScreen may say the publisher is unknown because the build is not code-signed: choose _More info_, then _Run anyway_.
- **macOS (Apple Silicon):** open the disk image and drag Campaign Forge to Applications. If macOS calls the app damaged, see [Troubleshooting](troubleshooting.md#macos-says-the-app-is-damaged).
- **Linux:** make the `.AppImage` executable and run it, or install the `.deb` on Debian and Ubuntu.
- **Android (players only):** the download page offers the `.apk` when you open it on the phone. Open the file and allow installing from that source when Android asks. It is the player side of the app, for joining a table; see [Playing at the table](playing-at-the-table.md#phones-and-tablets).

Players install the same app, or the Android app on a phone. They do not need a campaign folder.

## Your first campaign

1. Press **New campaign** on the welcome screen and choose an empty folder. A Documents subfolder, a cloud-drive folder, a USB stick: anywhere you like.
2. Give it a name and choose the **rules**. Dungeons & Dragons 5e gives characters a 5e sheet and 5e-shaped templates; Another game gives plain templates and a free-text system label. Campaigns made before this choice existed count as 5e.
3. The window opens on the world bible with nothing in it yet. Press **New** in the list column to create your first element.

To work on a campaign someone else made, or one you moved, press **Open campaign folder** and pick the folder that contains `campaign.json`.

The welcome screen remembers recent campaigns. The most recent one has a **Continue** button; **Show folder** opens it in Explorer or Finder.

## The window

The main screen has three columns and an optional fourth.

| Column               | What it holds                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Kinds, on the left   | Everything, Timeline, Graph, Journal, then the element kinds grouped by family (Play, People, Factions, Places, Things, Story) with counts. |
| List                 | The elements of the chosen kind, with search, and the **New** button.                                                                       |
| Main                 | The selected element's editor, or the overview wheel when nothing is selected.                                                              |
| Assistant (optional) | The AI helper, toggled with the **Assistant** tile at the bottom of the sidebar.                                                            |

Drag the dividers to resize. The layout and open columns are remembered per campaign.

**Campaigns** at the top of the sidebar goes back to the welcome screen. A row of four tiles at the bottom of the sidebar holds **Table** (the hosting panel), **Preview** (the player view, fed from your own files), **Assistant** (toggles the fourth column) and **Theme**.

## Themes

Eight colour themes, five dark and three light: Ember (charcoal and firelight, the default), Moonstone, Greenwood, Obsidian and Dusk, then Parchment, Daylight and Sage. Pick one from the **Theme** tile at the bottom of the sidebar, the **Theme** link in the welcome screen's footer, or the palette button in the player view's banner.

The choice is a preference of the app on this machine, not of the campaign: it is remembered between launches, applies to every campaign you open, and is not written to the campaign folder, so players and other machines keep their own.

## Keyboard and mouse habits worth learning

- **Ctrl+click** (Cmd+click on a Mac) any element reference, in a list, a link, a backlink, a map pin, to open it in a column beside the current one. Up to three side columns.
- **Alt+click** a link inside the editor to open it in the main column.
- Type **@** in any body to link to another element. Arrow keys or Tab move through the suggestions, Enter inserts.
- **Escape** cancels a map tool. **Enter** finishes a route or territory you are drawing.
