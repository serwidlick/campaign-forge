# Table messages: the person card

Status: plan, not started. Builds on the presence bubbles (`docs/plans/table-roster.md`, `src/lib/presence/`).

Pressing someone's bubble opens a card next to it. The card shows who they are and how they are. It also holds a conversation with them: players can message each other, and the GM can message any player. While someone writes to you, their bubble and your card with them show that they are typing. Nobody else sees it: not the GM, not the other players, and not the writer.

The card is a frame for sections. Messaging is the first section, and later features (GM actions, dice, handouts) add sections without touching the card.

## What exists today

- **Server to device.** The live socket (`table.ws.v1`, `src-tauri/src/table/server/live.rs`) is one-way. The device sends only its hello and pongs, and any other incoming message ends the socket. Device to server goes over HTTP with the seat's bearer token, as idle reports do (`POST /api/presence`).
- **Who is who.** Every roster entry has a stable key: `host`, `player:<id>` or `guest:<opaque>`.
  - Each socket's roster frames now say which key is its own (`you`, built by `share::roster::person_key`). The server can therefore address a person, and each device knows who it is.
  - A guest key is per seat, not per name. A new guest who takes a freed name gets a new key, so they cannot read the old guest's messages. This is the same rule that keeps private notes safe.
- **Bubble behaviour to build on.**
  - A tap on a bubble shows its name tip.
  - The `messaging` and `messaged` activities exist (badge, animation, and a `notice` buzz on your own device).
  - `motion.js` has the motion vocabulary: shuffle, slide, emerge and vanish (FLIP-style, `transform` and `opacity` only, the Web Animations API, tuning in frozen objects, skipped for reduced motion).
  - Each device can mark its own bubble as `you` and, while offline, sees the host as disconnected.

## Decisions (recommended; open to change)

1. **Messages live in the host's memory only, for as long as the table runs.** They are never written to the campaign folder, and they are gone when hosting stops.
   - This keeps the rule that nothing about the campaign is cached where the user cannot see it. Chat is not campaign content.
   - Saving a conversation into a journal can be a later card section.
2. **The GM's screen shows only the GM's own conversations.**
   - The host process routes player-to-player messages but no UI shows them to the GM.
   - The plan says so in the docs, because the hosting machine technically holds them in memory.
3. **The GM gets one switch in the host panel: "Players can message each other"** (on by default). When it is off, players can still message the GM.
4. **Typing reaches only the person being written to.** The server keeps typing state per pair and sends each device only the "typing to you" list for its own person.
5. **Delivery uses what exists.**
   - Sending a message or a typing change is an HTTP POST, like idle reports. That reuses the bearer authorisation, rate limits and the code paths on all three clients (Rust client, browser GM page, phone page).
   - Delivery rides the live socket's frames. Two-way socket frames can replace the typing POSTs later without changing the card.

## Wire

### Host state: `src-tauri/src/table/server/messages.rs` (new)

- **`MessageHub`** holds:
  - a bounded log (`VecDeque<ChatMessage>`, at most 200 per conversation and 2,000 in all; the oldest go first);
  - a `watch<u64>` sequence that wakes sockets;
  - typing state, `HashMap<(from, to), Instant>`, which expires 6 s after the last refresh.
- **`ChatMessage { id, seq, from, to, text, at }`**:
  - `from` and `to` are roster keys;
  - `at` is Unix ms on the host clock, so the existing `serverTime` offset applies;
  - `id` is a UUID;
  - `clientId` is echoed back, for optimistic sending.
- **Rules, enforced on the server:**
  - `from` is always the sender's own key, derived from the seat and never read from the request.
  - `to` must be on the current roster or be `host`, and must not be the sender.
  - The text must be 1 to 500 characters after trimming, and is stored as given (it is rendered only as text).
  - Each seat may send at most 5 messages in any 5 s, and at most 1 typing report per second.
  - Player to player is refused while the GM's switch is off.
- **Who receives a message:** the sender's and the recipient's devices, meaning every open socket whose person key matches either one. A paired player on two devices gets it on both.

### HTTP

