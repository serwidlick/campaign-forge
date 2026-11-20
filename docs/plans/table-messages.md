# Table messages: the person card

Status: implemented on `feat/table-messages`; the notes at the end say where the build differs from the plan. It builds on the presence bubbles (`docs/plans/table-roster.md`, `src/lib/presence/`). Messages are live chat for the session only: they are carried over the WebSocket and kept in the host's memory. Codex has reviewed three drafts; the history is at the end.

Pressing someone's bubble opens a card next to it. The card shows who they are and how they are, and holds a conversation with them. Players can message each other, and the GM can message any player.

- **Typing:** while someone writes to you, their bubble and your card with them show that they are typing. Nobody else is told: not the GM's screen, not the other players, and not the writer's other devices.
- **Seen receipts:** once the person you wrote to has read your message, it is marked **Seen**.

The card is a frame for sections. Messaging is the first; later features (GM actions, dice, handouts) add sections without touching the card.

## Scope: chat for the session, nothing kept

- **Conversations live in the host's memory while both people are at the table.** A conversation ends, everywhere at once, when either person leaves the roster. "Leaving" means their last seat's disconnected grace runs out, or their only seat is paired as someone else. Everything ends when hosting stops. Nothing is written to disk.
- **Brief drops keep the conversation.** A phone that locks or changes Wi-Fi and comes back within the grace finds its conversations, seen marks and unread counts as they were.
- **A person on two devices stays present while either device is.** Re-pairing one of them as someone else does not end the first person's chats.
- **History is limited.** Each conversation keeps its last 100 messages. Older ones are simply gone, which is fine for session chat. Nothing is paged back.

## Everything over the WebSocket

The live socket (`table.ws.v1`) becomes two-way. Today it is one-way after the JSON hello, and any other incoming message ends it.

- **Device to host:** the device sends small JSON commands. Each socket's commands are handled in order. A frame that does not parse as a command, or is over 8 KiB, still ends the socket. 8 KiB fits a maximum message after JSON escaping, and that is tested.
- **Host to device:** answers and deliveries ride `TableChange` frames.
- **No HTTP routes are added.**

### Identity on every command

Each seat gets an **identity epoch**, a number the host bumps whenever the seat's person changes (pairing or re-pairing), under the seats lock. The epoch goes out with `you` in frames.

- Every command carries the `epoch` the device last applied.
- The host compares it with the seat's current epoch under the seats lock and rejects a stale command with `error: "identity changed"`.
- A device that was A cannot post as B, even with commands already in flight when it was re-paired.

### Device to host

| Command                                                                       | Meaning                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `{"t":"send","epoch":n,"to":"<key>","cid":"<id>?","clientId":"…","text":"…"}` | Send a message. `cid` is the conversation's id, if one exists yet |
| `{"t":"typing","epoch":n,"to":"<key>","on":true\|false}`                      | Start or refresh typing to someone, or stop                       |
| `{"t":"seen","epoch":n,"cid":"<id>","seq":n}`                                 | I have read this conversation up to `seq`                         |

### Host to device (`TableChange` fields)

These go only to the sockets of the people involved. Any other socket gets nothing at all, not even an empty frame.

- **`chats`** is either a snapshot or updates.
  - **Snapshot**: `{ snapshot: true, epoch, conversations: [...] }`. It is sent as the first frame on every socket, after every identity change, and after a resync (see Flow control).
    - It is the device's entire set of conversations. Anything the device holds that is not in it has ended, including when the set is empty.
    - Each conversation is `{ cid, with, messages, seenByMe, seenByThem }`.
  - **Updates**: `{ cid, with, messages?, seenByMe?, seenByThem?, ended? }`, with new messages and changed seen marks only.
  - **Message:** `{ id, seq, from, text, at }`, with `seq` counted within the conversation. On the sender's own sockets only, it also carries `clientId`, so a pending send can be matched wherever the message turns up.
