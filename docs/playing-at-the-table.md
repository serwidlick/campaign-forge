# Playing at the table

Campaign Forge has two faces. The GM's is everything in this guide. The **player view** is a read-only bible of what the GM has shared, and players on the same network can watch it live from their own copy of the app.

## What players see

Nothing, until you share it.

- Every element header has a **Shared / Private** toggle next to the save status. Shared elements show a small eye in the list.
- On a shared **map**, each pin, route and territory has its own **Shared** checkbox, so a world map can go out without the hidden places on it.
- Links are filtered. If a shared element mentions a private one, players see plain text where the link was, and the private element's name appears nowhere else.
- Session **beats** stay private even when the session is shared.
- A **picture** or a document's **PDF** goes out only with its element.

### Players know

To share part of an element, put a heading named `## Players know` in its body. Players then receive only that section, up to the next heading of the same or a higher level; the rest of the body stays yours. Shared elements show a strip under the header saying which case applies, with a button that adds the heading for you. The headings "What players know", "What the players know" and "Player-facing" count too, at any level.

Backlinks on the player side are computed from the player-facing part only.

### Preview as a player

The eye button at the top of the sidebar switches the whole window to the player view, fed from your own files. Use it to check what a handout looks like before the session. **Back to GM view** returns.

## Hosting a table

1. Press the **radio** button at the top of the sidebar and then **Start hosting**.
2. Windows asks once whether to allow Campaign Forge on private networks. Say yes, or nobody can reach you.
3. The panel shows a six-digit **join code** and your machine's addresses. Read the code out.
4. **At the table** lists who has joined, with a green dot while they are connected.

While you host, every edit or share change reaches players within about a second. **Stop hosting** ends the table; every player's app returns to its welcome screen with a note that the GM ended the table. Quitting the app while hosting does the same.

The table is announced on the local network with mDNS, the same mechanism printers use. Nothing leaves the network, and nobody joins without the code.

## Joining a table

On the welcome screen, in the **Join a table** card:

1. Press **Find tables**. The app listens for eight seconds and lists the tables it hears.
2. Press **Join** on the GM's table, or press **Enter an address instead** and type the address the GM reads out.
3. Give your name and the join code, then **Sit down**.

The player view then fills the window: kinds down the side with counts, a searchable list, and a reader. Maps show their shared pins, routes and territories; documents show their PDF. **Leave table** at the bottom of the sidebar takes you back.

If the GM's machine goes quiet, the banner says the connection was lost and the app keeps trying until you leave or the GM is back.

## Players and devices

Players need no account. Every copy of the app makes itself a key the first time it runs and keeps it in the operating system's credential store. When someone joins your table from the app, their row in **At the table** shows their device and a **Pair as new player** button (or a dropdown to attach the device to a player you already have). Pairing writes the player, with their device, into `campaign.json`, so it travels with the folder.

From then on:

- That device joins without a code. The app proves it holds the key by signing a one-time challenge; nothing secret is ever sent.
- The player's name is the one you gave, not whatever they typed.
- You can assign pages and characters to them (below).

The **Players** section of the hosting panel lists everyone with their devices. Remove a device and it needs the code again; remove a player and their assignments stop matching. A player with a second laptop simply gets paired again, to the same player. The phone page has no key, so phones always join with the code as guests.

## Only for some players

A shared element normally goes to everyone at the table. The shared strip under its header has a **Visible to** dropdown: tick players and only they receive it; the rest never see it exists. That makes private letters, a secret the rogue found, or a faction briefing straightforward. The player preview has a **Previewing as** selector so you can check each person's view.

## Your own character

The GM can hand a character to a player: on the character's sheet, the **Player** field lists the paired players; pick one. From then on, when that player opens the character at the table they get the full sheet, editable, instead of the read-only summary. Hit points, slots, inventory, death saves, all of it saves straight into the GM's file and shows up for the GM within a second. The character still has to be **Shared**, and the player sees only the Players know part of its body like anyone else.

A player cannot change who owns a sheet, and nobody but the owner can edit it over the table. If GM and player edit the same sheet at the same moment, the last save wins.

## Phones and tablets

The hosting panel also shows a QR code and a web address. Anyone on the same Wi-Fi can scan it or type it into a browser and join with their name and the code, with nothing installed. The page shows the shared elements with their pictures, opens maps with their shared pins, opens PDFs, follows Show to players, and leaves when the GM ends the table. It is read-only: editing your own character needs the app.

## Showing something to everyone

While hosting, every element header has a **Show to players** button. Press it and every player gets a bar across the top of their screen saying what you are showing, with **Look** and **Not now**. Nothing moves until they choose, so a player halfway through reading something is not yanked away. On a private element the button reads **Share and show** and does both. The button turns green with **Showing** while it is the current one; the hosting panel names it and has **Stop showing**. A player who joins late is offered the current one on arrival. Showing the same thing again raises the bar again for anyone who waved it away.

## Across devices

A Windows GM with Mac or Linux players, or any other mix, is fine: the protocol is plain HTTP and the data is text and image bytes. Each side's operating system asks its own permission once: the Windows firewall for the host, and recent macOS versions ask the app for local-network access when it browses or hosts.

Both sides must be on the same network without client isolation. Home routers are fine; guest and corporate networks often block device-to-device traffic, which is what the typed address is for.
