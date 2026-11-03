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

## Showing something to everyone

While hosting, every element header has a **Show to players** button. Press it and that element opens on every player's screen. On a private element the button reads **Share and show** and does both. The button turns green with **Showing** while it is the current one; the hosting panel names it and has **Stop showing**. A player who joins late gets the current one on arrival.

Players can wander off to read other things afterwards; showing again brings them back.

## Across devices

A Windows GM with Mac or Linux players, or any other mix, is fine: the protocol is plain HTTP and the data is text and image bytes. Each side's operating system asks its own permission once: the Windows firewall for the host, and recent macOS versions ask the app for local-network access when it browses or hosts.

Both sides must be on the same network without client isolation. Home routers are fine; guest and corporate networks often block device-to-device traffic, which is what the typed address is for.