- **`acks: { clientId, id?, cid?, seq?, error?, retryAfter? }[]`**: the reply to each `send`, on the sending socket only.
- **`typing: string[]`**: who is typing to this person now. It is in the first frame (often `[]`), and sent again on change.
- **`messageRules: { playersMayMessage }`**: in the first frame, and sent again on change.

`cid` is a fresh UUID each time a conversation starts. A conversation that ended and later starts again, between the same two people, is a different conversation. Commands naming an ended `cid` are refused with `error: "conversation ended"`, which is how late resends from a previous meeting are stopped.

### Seen receipts

- **When a device reports seen.** A device sends `seen` for a conversation when:
  - its card is open;
  - the page is visible (`document.visibilityState`);
  - and the newest messages from the other person are actually in view.

  The host keeps one `seenUpTo` per person per conversation, which only moves forward. A smaller `seq` is ignored, and anything beyond the latest seq is clamped. Reports are free when nothing changes and are limited to one a second per socket.

- **Who is told.**
  - The other person gets `seenByThem`. Their card marks the newest of their messages at or below it with "Seen", which moves forward as they read on.
  - The reader's own other devices get `seenByMe`, so unread counts agree across a person's devices. A message read on a phone stops being unread on the laptop.
- **Unread counts come from receipts.** Unread is "messages from them with `seq > seenByMe`", so snapshots carry it. A reconnect, an overflow resync or a page reload shows the right counts without replaying any notification.
- **The same matrix applies.** A receipt is only accepted where the two may message.
- **No opt-out yet.** Turning receipts off is a later setting, listed under Out of scope.

### Sending, resending and de-duplication

- **The page:**
  - adds a pending item;
  - sends `typing off` and then `send` on the same socket, so a late typing start cannot outlive the message;
  - waits for the ack.
- **Matching a pending send.** It is matched by `clientId` from whichever comes first: the ack, the message's echo in `chats`, or the message inside a snapshot. Whatever arrives later merges into the same message and never adds a second copy. Seq tracking and ack handling are separate.
- **Resends.**
  - Unacknowledged sends are resent on the next socket, after its first snapshot has been applied, with the same `clientId`, the snapshot's `epoch` and their `cid`.
  - A pending send whose conversation is missing from the snapshot (ended) or whose epoch changed is dropped. It is shown as "not sent", never resent as someone else or into a new conversation.
  - Resending stops after 2 minutes, and the item then shows "may not have been sent".
- **De-duplication on the host.**
  - The host remembers each person's `clientId`s for 3 minutes, as `{ clientId, text hash, ack }`.
  - At the send rate limit of 5 sends per 5 s per person, that is at most 180 records, so the store holds 192 per person and never evicts a record inside its window.
  - A repeat with the same text gets the original ack. The same `clientId` with different text gets `error: "conflict"`.

### Host state: `src-tauri/src/table/server/messages.rs` (new)

**Locks and the present set.**

- **The `MessageHub` keeps the present set:** the person keys on the roster as last published, plus every conversation.
- **One order for every path:** first the seats lock, then the hub lock. The hub never calls back into seats.
  - A command takes the seats lock, checks the epoch, reads the seat's person key, takes the hub lock, applies the command, and releases both.
  - The roster task takes its seats snapshot, builds the roster, and then, under the hub lock and in the same step, replaces the present set, ends the conversations of anyone no longer present, and drops their typing leases.
  - The roster frame and the `ended` updates are published from that one step, so no command can slip in between a person's departure and their conversations ending.
  - A send to or from someone not in the present set gets `error: "not at the table"`. A device just connected, whose person the roster has not yet published, gets `error: "not ready"`, and its client retries after a second.
- **Who may message whom:**

  | Sender                           | To the host | To a GM-role player | To a player or guest                              |
  | -------------------------------- | ----------- | ------------------- | ------------------------------------------------- |
  | Host (local window only)         | n/a         | yes                 | yes                                               |
  | GM-role player (incl. remote GM) | yes         | yes                 | yes                                               |
  | Player or guest                  | yes         | yes                 | only while "Players can message each other" is on |

  Typing and seen receipts follow the same matrix. The switch is one setting in the host panel, on by default. Turning it off ends nothing: composers disable and the pair's typing leases end.

