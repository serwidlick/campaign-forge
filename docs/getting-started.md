# Getting started

## Install

Download the installer for your system from the [download page](https://serwidlick.github.io/campaign-forge/). It picks the right file for you; every version is also on the GitHub releases page.

- **Windows:** run the `.exe`. It installs for your user only, so no admin prompt. SmartScreen may say the publisher is unknown because the build is not code-signed: choose _More info_, then _Run anyway_.
- **macOS (Apple Silicon):** open the disk image and drag Campaign Forge to Applications. If macOS calls the app damaged, see [Troubleshooting](troubleshooting.md#macos-says-the-app-is-damaged).
- **Linux:** make the `.AppImage` executable and run it, or install the `.deb` on Debian and Ubuntu.

Players install the same app. They do not need a campaign folder.

## Your first campaign

1. Press **New campaign** on the welcome screen and choose an empty folder. A Documents subfolder, a cloud-drive folder, a USB stick: anywhere you like.
2. Give it a name and, if you want, the game system. The system is just a label.
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
| Assistant (optional) | The AI helper, toggled with the sparkle button at the top of the sidebar.                                                                   |

Drag the dividers to resize. The layout and open columns are remembered per campaign.

Buttons at the top of the sidebar: **Campaigns** goes back to the welcome screen, the radio icon opens the table hosting panel, the eye opens the player preview, the sparkle toggles the assistant.

## Keyboard and mouse habits worth learning

- **Ctrl+click** (Cmd+click on a Mac) any element reference, in a list, a link, a backlink, a map pin, to open it in a column beside the current one. Up to three side columns.
- **Alt+click** a link inside the editor to open it in the main column.
- Type **@** in any body to link to another element. Arrow keys or Tab move through the suggestions, Enter inserts.
- **Escape** cancels a map tool. **Enter** finishes a route or territory you are drawing.
