# Table roster

**Decision, 20 November 2026.** Everyone at a table sees a row of icons for everyone else there, each with a name. This builds on the WebSocket transport in [table communication](table-communication.md) (branch `codex/secure-table`) and is the "public roster" that plan reserved.

- **Who appears.** The hosting GM, remote GM devices, paired players and guests. Everyone sees the same list.
- **Host identity.** A new optional campaign setting, `gmName`, kept in `campaign.json`. Unset, the host shows as "Game Master".
- **Icons.** A circle with the person's initials and a stable colour derived from their roster key. Emoji, avatars and portraits are later work.
- **Dropped connections.** Someone whose last socket closes stays in the roster, dimmed and labelled **away**, for a 60 second grace period. After that they disappear. Reconnecting inside the grace period puts them back with no flicker. Leaving the table works the same way: the socket closes, and the person shows as away until the grace period ends (see "Why there is no instant leave").

## Why the existing data is not enough

- "Connected" in the host panel means `last_seen` was refreshed in the last minute (heartbeat pongs and HTTP requests). Nothing records when a socket closes.
- Every join mints a new seat in `ServerState.players`. Seats are removed only when `authorize` finds a paired device no longer in the registry. A native rejoin or a second phone tab leaves the earlier seat behind. A phone reload reuses its seat (token in `sessionStorage`), and browser-GM tabs share one seat (token in `localStorage`).
- Nothing caps how many sockets a seat can open: the limit of 8 applies to tickets issued but not yet used. Presence therefore has to count sockets per seat, not flag them.
- `live()` wakes on the storage version, the spotlight, closing and the socket. Routing roster changes through the storage version would rerun `share::shared_versions`, which hashes every visible summary, for every viewer on each join or leave.
- `Player` is keyed by the bearer token and carries the management `connection_id`, device fingerprints and labels. None of those may reach players.
- Guest names are not length-limited at join. Today only the GM sees them; the roster would broadcast them to everyone.
- **A guest's name is an authorization identity.** `share::is_author` grants a guest their notes by matching `author` against the name they joined with (`share.rs:80`). Whoever holds a name holds those notes, so anything that frees a name early, or lets two seats hold one name, is an access-control change, not a cosmetic one.

## Prior art and the practices this follows

