# The world bible

Everything in a campaign is an **element**: one Markdown file with a name, tags, a kind, a few kind-specific fields and a body you write freely.

## Kinds

| Family   | Kinds                                        |
| -------- | -------------------------------------------- |
| Play     | Arc, Session, Journal entry, Encounter, Note |
| People   | Character, Creature                          |
| Factions | Faction                                      |
| Places   | Location, Map                                |
| Things   | Item, Document                               |
| Story    | Quest, Event, Lore                           |

Most kinds are just a body. Sessions, arcs, encounters, maps, events, journal entries and documents add a panel of fields above the body; those are covered on their own pages. A **note** is the plainest kind of all: a title and a body, for anything that does not belong anywhere else. Players at the table can write notes too; those land in your folder like any other element, marked with who wrote them (see [Playing at the table](playing-at-the-table.md#notes)).

## Creating, naming, tagging, deleting

- **New** in the list column creates an element of the kind you are looking at. On the Everything view it asks which kind first.
- The name is the big title at the top of the editor. Change it any time; links keep working because they point at the element's id, not its name.
- Tags are a comma-separated line under the name. The list search matches names and tags.
- The small kind label above the name is a dropdown: pick another kind and the element becomes one, keeping its id, name, tags, body and every field. On disk the file's `type` is rewritten and the file moves to that kind's folder, so links to it keep working. Moving a file between folders by hand does not do this; the app reads the kind from the `type` line, not the folder.
- The red bin button in the header deletes the element and its file: click it once and it asks in place, click **Delete** to confirm or anywhere else to keep it. There is no undo beyond your own backups.

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

## Creating a character

In a D&D 5e campaign, naming a new character offers three ways to start:

- **NPC** makes a person in the world with a light sheet, for someone the players meet rather than play.
- **Character sheet** makes a blank player sheet to fill in by hand.
- **Charactermancer** builds a player character step by step: species, class and level (with the subclass once the class would have one, and any other classes a character already multiclassed into, each with its own level and subclass), background, ability scores (standard array, point buy, 4d6-drop-lowest rolls, or typed in, with species bonuses added and any flexible bonus points placed), skills (what species and background grant is already ticked; you pick the class's choices, any the background leaves open, and expertise for rogues and bards), then name, alignment, hit points (the book's maximum, editable) and personality. The review page shows the finished sheet and lists anything still to choose; nothing is written to disk until you press **Create character**. Saving throws, speed, senses, languages, species traits and spell slots are filled in from the picks. Equipment, class features and spells known are left for the sheet.

In another game's campaign, a new character is just named and opened.

## Character sheets

In a D&D 5e campaign every character has a sheet above its body: role (player character or NPC), the player who may edit it at the table (see [Playing at the table](playing-at-the-table.md#your-own-character)), class, subclass and level, species, background and alignment, with dropdown suggestions for the published classes, subclasses, species and backgrounds (type anything else for homebrew; picking a class fills its saving throws, picking a species sets its speed and any skills it grants, picking a background adds its skills). **Add a class** multiclasses: each class gets its own line with its own level and subclass, the character level is the total and sets the proficiency bonus, and a level-up is a change to whichever class's level advances (Fighter 3 / Rogue 1 is character level 4; raise the Rogue level and it is Fighter 3 / Rogue 2 at level 5 with a +3 proficiency bonus). A single-class sheet looks as it always did. A line under those fields spells out what each pick gives: hit die, saves, skill choices, armour and weapons for the class; ability bonuses, speed, size, darkvision, traits and languages for the species, fixed bonuses are added to the scores for you, and species that leave the choice open give you a pool of points to place with the plus and minus buttons under each score, with a reminder of how many are left; hit points, speed, senses and languages are filled in when empty; skills, tools and languages for the background. Class skill choices are marked with a dot in the skill list; the six ability scores with their modifiers; AC, hit points (current, maximum, temporary) and speed; initiative, proficiency bonus and passive Perception, which are worked out for you; saving throw and skill proficiencies as chips (click a skill once for proficiency, twice for expertise), each showing its total; senses and languages.

Below the stats, folding sections hold the rest of a player character: attacks (to hit, damage, notes), features and traits, spellcasting (ability, save DC and attack bonus worked out, slots per level that follow the classes and their levels until you edit them, pooled across every casting class by the multiclass rule while a warlock's Pact Magic slots sit on their own line with a short-rest button, a spell list with prepared ticks, and a long-rest button), inventory with weight and coin, personality traits, ideals, bonds and flaws, and a right-now strip with inspiration, death saves, hit dice, exhaustion and conditions.

### What to roll

Between the derived numbers and the saving throws sits a **What to roll** strip. The app never rolls dice; this strip names the die and lists every bonus with where it comes from, so a player can pick up the right dice and add the right numbers without working anything out. Stealth, say, reads `1d20 + 2 (prof) + 3 (dex)`.

It covers every roll the sheet knows about: an ability check and a saving throw for each of the six abilities, initiative and death saves, every skill, melee and ranged weapon attacks, the spell attack and spell save DC once a spellcasting ability is set, and each attack in the attacks section with its to-hit and damage. Give an attack a **kind** (melee or thrown for Strength, finesse or ranged for Dexterity, or spell attack) and its to-hit is built from proficiency and that ability, with anything typed in the bonus field added as "extra"; choose **Typed bonus** to enter the whole to-hit yourself. The header reminds players that advantage or disadvantage means rolling two d20 and keeping the higher or lower.

On the GM's editor the strip starts folded, since the fields it derives from matter more there. For a player opening their own character at the table, in the app or on the phone page, it starts open.

The sheet is stored in the element's frontmatter as `sheet`, so it travels with the file, and the assistant can fill it in when you ask.

## Creature stat blocks

In a D&D 5e campaign every creature has a stat block above its body: size, type, alignment and challenge rating (XP and proficiency bonus follow), armour class and hit points with their notes and formula, speed, the six ability scores with modifiers, then saving throws, skills, damage vulnerabilities, resistances and immunities, condition immunities, senses and languages as text lines, and lists of traits, actions, bonus actions, reactions and legendary actions, each a name and a sentence or two. Players who are shown a shared creature see it laid out like a printed stat block.

## Pictures

The square tile at the left of every element header is its picture. Click it to choose an image; it is copied into the campaign folder under `assets/images/` and shown on list rows, on map pin labels and in the player view. Hover the tile for a small bin to remove it. Elements without a picture show their initial on the colour of their kind.

## Documents

A **Document** is an element that carries a PDF: a rulebook, a handout, a letter. Create one under Things, press **Choose a PDF**, and the file is copied into `assets/docs/`. It shows inline above the notes using the built-in viewer, with paging, zoom and search.

Because it is an element you can @-mention it, open it beside a session with Ctrl+click, and share it with players as a handout.

To build elements out of a PDF rather than just keep it, see [Importing a PDF](importing-a-pdf.md).

## Finding things

- The search box above the list filters by name and tag within the current kind, or across everything on the Everything view.
- The assistant can search bodies too, if you use it.
- The **Everything** view with nothing selected shows the **wheel**: the party at the centre, six spokes for the families, every element a click away. Clicking a spoke filters.
- **Graph** shows every element as a node and every link, arc membership and map pin as an edge. Drag nodes, zoom, search, filter by family, show or hide elements with no connections, and click a node to open it.

## Split screen

Ctrl+click opens an element in a column beside the current one, up to three. Each side column has buttons to swap it with the main column or close it. Side columns are remembered per campaign, so you can keep a rulebook document open next to your session plan.
