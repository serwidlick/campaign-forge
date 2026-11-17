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

The **Preview** tile (the eye) at the bottom of the sidebar switches the whole window to the player view, fed from your own files. Use it to check what a handout looks like before the session. **Back to GM view** returns.

## Hosting a table

1. Press the **Table** tile (the radio) at the bottom of the sidebar and then **Start hosting**.
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

Players need no account. Every copy of the app makes itself a key the first time it runs and keeps it in the operating system's credential store. When someone joins your table, from the app or from the phone page, their row in **At the table** shows their device and a **Pair as new player** button (or a dropdown to attach the device to a player you already have). Pairing writes the player, with their device, into `campaign.json`, so it travels with the folder.

From then on:

- That device joins without a code. The app proves it holds the key by signing a one-time challenge; nothing secret is ever sent.
- The player's name is the one you gave, not whatever they typed.
- You can assign pages and characters to them (below).

The **Players** section of the hosting panel lists everyone with their devices. Remove a device and it needs the code again; remove a player and their assignments stop matching. A player with a second laptop simply gets paired again, to the same player. A browser keeps its key in the site's storage, so clearing site data, a private window, or a different browser on the same phone counts as a new device and needs the code once more. A browser that cannot make a key shows as a guest and cannot be paired.

## Only for some players

A shared element normally goes to everyone at the table. The shared strip under its header has a **Visible to** dropdown: tick players and only they receive it; the rest never see it exists. That makes private letters, a secret the rogue found, or a faction briefing straightforward. The player preview has a **Previewing as** selector so you can check each person's view.

## Your own character

The GM can hand a character to a player: on the character's sheet, the **Player** field lists the paired players; pick one. From then on, when that player opens the character at the table they get the full sheet, editable, instead of the read-only summary. Hit points, slots, inventory, death saves, all of it saves straight into the GM's file and shows up for the GM within a second. The character still has to be **Shared**, and the player sees only the Players know part of its body like anyone else.

The same works from a phone or tablet joined through the web page, with no app installed. There the owner gets the at-the-table part of the sheet to edit: current and temporary hit points, hit dice, death saves, inspiration, conditions, exhaustion, spell slots, item counts and coins, with big buttons made for a thumb. The rest of the sheet (abilities, skills, attacks, features, spells) is the GM's to change in the app. Each change saves on its own a moment after you make it; the page says Saving and Saved, and if the table is not reachable it keeps the change and offers Retry.

A player cannot change who owns a sheet, and nobody but the owner can edit it over the table. If GM and player edit the same sheet at the same moment, the last save wins.

## Phones and tablets

The hosting panel also shows a QR code and a web address. Anyone on the same Wi-Fi can scan it or type it into a browser and join with their name and the code, with nothing installed. The page makes itself a key like the app does, so you can pair the browser with a player; after that it joins with the name alone, receives that player's private pages, and shows as them in the hosting panel. The table keeps the same port from one evening to the next so the browser is recognised again. The page shows the shared elements with their pictures, opens maps with their shared pins, opens PDFs, follows Show to players, and leaves when the GM ends the table. Everything on it is read-only except your own character: once the GM has paired the browser with you and handed you a character, opening it shows editable hit points, slots, conditions, item counts and coins that save straight to the GM's copy (see Your own character above). Open a character the GM has not handed to you and it stays a read-only summary.

## Running the table from a second machine

The files can live on one machine while you run the session from another: a desktop upstairs holds the campaign and hosts, and you sit downstairs with a laptop that has the whole GM view, not the player one. Nothing is copied; the laptop reads and writes the desktop's files over the table, and the desktop's own window follows every change within a second, the same way it follows a player editing their sheet.

1. Host on the machine that has the files and keep it hosting.
2. Join from the laptop like a player: find the table, give your name and the code, **Sit down**.
3. On the hosting machine, pair the laptop's row with **Pair as new player** (yourself, under your own name).
4. In the **Players** section, press **Make GM** on that player.

The laptop switches to the GM view on the spot, with a strip across the top naming the hosting machine. From then on it joins straight into the GM view with no code. Everything works as it does on the host: editing, creating and deleting elements, sharing and audiences, Show to players, pairing devices, the assistant with its saved conversations, importing pictures and PDFs from the laptop's own disk, the player preview. Only three things stay with the hosting machine: opening or creating a campaign, starting and stopping the table, and the folder itself. **Leave table** at the top of the sidebar takes the laptop back to its own campaigns.

**Revoke GM** drops the laptop back to the player view immediately, connected or not. If the hosting machine stops hosting or goes to sleep, the laptop's strip says the connection was lost and edits wait until it is back; the usual version check keeps a late save from overwriting a newer one.

### From a browser, with nothing installed

The laptop does not need the app. The hosting panel's **Phones and tablets** section shows the table's web address. First pair the laptop's browser like any phone: open that address, give your name and the code, **Sit down**, and on the hosting machine pair its row and press **Make GM**. Then add `gm` to the address (for example `http://forge.local/gm`) and open it in the same browser. It is the same GM view as the app, served by the hosting machine, and it connects on its own: the browser's key is the proof, so there is no name or code to type.

Nobody else gets in. The GM page seats only a browser that is paired with a player marked GM; any other device, code or not, is turned away with a note saying what the GM would have to do. Players use the main page, which is the player view. If you press **Revoke GM** while the laptop is on the GM page, it is sent back to that note at once.

The browser is one device, whichever of the two pages it opens: pairing it on the phone page pairs it for the GM page too, and it stays paired as long as the site's storage is kept (a private window or cleared site data counts as a new device). Two things differ from the app. The assistant's API key is kept in that browser's own storage rather than the operating system's credential store, so only put it in a browser you own. And building elements from a book with the PDF import runs in the app on the hosting machine; attaching a PDF to a document, pictures and map images from the laptop's disk all work from the browser.

A GM device sees and changes everything, like your own window, so only make players you trust with the whole campaign a GM. The same six-digit code and same-network rules apply as for everyone else.

## Showing something to everyone

While hosting, every element header has a **Show to players** button. Press it and every player gets a bar across the top of their screen saying what you are showing, with **Look** and **Not now**. Nothing moves until they choose, so a player halfway through reading something is not yanked away. On a private element the button reads **Share and show** and does both. The button turns green with **Showing** while it is the current one; the hosting panel names it and has **Stop showing**. A player who joins late is offered the current one on arrival. Showing the same thing again raises the bar again for anyone who waved it away.

## Across devices

A Windows GM with Mac or Linux players, or any other mix, is fine: the protocol is plain HTTP and the data is text and image bytes. Each side's operating system asks its own permission once: the Windows firewall for the host, and recent macOS versions ask the app for local-network access when it browses or hosts.

Both sides must be on the same network without client isolation. Home routers are fine; guest and corporate networks often block device-to-device traffic, which is what the typed address is for.