- **Presence keyed by person, with one entry per connection** (the [Phoenix Presence](https://hexdocs.pm/phoenix/Phoenix.Presence.html) model: a key maps to a list of per-connection metas). Here the key is the person, and the per-connection detail collapses to a socket count per seat plus the time the last one closed. Phoenix sends join/leave diffs because it replicates across a cluster. A single host with under ten people does not need that: send the whole roster and let clients replace their copy. Replacement is idempotent and cannot drift, and frames on one socket arrive in order.
- **One publisher, latest-value fan-out with `tokio::sync::watch`.** Only the roster task writes the roster. Readers only ever need the newest value, so lag cannot lose anything that matters. Publish with `send_if_modified`, which notifies receivers only when the closure returns true. Read with `borrow_and_update` inside the loop that awaits `changed()`, cloning out before any `.await` ([tokio watch docs](https://docs.rs/tokio/latest/tokio/sync/watch/struct.Sender.html#method.send_if_modified)).
- **Single writer per socket, bounded sends.** `live()` already owns its socket in one task with a 5 second send deadline, and closes a reader that cannot keep up. Roster frames go through the same writer. No new queue, no extra task per socket.
- **RAII for connection accounting.** A guard increments on creation and decrements in `Drop`, so every exit path (error, timeout, shutdown, unwind) is counted. `Drop` does one short critical section and one `Notify::notify_one`. A std `Mutex` lock can still block briefly under contention, which is fine for a few-microsecond section. A poisoned lock is recovered with `PoisonError::into_inner` rather than skipped, so a decrement is never lost.
- **Lock discipline.** Presence lives on the seat record, so one mutex (`players`) is the single synchronization boundary for admission, stale-seat removal, socket registration and release. The roster task never holds `players` and the campaign state at once: it copies the seats out, releases the lock, then reads the registry. No guard is held across an `.await`.
- **Grace period before "gone".** Mobile browsers drop sockets when backgrounded or locked. Show **away** first and remove later, so a reconnect causes no visible churn.
- **Public projection in one place.** The roster is built in `table/share.rs`, the module CLAUDE.md names as the sole decider of what players receive. A test asserts the exact serialized keys, so an added field cannot leak silently.
- **Untrusted names.** Names are rendered as text only: React escapes, and the phone page uses `textContent`, never `innerHTML`. Join-time name rules are unchanged, because a guest's name is their note identity (below). The roster projection cleans and truncates every name it sends, guest or paired.
- **Accessible avatar group** (following the [Dynatrace](https://developer.dynatrace.com/design/components/content/AvatarGroup/a11y/) and [SAP Fiori](https://www.sap.com/design-system/fiori-design-web/v1-136/ui-elements/avatar-group/usage) avatar group guidance):
  - The group is a labelled list ("At the table, 4 people").
  - Each avatar's accessible name is the full name plus state ("Mira, away").
  - The `+N` bubble is a toggle button ("Show 3 more people", `aria-expanded`) that expands the rest in place as more bubbles; Escape on a focused bubble folds them again. Focus stays on the same bubble across roster updates.
  - Away is shown by reduced opacity **and** an icon plus label, never colour alone (WCAG 1.4.1).
  - Initials meet 4.5:1 contrast against their circle, checked by a test over the palette.
- **Grapheme-safe initials.** Use `Intl.Segmenter` (graphemes) so accented letters and emoji are not split. Fall back to `Array.from` where `Segmenter` is missing.

## Design

### Host: presence and the roster task

1. **Presence counts on the seat.** Add private fields to `Player`, all `#[serde(skip)]`: `sockets: u32`, `first_connected: Option<Instant>` and `last_closed: Option<Instant>`. They live under the same `players` mutex as the seat, so removing a seat removes its presence with it, and there is no second map to keep in step.
   - `live()` calls `PresenceGuard::register(&players, &token, &hub)` right after consuming the ticket.
   - Under the `players` lock, `register` checks the seat still exists. If it does not, `register` returns `None` and `live()` ends without sending anything: the seat was removed between ticket and socket, for example by a stale-name replacement or an unpair. Otherwise it increments `sockets` and sets `first_connected` if unset.
   - After releasing the lock, `register` calls `notify_one`.
   - `Drop` takes the lock, recovering a poisoned one. If the seat still exists, it decrements `sockets` and sets `last_closed` when the count reaches zero. It then releases the lock and calls `notify_one`.
   - A unit test removes the seat between ticket consumption and `register`, and asserts that no presence is created and the socket closes.
2. **Detection latency.** A clean close (tab closed, Leave, app quit) is seen at once. A half-open socket (a phone walks out of Wi-Fi range) is noticed by the heartbeat check: `live()` ticks every 15 seconds and gives up once the last pong is more than 45 seconds old, so detection can take up to about 60 seconds. The person then shows as away for 60 more. Shortening the pong timeout is a separate tuning decision with battery and flaky-Wi-Fi costs.
3. **One roster task per hosted table, the only publisher.** A `RosterHub { tx: watch::Sender<Vec<RosterEntry>>, wake: Notify, grace: Duration }` lives in `ServerState` and in `Running`/`Host` (so the GM-side commands can wake it). The task is spawned in `server::start` and exits when `closing` flips. It wakes on four things:
   - `wake` (presence changes, pairing, guest replacement);
   - storage changes (`AppState::changes()`), because the registry, player names, GM flags and `gmName` all live in `campaign.json`;
   - a `sleep_until` for the next away entry's expiry;
   - `closing`.

   Each wake copies the seats (with their presence fields) out of `players`, releases the lock, reads the campaign registry, builds the roster, and publishes it with `send_if_modified(|current| if *current != next { *current = next; true } else { false })`. It then emits `table://roster` to the local GM window from that same publication. Because one task does every snapshot and publication in sequence, an older snapshot can never overwrite a newer one.

   A client's first frame carries whatever roster is current. If the client's own entry is not in it yet, a roster-only frame follows within milliseconds, once the task has run. Tests wait for convergence rather than assuming the first frame.

4. **Pairing wakes the roster after the seat changes.** `Host::bind_device` saves the registry (a storage bump) and only then updates the seat's `player_id`, name and role. The task may run between the two and still see a guest. `bind_device` therefore calls `hub.wake.notify_one()` after the seat update. A regression test covers guest-to-player pairing and moving a device between players.
5. **Building the roster** is a pure function, `build_roster(seats, registry, gm_name, grace, now) -> (Vec<RosterEntry>, Option<Instant>)`. The second value is the next expiry, for the task's timer. It is unit tested without sockets:
   - The host entry comes first: key `host`, name from `gmName` or "Game Master", role `host`, always `here`.
   - Only seats that have opened at least one socket count. They are grouped by person:
     - Paired seats use the key `player:<player id>`; player ids already reach players in `TableInfo.players`.
     - Guest seats use the key `guest:<roster key>`, a fresh UUID minted with the seat and kept on `Player` with `#[serde(skip)]`. It is not the token and not the `connection_id`.
   - Paired seats whose registry record is gone, or no longer lists the seat's device fingerprint, are skipped. An away seat never calls `authorize` again, so without this check an unpaired device would linger as away.
   - A person is `here` if any of their seats has an open socket, and `away` if their latest close is within the grace period. Otherwise they are left out.
   - The role is `gm` when the paired record has `gm: true`, `player` when paired, and `guest` otherwise. Names for paired players come from the registry, as `authorize` already does.
   - Every name is cleaned for display only: control characters removed, whitespace runs collapsed, truncated to 40 Unicode scalar values with "…", and "Player" if nothing is left. The seat's stored name, which authorizes notes, is never changed.
   - Order: host first, then by each person's earliest `first_connected`, so icons do not reshuffle as people come and go.
6. **Public shape** in `table/share.rs`:

   ```rust
   #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
   #[serde(rename_all = "camelCase")]
   pub struct RosterEntry { pub key: String, pub name: String, pub role: RosterRole, pub state: RosterState }

   #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
   #[serde(rename_all = "lowercase")]
   pub enum RosterRole { Host, Gm, Player, Guest }

   #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
   #[serde(rename_all = "lowercase")]
   pub enum RosterState { Here, Away }
   ```

   There are no tokens, connection ids, fingerprints, labels or timestamps. A test asserts the exact serialized keys.

7. **Guest names: unchanged identity, atomic and single-holder.**
   - **Identity unchanged.** Admission keeps today's rules exactly: the name is trimmed, must be non-empty, and is compared ignoring ASCII case, matching `share::is_author`. No new normalisation or length limit is applied to the stored name, so a guest can always reclaim notes written under the name they used before. Cleaning happens only in the roster projection (point 5).
   - **Atomic admission.** `name_taken`, the stale-seat removal and the seat insertion happen under one acquisition of the `players` lock. Today the check and the insert are separate (`server.rs:893` and `:909`), so two simultaneous joins can both pass.
   - **A name is held while any seat for it is protected.** A seat is protected if any of these holds:
     - its `last_seen` is within 60 seconds, today's rule unchanged, which covers pending seats and guests still saving over HTTP after their socket closed;
     - it has an open socket (`sockets > 0`);
     - its `last_closed` is within the grace period.

     All three are read from the seat under the same lock. The reservation therefore never ends before the roster entry does, and never earlier than today.

   - **One live holder per guest name.** When a guest is admitted under a name, older guest seats (no `player_id`) with the same name are removed in the same critical section. Only seats with no protection left are removed; a protected one would have caused the join to be refused. Their tokens then get `401` and return to join, and any ticket already issued to them fails `register` (point 1). A stale seat therefore cannot reconnect beside the new holder. The roster task is woken.

   This is the existing name-is-identity rule, made consistent. It does not change who may claim a name, or when.

### Why there is no instant leave

An explicit `DELETE /api/session` was considered and cut. Removing a guest's seat at once would free their name at once, and because notes are authorized by name, another guest could take it and read or edit their private notes. It would also have to:

- drain the phone's pending sheet and note saves before revoking the token;
- cope with browser-GM tabs that share one seat through `localStorage`;
- leave a person in place while another of their seats is still connected.

Instant leave belongs with a later change that gives guests an opaque identity for note authorship. Until then, Leave closes the socket and the person shows as away for the grace period, like any other drop.

### Wire

- `TableChange` gains `roster: Option<Vec<RosterEntry>>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- `live()` holds a roster `watch::Receiver`. It includes the current roster in every frame that is a reset for that socket (its first frame, and after an identity change). It adds `roster.changed()` to its `select!` and sends a frame whenever the roster changes.
- A roster-only frame is still a complete `TableChange`. It carries the current `version`, `gm`, `playerId`, `spotlight` and `spotlightSeq`, because `table-store.ts` clears the spotlight when `spotlight` is absent and the phone compares `spotlightSeq`.
- It carries no `delta`, and for GM sockets `changes: None`, because even an empty `DiskChanges` would run `notifyFilesChanged` handlers.
- It does not advance `previous_version` or the player view, so the "rebuild if storage moved" race check is unaffected.
- **Clients replace their roster whenever a frame carries one, and keep it otherwise.** Frames on a socket are ordered and every new socket's first frame carries the roster, so there is no sequence number to compare. Detaching clears it.
- This stays `table.ws.v1`. PR #10 is unreleased, the field is optional, `client.rs` deserializes `TableChange` without `deny_unknown_fields`, and `table-live.js` validates only `version` and `gm`.
- No client-to-host messages are needed.

### Local GM (host panel)

- `HostStatus` gains `roster` for the first paint, and the host panel listens for `table://roster` to update without waiting for its 3 second poll.
- `Player` in `HostStatus` gains `online: bool` (`sockets > 0`). The host panel's dot and "connected" label use it instead of `isRecent(lastSeen)`. `lastSeen` stays for "last seen 3 min ago".
- A "Your name at the table" field in the host panel saves `gmName` through `updateCampaignSettings` on blur or Enter, trimmed and capped at 40 characters. The roster task picks it up on the storage bump.

### Clients

- **Shared helpers in `src/lib/table-live.js`**, already served to the phone at `/table-live.js` and imported by React, typed in `table-live.d.ts`:
  - `rosterInitials(name)`: up to two graphemes, from the first and last words.
  - `rosterColour(key)`: a 32-bit FNV-1a hash of the key into a fixed palette of 8 background colours with white text. Each meets 4.5:1, checked in a test, so every client draws the same person in the same colour.
- **`src/lib/types.ts`.** Add `RosterEntry`, `TableChange.roster`, `HostStatus.roster` and `Player.online`.
- **`src/stores/table-store.ts`.** Add `roster: RosterEntry[]`. `runSyncLoop` replaces it when a frame carries `roster`, and detach clears it. The same store serves the native player, Android, the native remote GM and the browser GM (through `web-table.ts`).
- **One self-contained component for every client: `<table-presence>`** (`src/lib/table-presence.js`, `table-presence.css`, typed in `table-presence.d.ts`). Revised 20 November 2026, after review with the user: the roster is a set of separate bubbles docked to an edge of the screen, over every page, with no panel or box.
  - A framework-free custom element with its own shadow DOM and stylesheet. The page sets `.roster` and nothing else; the element does its own rendering, dragging, snapping and storage. Nothing leaks in or out except the theme's colour variables, which custom properties inherit through the shadow boundary.
  - It is a full-window, click-through layer (`position: fixed; inset: 0; pointer-events: none`); only the bubbles take the pointer, so screens change and scroll underneath. Its padding (`!important`, so a page reset cannot zero it) keeps the bubbles clear of the edges and safe areas, and a page with a fixed top bar can set `--table-presence-inset-top` (the phone page does).
  - **One bubble per person:** initials in their colour, a crown on top for a GM, and at the bottom a green dot while here or a moon while away (the away bubble also turns to a neutral disc ringed in their colour, so its initials keep full contrast and colour is never the only cue). Up to six bubbles (four on narrow screens), the last becoming `+N`, which expands the rest in place as more bubbles (wrapping along the edge if needed) and turns into `−` to fold them away.
  - **Eye toggle:** a smaller frosted eye leads the group. Pressing it hides everyone else (the eye turns crossed out with a count of people at the table) and pressing it again brings them back. It drags and docks with the group, takes the arrow keys like any bubble, is a toggle button (`aria-pressed`), and the choice is saved per device (`cf.presence.hidden`).
  - **Names:** a tip beside the bubble on hover (only where hover exists), keyboard focus, or a tap on touch screens (hidden again after 2.5 s or a tap elsewhere). It opens away from the edge, and the end bubbles of a row anchor it to their outer side, so it stays on screen. Each bubble's accessible name is the same text ("Mira, GM, here").
  - **Docking:** the bubbles sit on the left, top, right or bottom edge (a column on the sides, a row along the top or bottom), at a fraction `t` along it. The default is the left edge, a third of the way down. Dragging any bubble moves them all (pointer capture on the grabbed bubble, a 5 px threshold so a tap is still a tap, and the click after a drag swallowed). On release they snap to the nearest edge, keeping their centre's place along it, and glide there. Arrow keys on a focused bubble move them to that edge (the keyboard alternative to dragging). Position is saved per device in `localStorage` (`cf.presence.dock`); storage failures are ignored.
  - Interrupted drags (capture lost, element removed) end cleanly; bubbles are keyed by roster key, so focus stays on the right person across updates and only newcomers pop in. Names go in with `textContent` only. The stylesheet loads through a `<link>` in the shadow root and everything else is CSSOM, so it runs under the phone page's strict CSP with no new inline blocks.
- **Revised again, 20 November 2026: statuses and a modular component.** The user asked for three statuses, an away time, and room for animated activities such as messaging.
  - **Statuses.** `RosterState` is `active`, `away` (idle for five minutes) or `disconnected` (socket closed, within the grace period). A roster entry carries `awaySince` (host Unix ms) while away, and roster frames carry `serverTime`, so each client shows "away for 7 min" from its own clock without skew. A person is active if any open seat is in use, away if every open seat is idle (since the latest one went quiet), disconnected if none is open.
  - **Idle reports.** Each client watches for input (`presence/idle.js`, five minutes) and reports changes only: a joined device posts `POST /api/presence { away }` (bearer authed, `204`, keeps the first idle time on repeats), and the hosting GM's window calls the `table_report_presence` command, which sets the host's own idle time on the roster hub. Both wake the roster task.
  - **Modules** (`src/lib/presence/`, one job each, no framework): `element.js` composes the custom element; `bubble.js` creates and paints bubbles; `statuses.js` and `activities.js` are registries; `dock.js` is pure edge geometry; `drag.js` is a reusable press-and-drag controller; `prefs.js` holds per-device choices; `idle.js` detects idleness; `icons.js` and `time.js` are helpers. `table-presence.js` is the public entry. The host serves each module from a fixed, compiled-in list at `/presence/{file}`.
  - **Extending.** A new status is a `defineStatus` call (label, face style, badge, words, optional badge tip, whether it ticks) plus a `RosterState` variant on the host. An activity is a `defineActivity` call: a label, a badge icon, and Web Animations keyframes (or a function of the docked edge, so a bubble can lean out from wherever it sits) with options. Start one with `el.setActivity(key, id)` or by sending `activity` on a roster entry. "Sending a message" (the bubble leans out and back, looping) and "has a new message" (a ripple, three times) are defined; nothing sends them yet. Animations go through the Web Animations API, so the strict phone CSP allows them, and are skipped under reduced motion.
  - **Motion** (`presence/motion.js`). Every change animates instead of jumping, FLIP-style (measure, lay out, animate the difference), with only `transform` and `opacity` through the Web Animations API, so the strict phone CSP allows it; all of it is skipped under reduced motion. _Shuffle:_ moving to another edge (drag or arrow key) re-forms the group bubble by bubble, 34 ms apart, each on a path that bows sideways (alternating per bubble, at most 22 px), shrinking slightly mid-trip and overshooting a touch on landing; a new move measures bubbles mid-flight and cancels the old trips. _Hide and show:_ bubbles fold into the eye, nearest first, and spill back out of it. _"+N":_ the extra bubbles come out of the counter and fold back into it. _Arrivals and departures:_ a newcomer pops in; someone who leaves shrinks away where they stood, pinned outside the layout while the rest slide into the gap. Positions are measured by layout, not on screen, so back-to-back updates do not restart animations in flight, and a departing bubble is removed by a timer if the page clock is not running.
  - **Tests.** `tests/table-presence.test.mjs` covers the pure modules (geometry, durations, registries) and runs in CI; Rust tests cover idle reports, the host's idle state, multi-device aggregation and a drop beating idle.
- **The app.** `src/features/table/PresenceBar.tsx` mounts one element at the app root (both the desktop and the mobile tree in `App.tsx`) and keeps `.roster` in step with `useTableRoster()`: the joined table's roster, or on the hosting machine the one Rust publishes. The stylesheet comes in as a Vite `?url` asset.
- **The phone page.** The host serves the same files at `/table-presence.js` and `/table-presence.css` (`include_str!`, as with `table-live.js`). `player.html` imports the component the first time a roster arrives and hands it every roster after that.

## Delivery steps

| Step                    | Change                                                                                                                                                                        | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Presence and names   | Presence fields on `Player`, `PresenceGuard::register` in `live()`, `online` in `HostStatus`. Atomic admission, presence-aware reservation and stale same-name seat removal.  | Rust tests: two sockets on one seat, close one → still online; close both → offline with `last_closed`. Guard drop on a poisoned lock still decrements. `register` on a seat removed after its ticket was issued creates no presence. Two simultaneous joins under one name admit exactly one. A pending (no socket) seat and an away seat both hold their name. A guest whose socket closed but who saves over HTTP keeps their name past the roster grace period, and loses it only after 60 seconds without any request. A stale same-name seat is removed on a new admission, its token gets `401` and its outstanding ticket fails. A guest reclaims notes written under a name with repeated spaces, a control character and over 40 characters. |
| 2. Roster model         | `RosterEntry` types and `build_roster` in `share.rs`; `gmName` read from campaign extras.                                                                                     | Unit tests: host always first; a paired player on two devices is one entry; guest keys are not tokens or connection ids; away inside the grace period and gone after it, with the right next-expiry; unpaired seats skipped; GM role follows the registry; long names truncated; stable order; exact serialized keys.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3. Roster task and wire | `RosterHub`, task, `live()` roster frames, `table://roster`, `HostStatus.roster`, wake after `bind_device`.                                                                   | Loopback tests in `server/live/tests.rs`, with a steppable roster clock (`RosterHub::advance`) rather than a short real grace. A converges to the host plus A. B joins and A gets a roster-only frame with B and no `delta` or `changes`. B's socket drops and A sees B away, then gone. Changing `gmName` reaches A. A GM socket (`player: false`, paired GM seat) gets roster-only frames with `changes: None`, and its reconnect starts with the roster. Pairing B as a player changes B's key and role after the seat update. A roster change alone causes no `shared_versions` call.                                                                                                                                                              |
| 4. React clients        | Helpers and their types, `types.ts`, store, `PresenceBar.tsx` mounting `<table-presence>`, `gmName` field.                                                                    | `tests/table-live.test.mjs` covers initials (one word, two words, accented, emoji, blank), stable colours and palette contrast. Typecheck, lint, format and `vite build` pass. Browser check: bubbles dock left by default, dragging any bubble moves them all and snaps to the nearest edge, arrow keys move them, names show on hover and tap and stay on screen, `+N` expands and folds.                                                                                                                                                                                                                                                                                                                                                            |
| 5. Phone page           | `player.html` loads `/table-presence.js` and sets its roster; host routes serve the component.                                                                                | Headless phone run under the page CSP: bubbles appear with no CSP violations, docked below the header, and the dock survives a reload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6. Docs                 | `docs/playing-at-the-table.md` covers who you will see and what away means. Note the roster and the deferred instant leave under future features in `table-communication.md`. |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

All Rust changes pass `pnpm rust:fmt`, `pnpm rust:clippy` (`-D warnings`) and `cargo test`. Non-test code adds no `unwrap`/`expect` beyond the existing infallible-serialization ones.

## Edge cases to cover

- **Host restart.** Sessions are lost and clients rejoin, so the roster rebuilds from nothing. Presence is in memory only, so no stale entries survive.
- **GM standing granted or revoked mid-session.** The registry write bumps storage, the roster task rebuilds, and the role badge changes. The existing `live()` identity reset still sends that device a fresh snapshot, now including the roster.
- **Unpairing a device.** `build_roster` skips the seat at the next storage bump, so it disappears rather than going away. `authorize` removes the seat and closes the socket as it does today.
- **Phone backgrounding (iOS).** The socket closes and the person shows as away. When they return, the socket reconnects with the same seat token and they are here again, with the same key and colour.
- **Flapping connections.** A reconnect that completes before the task runs produces no frame, because the entries are equal. A slower flap produces two small frames, which is acceptable.
- **Large tables.** The bubbles fold into `+N`, which expands them in place, wrapping along the edge if they would run off the screen.

## Out of scope (later, on the same channel)

- **Instant leave.** Needs an opaque guest identity for note authorship first (see above).
- **Richer icons.** Player-chosen emoji or GM-set avatars. Character portraits as icons would need a per-viewer check that the sheet is shared with that viewer.
- **Activity.** "Viewing the Tavern map", raised hands, shared dice rolls, read receipts on spotlight. These need authenticated client-to-host messages; today any client frame other than a pong closes the socket.
- **Pruning old seats.** The roster already hides seats nobody has used in a long time. Removing them would send a browser that comes back later to the join screen, which is a separate decision.