- **Limits.** These bound memory whatever devices send, and whatever the roster's size.
  - Text is trimmed and stored trimmed: 1 to 500 Unicode scalar values and at most 2,000 bytes, with no control characters except newline and tab.
  - `clientId` is 1 to 64 characters of `[A-Za-z0-9_-]`. `to` is at most 128 bytes and must be in the present set, or `host`, and not the sender.
  - Each conversation keeps its last 100 messages. Across the whole hub there are at most 2,000 messages and 1 MiB of text; when full, the oldest message anywhere goes first.
  - Sending is limited to 5 per 5 s per person key, shared across their seats and sockets.
  - A snapshot frame is at most 256 KiB serialized. If a person's conversations would exceed it, each conversation keeps its newest messages that fit, oldest dropped first, and is marked `trimmed: true`. Seen marks and unread counts still come out right, because they are seqs, not messages.

### Typing

- **One lease per socket at most:** `(socket, to)`, because a card is open to one person at a time.
  - `on: true` starts or refreshes it, at most once a second; anything faster is ignored.
  - `on: false` ends it, and costs nothing when there is no lease.
- **A lease also ends** when its socket closes, after 6 s without a refresh, when the matrix stops allowing the pair, or when either person leaves.
- **Per person:** someone is typing to `to` while any of their sockets holds a live lease, so one device's blur does not hide another's typing.
- **Expiry:** the hub schedules a wake for the next lease to expire, as the roster does for disconnected entries.

### Flow control: the browser's 16-frame queue

The live loop may send a frame on every wake, so bursts cannot be relied on to coalesce. Two things handle it:

- **Bigger budget.** `table-live.js` raises its queue to 64 frames or 2 MiB, whichever comes first. The host's per-person send limits make that out of reach in normal play.
- **Overflow recovery.** If a consumer still falls that far behind, the transport closes and reconnects as it does today, and the new socket's snapshot is authoritative.
  - Messages, seen marks and unread counts come back exactly.
  - Pending sends are reconciled by `clientId`, from the snapshot, before anything is resent.
  - What is lost is only the live effects for messages that arrived during the gap: the buzz, the envelope and the announcement. Their unread badges still show.
  - Tests:
    - spaced wakes with a stalled consumer;
    - several senders at once;
    - typing churn;
    - an overflow resync with pending sends in flight.

### The Rust client (desktop and Android apps)

- **Today.** `next_event()` holds the socket inside `self.live`'s mutex while it waits for the next frame, so nothing else could send on it.
- **The change.** One connection task owns the socket. It splits the socket into read and write halves, and owns reconnecting and shutdown.
  - Incoming frames go to an inbound channel that `next_event()` reads.
  - Commands go in through an outbound channel, so `send()` never waits on a read.
  - Frames that were sent but not yet acknowledged are kept by the task and resent after the next connection's first snapshot, by the rules above.
- **Test.** Send and type while `next_event()` is already waiting and nothing else is happening at the table.

### The hosting window

It has no socket. It uses commands and events, which only the hosting window can call; they are never added to `/api/gm/call`.

- **Commands:**
  - `table_send_message(to, cid?, text, clientId)` returns the ack;
  - `table_set_typing(to, on)` is one lease with the same expiry;
  - `table_mark_seen(cid, seq)`;
  - `table_message_rules(playersMayMessage)`;
  - `table_chats()` returns the snapshot, typing list and rules, so a reloaded window rebuilds its state.
- **Events:** `table://chats` and `table://typing`, carrying only what concerns `host`.
- **A remote GM** messages through their own seat, as `player:<id>`.

### Trust model

The promise is filtering between people at a table whose host and GMs are trusted. It is not secrecy from them.

- **The host sees everything in transit.** The hosting machine routes every message, so it holds them in memory.
- **Pairing grants access.** A GM can pair any device as any player, and that device then gets that player's live conversations.
- **Plain LAN hosting is unencrypted** unless TLS is configured. Anyone on the network can read messages there. The player docs will say so beside messaging.
- **What is promised:**
  - no screen shows the GM conversations they are not in;
  - no device is sent anything about a conversation it is not in.