- **`POST /api/messages {to, text, clientId}`**
  - Returns `201 {id, seq, at}` on success.
  - Errors are 400 (bad text), 403 (players may not message each other right now), 404 (no such person), 409 (to yourself) and 429 (too fast).
- **`POST /api/typing {to, typing}`** returns `204`.
  - Send `typing: true` on the first keystroke, then again every 3 s while the person keeps typing.
  - Send `false` on send, on blur, on an empty box and when the card closes.

### Frames (`TableChange`)

- **`messages?: ChatMessage[]`** carries this socket's person's messages that it has not yet sent on this socket.
  - On a socket's first frame, it carries the last 50 of each of the person's conversations, so a reconnect or a second device catches up.
- **`typing?: string[]`**: the keys of the people typing to this socket's person right now.
  - It is sent only when that list changes for this person, and never to anyone else.
- The live loop gets one more `select!` arm, on the hub's sequence, and keeps a per-socket cursor as it does for the roster.

### Hosting window

- **Commands:**
  - `table_send_message(to, text, clientId)`;
  - `table_set_typing(to, typing)`;
  - `table_message_rules(playersMayMessage)`, for the host panel switch.
- **Events:** `table://messages` and `table://typing`, already filtered for `host`, like `table://roster`.

## The card (client)

### Behaviour

- **Opening and closing.**
  - A tap or click on a person's bubble opens their card. Hovering still shows the name tip.
  - Pressing the same bubble again, pressing Escape, or pressing outside the card closes it, and focus returns to the bubble.
  - Another bubble moves the card to that person.
  - Dragging the group closes the card.
- **Accessibility.**
  - The card is a non-modal `role="dialog"` labelled by the person's name.
  - Opening it moves focus to the message box, or to the card itself when there is no message section.
  - Tab order runs from the bubble to the card.
- **Where it opens.** It opens away from the docked edge, as the tips do, and is clamped inside the area by a pure placement function next to `dock.js` (`placeCard(area, bubbleRect, side, size)`).
  - On narrow screens it becomes a sheet along the opposite edge.
  - On phones it follows `visualViewport`, so the on-screen keyboard never covers the message box.
- **Your own card.** Your own bubble opens a card with your status and nothing to message. Later sections can add things there, such as "set away" or "change name".
- **Unread messages.** A message arriving while its card is closed:
  - plays `messaged` on the sender's bubble, on the recipient's device only, until the card is opened;
  - shows an unread count;
  - buzzes once, through the existing activity haptic.
- **Typing.** While someone is typing to you, their bubble plays `messaging`, and their card shows three animated dots under the conversation.
- **Offline.** While the table is offline, the message box is disabled and says why. Messages already sent stay in the conversation.

### Extending it: the section registry

This follows the pattern of `statuses.js` and `activities.js`. A section is data plus three functions.

```js
defineCardSection("message", {
  order: 100, // where it sits, top to bottom
  when: (entry, ctx) => !entry.self && ctx.canMessage(entry), // shown for this person?
  mount: (root, entry, api) => handle, // build once; api: send, setTyping, onChange, motion
  update: (handle, entry, ctx) => {}, // roster or state changed
  unmount: (handle) => {},
});
```

- The header (face, name, role, status line with "away for") is a built-in section at order 0, so it can be replaced too.
- `ctx` carries `you`, `offline`, `isGm`, the conversation state and the clock offset.
- Header buttons use a second, smaller registry, `defineCardAction(id, { label, icon, when, run })`, for later GM tools such as "Show to", "Make GM" and "Remove".
- The card does no networking. It dispatches events from the element, and the page wires them to its transport:
  - `table-presence:send {to, text, clientId}`;
  - `table-presence:typing {to, typing}`.
- Inbound, the page calls:
  - `el.receiveMessages(list)`;
  - `el.typing = keys`;
  - `el.messageRules = {...}`.
- The same element therefore works in React, on the phone page and in the browser GM page.

### Modules

The modules stay flat in `src/lib/presence/`, so the host's `/presence/{file}` route and the `every_presence_module_is_served` guard keep working as they are. Each one needs an entry in `PRESENCE_MODULES`.

