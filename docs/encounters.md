# Encounters

An **encounter** is a fight (or any scene that runs in turns) you plan ahead and then run at the table. Encounters live under **Play** in the sidebar, next to arcs and sessions. Like everything else, each one is a Markdown file: the turn order sits in its frontmatter and your prep in the body.

## Creating one

Open **Encounters** in the sidebar and press **New**. The body starts with headings for Setup, Tactics, Terrain and complications, and Aftermath; write as much or as little as you like. Rename, tag, delete and link it like any element.

## Building the turn order

Above the body sits the encounter panel.

- **Add a combatant** by typing in the search box. It matches names and tags of everything in the **People** family: player characters, NPCs, creatures and factions. Pick one with the arrow keys and Enter, or click it. Add the same creature as many times as you need; the second goblin becomes "Goblin 2".
- A name that matches nothing can still be added **as a one-off**: a nameless guard, a swarm, a trap that acts on its own initiative. One-offs are not in the bible and have no link.
- Each combatant row has an **initiative**, **HP** (current and maximum), **AC**, a set of **conditions**, a line of **notes**, and a skull button that marks it **out of the fight**.
- Drag a row by its grip to reorder, or use the arrows. **Sort by initiative** puts the highest first, breaks ties on the better bonus, and leaves blanks at the end.

In a D&D 5e campaign, adding a character copies its hit points and AC from the sheet, adding a creature copies them from the stat block, and the small number under the initiative box is its Dexterity modifier, so you know what to add to the roll. The app never rolls dice; you type the result.

Hit points are tracked in the encounter, not on the sheet. The sheet is never rewritten by a fight, so a character's HP in the bible stays whatever the player last set. To damage or heal quickly, type `-7` or `+5` into the HP box and press Enter; typing a plain number sets it.

Click a combatant's name to open its sheet or stat block, Ctrl+click to open it beside the encounter.

## Running it

Press **Start encounter**. The status turns to Running, the round counter reads 1 and the first combatant is highlighted.

- **Next turn** moves the highlight down the list, skipping anyone marked out of the fight. Past the last combatant it starts a new round.
- **Back** goes the other way, and never before the start of round one.
- Adding, removing or reordering combatants mid-fight keeps the highlight on whoever's turn it was.
- **End** marks the encounter finished. **Reset** takes a finished encounter back to planned, with its combatants and their hit points as they were, so you can run it again or tidy it up as a record.

Everything saves as you go, so closing the app mid-fight loses nothing: reopen the encounter and it is still round 3, the ogre's turn.

## What players see

An encounter is private until you mark it **Shared**, like any element. A shared encounter shows players the turn order: names, initiative, conditions, who is down and whose turn it is, updating live at the table. Hit points, AC and your per-combatant notes never leave your machine, and a combatant whose element is not shared is a plain name with no link. The usual `## Players know` rule applies to the body.