## Clients

All three use the same frames: the Rust client, `web-table.ts` (the browser GM page) and `player.html` (the phone page). `table-live.js` gains `send(command)`, with the same resend rules as the Rust task.

**Conversation state.** `conversation.js` is pure and unit-tested. Per conversation it keeps:

- `cid`;
- `messages`;
- `seenByMe` and `seenByThem`;
- `pending` sends, by `clientId`;
- an unread count derived from `seenByMe`.

**Snapshots and updates.**

- **A snapshot** replaces the whole set. It never buzzes, animates or announces.
- **A live update** with a message from the other person, while their card is closed:
  - shows the unread badge on their bubble;
  - plays the envelope trip from their bubble to yours;
  - calls `haptic("notice")`, once per frame;
  - announces the message in the live region.
- **`ended`** removes the conversation. An open card says the person has left and folds away.
- **A changed `epoch`** clears everything, marks pending sends "not sent", and waits for the snapshot that comes with it.

## The card

### Behaviour

- **Opening and closing.**
  - A tap, click, Enter or Space on a person's bubble opens their card. Hovering still shows the name tip.
  - The card has a close button. Pressing the same bubble again, the close button or Escape closes the card and returns focus to the bubble. If that bubble has left or folded away, focus goes to the eye.
  - A press outside the card closes it but leaves focus where the press put it.
  - Another bubble moves the card to that person.
  - Picking the group up to drag it closes the card.
- **Focus and keys.**
  - The card is a non-modal `role="dialog"`. The shell owns its accessible name. The bubble gets `aria-expanded` and `aria-controls`.
  - Opening focuses the message box when composing is allowed, else the close button. Tab moves through the card. Shift+Tab from the first control returns to the bubble. Tab past the last control goes on to the next bubble.
  - The card is a sibling layer of `.group`, so arrow-key docking never sees keys typed in it. The message box also stops propagation of keydown.
- **Announcements.**
  - A polite live region announces new messages from the other person, send failures, and "Bo is typing", once when it starts.
  - "Seen" is part of each message's accessible description, not announced.
- **Placement.**
  - It opens away from the docked edge, clamped by a pure `placeCard(area, bubbleRect, side, size)`.
  - On narrow screens it becomes a sheet along the opposite edge.
  - It follows `visualViewport`, so the keyboard never covers the message box.
