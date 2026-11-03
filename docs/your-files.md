# Your files

A campaign is a folder. You can open it in any editor, put it in a cloud drive, copy it to another machine, or check it into git. The app never keeps campaign content anywhere else.

## Layout

```text
my-campaign/
  campaign.json              name, system, calendar, travel paces
  elements/
    character/
      harbourmaster-ivel.md
    location/
      the-rusty-tankard.md
    map/
      sword-coast.md
    session/
      session-12.md
    ...one folder per kind
  assets/
    maps/sword-coast.png      map images
    images/ivel.png           element pictures
    docs/players-handbook.pdf documents
```

File names come from the element's name when it is created and do not change on rename; links use the id, not the name, so nothing breaks.

## An element file

```markdown
---
id: 7f0c6a2e-1b1a-4f5c-9d2e-0e4f3a2b1c0d
type: location
name: The Rusty Tankard
tags: [inn, harbour]
createdAt: 2026-11-02T18:04:11Z
updatedAt: 2026-11-03T21:12:40Z
shared: true
portrait: assets/images/the-rusty-tankard.png
---

A low-beamed inn by the harbour, run by [Ivel](cf://element/9a1b...).

## Players know

Cheap ale, good gossip, never ask about the cellar.
```

The part between the `---` lines is YAML frontmatter. Keys the app knows:

| Key                                                                         | On        | Meaning                                                                              |
| --------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `id`, `type`, `name`                                                        | all       | Identity. Never edit `id`.                                                           |
| `tags`                                                                      | all       | List of strings.                                                                     |
| `shared`                                                                    | all       | `true` makes the element visible to players.                                         |
| `portrait`                                                                  | all       | Path of the picture under `assets/images/`.                                          |
| `sheet`                                                                     | character | The D&D 5e sheet: role, class, level, abilities, ac, hp, saves, skills.              |
| `arc`, `number`, `date`, `status`, `beats`, `worldDate`                     | session   | See [sessions](sessions-and-journals.md).                                            |
| `status`                                                                    | arc       | `active` or `complete`.                                                              |
| `when`, `until`                                                             | event     | In-world dates `{ year, month, day }`.                                               |
| `date`, `worldDate`, `scope`                                                | journal   | Real date, in-world date, and `{ type, id }` where type is campaign, arc or session. |
| `image`, `width`, `height`, `fit`, `scale`, `pins`, `routes`, `territories` | map       | See [maps](maps.md). Pins, routes and territories each carry `shared`.               |
| `file`, `fileName`, `fileBytes`                                             | document  | The PDF under `assets/docs/`.                                                        |

Unknown keys are preserved, so other tools can add their own.

Links in bodies look like `[Name](cf://element/<id>)`. The id is the target's `id`. The text is just the label that was current when the link was made.

## Campaign settings

`campaign.json` holds the campaign's name, system, creation dates and settings: `rules` (`dnd5e` or `generic`), the `calendar` (months, weekdays, eras, today) and `travel` (hours per day and the list of paces).

## Backups and cloud drives

Back up the folder like any other. Because every change is a small text file, it also suits git.

Putting the folder in Dropbox, OneDrive, iCloud Drive or Google Drive works and is the simplest way to use the same campaign on two machines. Only edit on one machine at a time; sync clients that see two edits to the same file make a "conflicted copy" next to it, which the app ignores.

## Editing files by hand

Go ahead. The app reads the file again when it is selected and after the assistant edits it. If you edit a file while it is open in the editor, reselect it to see the change. Keep the frontmatter valid YAML and keep the `id`.