| File               | Job                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `card.js`          | The card shell: open, close, move, focus, placement, section life cycle                                             |
| `card-sections.js` | The section and action registries; the built-in header section                                                      |
| `messages.js`      | The message section: conversation list, message box, typing dots, unread                                            |
| `conversation.js`  | Pure state: merge frames, dedupe by `id`/`clientId`, order by `seq`, unread per person, pending sends (unit-tested) |
| `card-motion.js`   | Card motion built from `motion.js` primitives and the same tuning style                                             |
| `placement.js`     | Pure card placement (unit-tested), or a function added to `dock.js`                                                 |

`element.js` keeps composing. It gains the card, forwards taps and closes the card on drag. `bubble.js` gains an unread count badge.

## Motion

The card follows the existing rules:

- it animates only `transform` and `opacity`, through the Web Animations API, so the phone page's CSP accepts it;
- all tuning sits in frozen objects in one place;
- keyframe builders are pure and tested;
- everything is skipped for reduced motion, while states still change;
- motion is measured from the layout, not from mid-animation positions, except where a move continues from where it is, as the shuffle does.

| Moment                         | Motion                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card opens                     | It grows out of the bubble: it starts at the bubble's rect, scaled down with its origin on the bubble, then springs to size (as `emerge`). The sections follow with a short stagger (fade and rise). |
| Card closes                    | It folds back into the bubble (as `vanish` into a target).                                                                                                                                           |
| Card moves to another person   | It glides to the new bubble (FLIP, as `slide`), and the content crossfades.                                                                                                                          |
| Group shuffles to another edge | The card closes first (folding into its bubble), so it never races the shuffle.                                                                                                                      |
| You send a message             | It lifts from the message box into the conversation (FLIP), and older messages slide up. A small envelope travels from your bubble to theirs, along an arc built like `tripFrames`.                  |
| A message arrives              | It emerges at the end of the conversation, and the rest slide. With the card closed, an envelope travels from the sender's bubble to yours (the `you` bubble), and then `messaged` plays.            |
| Typing starts or stops         | The dots emerge or vanish. While shown, they bounce on a staggered loop.                                                                                                                             |
| Unread count changes           | The badge pops, using the existing `tp-pop` curve.                                                                                                                                                   |

## Delivery steps

1. **The card shell with no messaging.** Registries, the header section, placement, focus and keyboard, and open, close and move motion. Tapping now opens the card instead of the name tip.
2. **The host's message hub.** HTTP routes, frame fields, the hosting window's commands and events, and the GM's switch. Rust tests for:
   - routing, including that a third party receives nothing;
   - typing reaching only the recipient, and expiring;
   - rate and length limits, and an unknown or self recipient;
   - a guest who re-joins under a freed name not seeing the old conversations;
   - a paired player's second device getting the messages;
   - catching up on reconnect.
3. **Client plumbing.** Types, the table store, the Rust client, `web-table.ts` and `player.html`; the conversation state; `PresenceBar` wiring events to `table.sendMessage` and `table.setTyping`.
4. **The message section, unread state and the message motion.**
5. **Docs** (`docs/playing-at-the-table.md`), then a browser pass on the mock host (two phones and the GM, including offline) and a pass on a real Android phone.

Steps 1 and 2 are independent and could land as separate PRs. Steps 3 to 5 depend on both.

## Edge cases

- **A recipient leaves in the middle of a conversation.** Their card closes, the conversation stays in memory until the table stops, and a message to someone gone gets a 404 that the message box shows.
- **A guest is paired.** Their key changes from `guest:` to `player:`. The hub re-keys their conversations at pairing time (`Host::bind_device`), so nothing is lost.
- **The GM's switch goes off while a player-to-player card is open.** The message box disables with a note. Messages already sent stay.
- **Two of your devices are open.** Typing from one does not show on the other, because typing is about the other person only.
- **Clock skew.** Times show through `serverTime`, as "away for" does.
- **Long names and long messages.** Names only ever go in as text. Messages wrap, and the conversation scrolls inside the card, which has a maximum height.

## Out of scope (later sections)

- Messages to everyone, or to a group.
- Saving a conversation to a journal entry.
- GM actions in the card header (show to, make GM, remove).
- Read receipts.
- Two-way socket frames in place of the typing POSTs.