- **Message status.** Your messages show their state under the newest one: "Sending…", then "Sent", then "Seen" once the other person has read up to it. A failed send shows "Not sent" with Retry.
- **Your own card** shows your status and nothing to message.
- **When composing is not allowed** (offline, the GM's switch, or the other person disconnected), the conversation stays and the message box is disabled with the reason.
- **Bubble effects.** Typing (`messaging`) wins over unread (`unread`).

### Extending it: sections and actions

A section is data plus life-cycle functions, as statuses and activities are:

```js
defineCardSection("message", {
  order: 100,
  when: (entry, ctx) => !entry.self, // re-evaluated on every render
  mount: (root, entry, api) => handle, // once per (section, person)
  update: (handle, entry, ctx) => {}, // same person, new state
  unmount: (handle) => {}, // api.signal aborts, api.on listeners are disposed
});
```

- **Instances are keyed by section id and person key.** Moving the card to another person unmounts and mounts afresh.
- **`api` is generic:**
  - `emit(name, detail)` dispatches `table-presence:<name>`;
  - `on(name, fn)` listens for page responses;
  - `state(sectionId)` reads page-provided state;
  - `motion`, `signal` and `announce(text)`.

  Messaging has no special access.

- **Page to card:** `el.setSectionState(id, value)` and `el.respond(name, detail)` (for messaging, the acks).
- **Header buttons** use `defineCardAction(id, { label, icon, when, run })`.
- **The card does no networking.** The page wires its events to the socket.

### Modules

The modules stay flat in `src/lib/presence/`, so the `/presence/{file}` route and the `every_presence_module_is_served` guard keep working.

| File               | Job                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `card.js`          | The card shell: open, close, move, focus, placement, naming, live region, section life cycle  |
| `card-sections.js` | The section and action registries; the built-in header section                                |
| `messages.js`      | The message section: conversation, message box, typing dots, status line, retry, seen reports |
| `conversation.js`  | Pure state: snapshots, updates, ended, seen, unread, pending and acks (unit-tested)           |
| `card-motion.js`   | Card motion from `motion.js` primitives, with its cancellation rules                          |
| `placement.js`     | Pure card placement (unit-tested)                                                             |

## Motion

- **Properties.** Only `transform` and `opacity` animate, through the Web Animations API. The old `messaged` box-shadow ripple becomes a ring element that scales and fades.
- **Ownership.** The card owns its animations, and a new transition cancels the one in flight.
  - The logical state changes at once: a closing card is `inert` immediately.
  - It is removed when its animation finishes, or by a timer fallback, as `vanish` does.
- **Missing targets.** If the bubble to grow from or fold into is missing, the card fades in place.
- **CSP.** Styles come only from the shadow stylesheet and CSSOM property writes. There are no `style` attributes and no `innerHTML`, and text goes in through `textContent` only.
- **Reduced motion.** Everything is skipped; the states still change.
- **Tests.** Keyframe builders are pure and unit-tested.

| Moment                       | Motion                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card opens                   | It grows out of the bubble, origin on the bubble, then springs to size (as `emerge`). Sections follow with a short fade and rise.                                    |
| Card closes                  | It folds back into the bubble (as `vanish` into a target).                                                                                                           |
| Card moves to another person | It glides to the new bubble (FLIP, as `slide`), and the content crossfades.                                                                                          |
| Group picked up              | The card folds into its bubble before the drag moves anything.                                                                                                       |
| You send a message           | It lifts from the message box into the conversation (FLIP), and older messages slide up. An envelope travels from your bubble to theirs on a `tripFrames`-style arc. |
| A live message arrives       | It emerges at the end of the conversation, and the rest slide. With the card closed, the envelope travels from the sender's bubble to yours.                         |
| Sending, Sent, Seen          | The status line crossfades between words. When "Seen" moves to a newer message, it glides there (FLIP, as `slide`) rather than jumping.                              |
| Typing starts or stops       | The dots emerge or vanish, and bounce on a staggered loop while shown.                                                                                               |
| Unread count changes         | The badge pops (the existing `tp-pop` curve).                                                                                                                        |
| Conversation ends            | The open card says so and folds away a moment later.                                                                                                                 |

## Delivery steps

1. **The card shell with no messaging.**
   - Registries, the header section, placement, naming, focus and keys, the live region, and open, close and move motion with cancellation.
   - Tapping opens the card instead of the name tip.
   - The `messaged` ripple is rewritten to `transform` and `opacity`.
2. **The host's message hub and the two-way socket.**
   - Identity epochs, command parsing and limits, the present set and lock order, conversations and `cid`s, sends with acks and de-duplication, seen receipts, typing leases, the rules switch, snapshot budgets, and the hosting window's commands and events.
   - Rust tests for:
     - nothing at all to a third party;
     - stale-epoch commands refused across a re-pairing;
     - departure ending conversations in the same step as the roster (two devices, one re-paired, keeping chats);
     - an expiry and rejoin while one device misses every `ended`;
     - late resends into an ended `cid` refused;
     - de-duplication holding through 180 sends from another socket;
     - the conflict case;
     - text limits with multibyte, emoji and escape-heavy text;
     - the shared send rate;
     - the matrix for sends, typing and seen, including the switch toggled mid-conversation;
     - typing leases across two tabs, refresh limits, free stops, expiry and socket close;
     - seen being monotonic, clamped, delivered to the other person and the reader's other devices, and driving unread in snapshots;
     - a snapshot staying within 256 KiB at the hub's maximum state.
3. **Client plumbing.**
   - The Rust client's connection task with inbound and outbound channels.
   - `send` and resends on `table-live.js`, with its larger queue budget.
   - Types, the table store, `web-table.ts` and `player.html`.
   - `conversation.js`.
   - `PresenceBar` wiring section events to the socket and acks back.
   - Tests of snapshot-before-ack, echo-before-ack and both in one frame, and of an overflow resync with sends pending.
4. **The message section:** the status line and Seen, unread badges, notifications, and the message motion.
5. **Docs and checks.**
   - Update `docs/playing-at-the-table.md`, covering session-only chat, Seen and the trust model in plain words.
   - Do a browser pass on the mock host with the real hashed CSP and every section open, failing on any CSP violation. It covers two phones and the GM, offline, a reconnect, someone leaving, a pairing, and Seen.
   - Do a pass on a real Android phone.

Steps 1 and 2 are independent and could land as separate PRs. Steps 3 to 5 depend on both.

## Out of scope

- Keeping messages after someone leaves, or across tables.
- Messages to everyone or to a group.
- A setting to turn seen receipts off.
- GM actions in the card header.
- Opaque identity for guest notes. Notes are still authorized by name, and that is unchanged.

## Review history

- **Round 1 (Codex), on the first draft.** It led to:
  - the trust model and authorization matrix;
  - bounded memory and rate limits;
  - per-conversation sequence numbers and no frames to uninvolved sockets;
  - idempotent sends with acks;
  - typing leases and the rules on the wire;
  - the focus, keyboard and live-region rules;
  - notifications driven by delivery;
  - the section life cycle, motion ownership and the CSP rules.
- **Round 2 (Codex), on the HTTP push-and-fetch draft.** Its findings on migration, catch-up, eviction gaps and queue overflow led to the scope decision: messages are session-only chat over the WebSocket.
- **Round 3 (Codex), on the first WebSocket draft:**

  | Finding                                                           | Change                                                                                              |
  | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
  | Commands ran under whatever identity the seat had by then         | Identity epochs on every command, checked under the seats lock; resends wait for the first snapshot |
  | De-duplication capacity was shorter than the retry window         | A 2-minute retry window, and 3-minute records sized above the most the send rate allows             |
  | Reconnects could keep ended conversations or replay into new ones | The snapshot replaces the whole set; per-meeting `cid`s; ended `cid`s refused                       |
  | Deleting on a seat's reassignment broke two-device people         | Deletion on person departure only, in the same locked step as the roster publication                |
  | Wake batching did not protect the 16-frame queue                  | A larger budget, plus an authoritative snapshot resync on overflow, with only live effects lost     |
  | The Rust client could not send while reading                      | A connection task with split halves and inbound and outbound channels                               |
  | Snapshot-before-ack broke optimistic sending                      | `clientId` on the sender's own copies everywhere; ack, echo and snapshot all merge into one item    |
  | Bounds relied on an uncapped roster                               | A hub-wide cap on messages and bytes, and a 256 KiB snapshot budget with trimming                   |

- **Added by request: seen receipts.** Each conversation stores two monotonic seqs. Receipts also give unread counts that survive reconnects and agree across a person's devices.

- **Round 4 (Codex), folded into the build:**
  - The roster is built and the present set replaced while the seats lock is held, so a seat that changes after a snapshot cannot have its conversations ended by a stale roster.
  - A first message (no conversation yet) waiting while its recipient leaves is marked not sent; the host's de-duplication outlives the conversation, so a resend after a lost answer returns the original answer rather than starting a new conversation.
  - A table seats at most 64 devices; when full, seats that no longer hold their name are cleared first. That bounds everything kept per person.
  - The host counts unread messages itself, including ones dropped from the log, and sends the count with every snapshot and change.

## Where the build differs

- Pending sends and resends live in one shared JavaScript controller (`src/lib/presence/chat.js`) used by the phone page, the browser GM page and the app, rather than in the Rust client. The Rust client only gained a split socket, so it can send while it waits for frames (`Session::send_live`).
- Writing a message counts as having read the conversation up to it.
- The same device rejoining under its own name sits straight down and keeps its place on the roster (`seat_guest`), rather than waiting out the name hold.
