# Playing at the table

Campaign Forge has two faces. The GM's is everything in this guide. The **player view** is a read-only bible of what the GM has shared, and players on the same network can watch it live from their own copy of the app.

## What players see

Nothing, until you share it.

- Every element header has a **Shared / Private** toggle next to the save status. Shared elements show a small eye in the list.
- On a shared **map**, each pin, route and territory has its own **Shared** checkbox, so a world map can go out without the hidden places on it.
- Links are filtered. If a shared element mentions a private one, players see plain text where the link was, and the private element's name appears nowhere else.
- Session **beats** stay private even when the session is shared.
- A **picture** or a document's **PDF** goes out only with its element.

### Secure table connections

For encrypted hosting, give the GM machine a stable DNS name that resolves to its LAN address. Use a certificate for that name that players' browsers and native devices already trust. Set these environment variables for the Campaign Forge process before launching the app.

| Variable                  | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CAMPAIGN_FORGE_TLS_HOST` | The DNS name on the certificate, without a scheme, path or port                                           |
| `CAMPAIGN_FORGE_TLS_CERT` | Path to the PEM certificate chain, leaf first                                                             |
| `CAMPAIGN_FORGE_TLS_KEY`  | Path to the matching PEM private key, kept outside the campaign folder and readable only by the host user |

Start hosting and use the **HTTPS address in the Table panel** for manual joins and QR codes. Supply local DNS at the venue if the table needs to work offline. Restart hosting after renewing the certificate. A change of browser origin can require pairing that browser again.

On a trusted LAN, start hosting with all three TLS settings unset. Current clients join over HTTP and receive updates over an authenticated WebSocket (`ws://`). This mode sends join codes, session credentials and campaign traffic without encryption. For encrypted connections configure TLS above. Clients then use HTTPS and `wss://` exclusively.

Both modes use WebSockets for live updates. Reconnecting replaces the client’s view with the current shared content. The host and native clients must support `table.ws.v1`. Update an older host or native client before joining. Browser players can reload the page served by the updated host. Partial TLS settings or unreadable credentials stop hosting.

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
5. Optionally fill in **Your name at the table**: it is what everyone sees for you in the roster. Left empty, you appear as "Game Master".

While you host, every edit or share change reaches players within about a second. **Stop hosting** ends the table; every player's app returns to its welcome screen with a note that the GM ended the table. Quitting the app while hosting does the same.

The table is announced on the local network with mDNS, the same mechanism printers use. Nothing leaves the network, and nobody joins without the code. A device that gets the code wrong five times is turned away for a minute before it may try again, and the hosting machine logs it.

## Joining a table

On the welcome screen, in the **Join a table** card:

1. Press **Find tables**. The app listens for eight seconds and lists the tables it hears.
2. Press **Join** on the GM's table, or press **Enter an address instead** and type the address the GM reads out.
3. Give your name and the join code, then **Sit down**.

The player view then fills the window: kinds down the side with counts, a searchable list, and a reader. Maps show their shared pins, routes and territories; documents show their PDF. You can write your own notes, which go into the GM's folder (see [Notes](#notes)). **Leave table** at the bottom of the sidebar takes you back.

If the GM's machine goes quiet, the banner says the connection was lost and the app keeps trying until you leave or the GM is back.

### Who is at the table

Everyone at the table, the GM included, sees a bubble for each person along the left edge of the screen: their initials, in a colour that stays the same for them on every device. A green dot means they are here; a crown marks the GM and any player the GM has made a GM. The bubbles float over whatever you are looking at and stay put as you move between pages. Hover over a bubble, or tap it on a phone, to see the name. When there are more people than fit, a **+N** bubble shows the rest.

Drag any bubble and they all move together; let go and they snap to the nearest edge of the screen, top, bottom, left or right. With a keyboard, focus a bubble and use the arrow keys. To get them out of the way, press the small eye at the start of the row: everyone hides behind it, and the eye shows how many are at the table; press it again to bring them back. Each device remembers where you put them and whether you hid them.

Each bubble shows how its person is:

- **Active**: a green dot. They are connected and have used their device in the last five minutes.
- **Away**: a moon, and the bubble turns grey. Their device has had no input for five minutes. Hover over the moon to see how long they have been away ("Away for 7 min"); it updates as time passes. Using the device again makes them active.
- **Disconnected**: a crossed-out Wi-Fi sign and a dashed ring. Their connection dropped; a phone that locks or a laptop that changes Wi-Fi comes back without anyone noticing. If they are not back within a minute, they leave the list. Leaving the table works the same way. A device that walks out of Wi-Fi range without closing can take up to another minute to be noticed.

The GM's own bubble goes away and comes back the same way. The roster shows names, roles and these statuses only; it never shows devices or addresses.

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

Every shared player character shows its whole sheet to everyone at the table, read-only: scores, saves, skills, attacks, spells and the **What to roll** guide, so the party can see each other's characters, and the list says what each one is ("Level 3 Half-elf Bard"). Shared NPCs show a summary line only. The GM can hand a character to a player: on the character's sheet, the **Player** field lists the paired players; pick one. From then on, when that player opens the character at the table the sheet is editable. Hit points, slots, inventory (items added, named, counted and dropped), death saves, all of it saves straight into the GM's file and shows up for the GM within a second. The character still has to be **Shared**, and the player sees only the Players know part of its body like anyone else.

