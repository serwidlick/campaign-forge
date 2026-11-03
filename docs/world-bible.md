# The world bible

Everything in a campaign is an **element**: one Markdown file with a name, tags, a kind, a few kind-specific fields and a body you write freely.

## Kinds

| Family   | Kinds                       |
| -------- | --------------------------- |
| Play     | Arc, Session, Journal entry |
| People   | Character, Creature         |
| Factions | Faction                     |
| Places   | Location, Map               |
| Things   | Item, Document              |
| Story    | Quest, Event, Lore          |

Most kinds are just a body. Sessions, arcs, maps, events, journal entries and documents add a panel of fields above the body; those are covered on their own pages.

## Creating, naming, tagging, deleting

- **New** in the list column creates an element of the kind you are looking at. On the Everything view it asks which kind first.
- The name is the big title at the top of the editor. Change it any time; links keep working because they point at the element's id, not its name.
- Tags are a comma-separated line under the name. The list search matches names and tags.
- The red bin button in the header deletes the element and its file. There is no undo beyond your own backups.

Everything saves itself a moment after you stop typing. The small word next to the bin says Saved, Unsaved or Saving.

## Writing

The body is a rich-text editor that reads and writes Markdown. Headings, lists, bold, italics, quotes, code and links all round-trip to the file, so you can also edit the file in any text editor and the app picks the change up.

- Type **@** and start typing a name to link another element. The link is stored as `[Name](cf://element/<id>)`.
- Ctrl+click a link to open it beside the current element, Alt+click to open it here.
- Under the body, **Links to** lists what this element mentions and **Linked from** lists what mentions it. Both update as you type.

### Players know

If a body contains a heading such as `## Players know`, players receive only that section; everything else in the element stays yours. See [Playing at the table](playing-at-the-table.md#what-players-see) for the rules.

## Templates

A new element starts from a template for its kind: a body skeleton of headings such as Appearance, Personality and Backstory for a character, or Hook, Objectives, Complications and Rewards for a quest. Every template ends with a **Players know** heading, so a freshly shared element reveals nothing until you write something there. Delete any heading you do not want; they are only text.

## Character sheets

In a D&D 5e campaign every character has a sheet above its body: role (player character or NPC), class, subclass, level, species, background and alignment, with dropdown suggestions for the published classes, subclasses, species and backgrounds (type anything else for homebrew; picking a class fills its saving throws, picking a species sets its speed); the six ability scores with their modifiers; AC, hit points (current, maximum, temporary) and speed; initiative, proficiency bonus and passive Perception, which are worked out for you; saving throw and skill proficiencies as chips (click a skill once for proficiency, twice for expertise), each showing its total; senses and languages.

The sheet is stored in the element's frontmatter as `sheet`, so it travels with the file, and the assistant can fill it in when you ask.

## Pictures

The square tile at the left of every element header is its picture. Click it to choose an image; it is copied into the campaign folder under `assets/images/` and shown on list rows, on map pin labels and in the player view. Hover the tile for a small bin to remove it. Elements without a picture show their initial on the colour of their kind.

## Documents

A **Document** is an element that carries a PDF: a rulebook, a handout, a letter. Create one under Things, press **Choose a PDF**, and the file is copied into `assets/docs/`. It shows inline above the notes using the built-in viewer, with paging, zoom and search.

Because it is an element you can @-mention it, open it beside a session with Ctrl+click, and share it with players as a handout.

## Finding things

- The search box above the list filters by name and tag within the current kind, or across everything on the Everything view.
- The assistant can search bodies too, if you use it.
- The **Everything** view with nothing selected shows the **wheel**: the party at the centre, six spokes for the families, every element a click away. Clicking a spoke filters.
- **Graph** shows every element as a node and every link, arc membership and map pin as an edge. Drag nodes, zoom, search, filter by family, show or hide elements with no connections, and click a node to open it.

## Split screen

Ctrl+click opens an element in a column beside the current one, up to three. Each side column has buttons to swap it with the main column or close it. Side columns are remembered per campaign, so you can keep a rulebook document open next to your session plan.