The same works from a phone or tablet joined through the web page, with no app installed. There the owner gets the at-the-table part of the sheet to edit: current and temporary hit points, hit dice, death saves, inspiration, conditions, exhaustion, spell slots, item counts and coins, with big buttons made for a thumb. The rest of the sheet (abilities, skills, attacks, features, spells) is the GM's to change in the app. Each change saves on its own a moment after you make it; the page says Saving and Saved, and if the table is not reachable it keeps the change and offers Retry.

A player cannot change who owns a sheet, and nobody but the owner can edit it over the table. If GM and player edit the same sheet at the same moment, the last save wins.

## Notes

Anyone at the table can write. The **＋ Note** button next to the search box asks for a title and opens a page with a title field, a Markdown body and a save status. The note is created the moment the title is given, as a file in your campaign folder: `elements/note/<title>.md`, with the player recorded as its author. From then on it saves itself a moment after each change, straight into that file, and shows up in your bible under **Notes** within a second with a line saying who wrote it. If the table is not reachable the player keeps what they typed and the page offers Retry.

A note starts out private: its author and you see it, nobody else. The **Only you and the GM** button under the body turns it into **Shared with the table**, which sends it to everyone like any shared element, and back again. Only the author can change or delete their note over the table; you can do both from the bible, as with any file, and the Shared toggle in your header is the same switch. A player who has not been paired yet is recorded by the name they joined with, so their notes stay theirs across evenings as long as they use the same name; pairing them records their player id instead. Because the name is what makes a note theirs, a newcomer cannot sit down under a paired player's name, nor under the name of someone already at the table: they are asked to pick another, or to have you pair their device as that player. If you and the author edit the same note at the same moment, the last save wins.

Your own notes, made with **New** on the Notes view of the bible or from the Everything view, have no author and follow the usual sharing rules.

The same works from a phone or tablet joined through the web page, with no app installed.

## Phones and tablets

There is an Android app for players. It is the player side of Campaign Forge and nothing else: it opens on the **Join your GM's table** card, finds the table on the Wi-Fi or takes the GM's address, and once seated shows the same player view as the desktop app, one pane at a time on a phone. Your character, the map, shared pages and what to roll all work the same way, and the phone pairs with the GM like any other device, so after the first evening it joins with your name alone. The app cannot open a campaign folder, host a table or run the assistant; those stay on a computer. It is installed from an APK rather than a store: open the [download page](https://serwidlick.github.io/campaign-forge/) on the phone, download the APK it offers, open it, allow installing from that source when Android asks, and you are done. It does not update itself; when a new version is out, install its APK the same way over the old one.

For anyone without the app, the hosting panel also shows a QR code and a web address. Anyone on the same Wi-Fi can scan it or type it into a browser and join with their name and the code, with nothing installed. The page makes itself a key like the app does, so you can pair the browser with a player; after that it joins with the name alone, receives that player's private pages, and shows as them in the hosting panel. The table keeps the same port from one evening to the next so the browser is recognised again. The page shows the shared elements with their pictures, opens maps with their shared pins, opens PDFs, follows Show to players, and leaves when the GM ends the table. Everything on it is read-only except your own notes and your own character. Notes work as in the app: **＋ Note** above the list asks for a title, and your own notes open with an editable title and body, a sharing switch and a Delete button. For your character, once the GM has paired the browser with you and handed you a character, opening it shows editable hit points, slots, conditions, item counts and coins that save straight to the GM's copy (see Your own character above). Open a character the GM has not handed to you and it stays a read-only summary.

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

The browser is one device, whichever of the two pages it opens: pairing it on the phone page pairs it for the GM page too, and it stays paired as long as the site's storage is kept (a private window or cleared site data counts as a new device). Two things differ from the app. The assistant's API key is kept by that browser tab only, not in the operating system's credential store: closing the tab forgets it, and you enter it again next time. The page is plain HTTP at a name every table shares, so only put the key into a browser you own, on a network you trust. And building elements from a book with the PDF import runs in the app on the hosting machine; attaching a PDF to a document, pictures and map images from the laptop's disk all work from the browser.

A GM device sees and changes everything, like your own window, so only make players you trust with the whole campaign a GM. The same six-digit code and same-network rules apply as for everyone else.

## Showing something to everyone

While hosting, every element header has a **Show to players** button. Press it and every player gets a bar across the top of their screen saying what you are showing, with **Look** and **Not now**. Nothing moves until they choose, so a player halfway through reading something is not yanked away. On a private element the button reads **Share and show** and does both. The button turns green with **Showing** while it is the current one; the hosting panel names it and has **Stop showing**. A player who joins late is offered the current one on arrival. Showing the same thing again raises the bar again for anyone who waved it away.

## Across devices

A Windows GM with Mac or Linux players, or any other mix, is fine: the protocol is plain HTTP and the data is text and image bytes. Each side's operating system asks its own permission once: the Windows firewall for the host, and recent macOS versions ask the app for local-network access when it browses or hosts.

Both sides must be on the same network without client isolation. Home routers are fine; guest and corporate networks often block device-to-device traffic, which is what the typed address is for.
