//! Table messages: live chat between the people at a table, for the session
//! only (docs/plans/table-messages.md). Everything lives here, in memory:
//! conversations, seen marks, typing leases, the send limiter and the
//! de-duplication records. Nothing is written to disk.
//!
//! Locking: a command takes the seats lock (to check the sender's identity
//! epoch and read their person key), then this hub's lock, and releases
//! both. The roster task takes the hub lock on its own, after its seats
//! snapshot, to replace the present set. Nothing here ever takes the seats
//! lock while holding the hub's, so the order is always seats, then hub.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::super::share::{RosterEntry, roster::RosterRole};

/// The hosting GM's person key.
pub const HOST_KEY: &str = "host";

/// Longest message, in Unicode scalar values and in UTF-8 bytes.
pub const TEXT_MAX_CHARS: usize = 500;
pub const TEXT_MAX_BYTES: usize = 2_000;
/// Messages kept per conversation, and across the whole table.
const PER_CONVERSATION: usize = 100;
const MAX_MESSAGES: usize = 2_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Sends per person in any window of this length.
const SEND_BURST: usize = 5;
const SEND_WINDOW: Duration = Duration::from_secs(5);
/// How long a `clientId` is remembered, and how many per person. The cap is
/// above the most the send limit allows in the window, so a record is never
/// pushed out while a resend could still arrive.
const DEDUPE_TTL: Duration = Duration::from_secs(180);
const DEDUPE_CAP: usize = 192;
/// A typing lease lasts this long without a refresh; refreshes closer
/// together than `TYPING_REFRESH` are ignored.
pub const TYPING_TTL: Duration = Duration::from_secs(6);
const TYPING_REFRESH: Duration = Duration::from_secs(1);
/// Seen reports closer together than this, per socket, are ignored.
const SEEN_REFRESH: Duration = Duration::from_secs(1);
/// Largest snapshot of one person's conversations, serialized.
pub const SNAPSHOT_BUDGET: usize = 256 * 1024;

const _: () = assert!(DEDUPE_CAP >= SEND_BURST * (180 / 5));

/// A command a device sends on its socket.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Send {
        epoch: u64,
        to: String,
        #[serde(default)]
        cid: Option<String>,
        client_id: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Typing { epoch: u64, to: String, on: bool },
    #[serde(rename_all = "camelCase")]
    Seen { epoch: u64, cid: String, seq: u64 },
}

impl Command {
    pub fn epoch(&self) -> u64 {
        match self {
            Command::Send { epoch, .. }
            | Command::Typing { epoch, .. }
            | Command::Seen { epoch, .. } => *epoch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub seq: u64,
    pub from: String,
    pub text: String,
    /// Unix ms, host clock.
    pub at: u64,
    /// Only on the sender's own copies, so a pending send can be matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub cid: String,
    pub with: String,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub seen_by_me: u64,
    #[serde(default)]
    pub seen_by_them: u64,
    /// Messages from them not yet seen by this person, counted by the host,
    /// so it stays right when old messages have been dropped.
    #[serde(default)]
    pub unread: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ended: bool,
    /// Older messages were left out to keep a snapshot within budget.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trimmed: bool,
}

/// What a frame says about a person's conversations: the whole set
/// (`snapshot`), or what changed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chats {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub snapshot: bool,
    pub conversations: Vec<ChatConversation>,
}

/// The answer to one `send`, on the socket that sent it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAck {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// For "too fast": how long to wait, in ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRules {
    pub players_may_message: bool,
}

impl Default for MessageRules {
    fn default() -> Self {
        Self {
            players_may_message: true,
        }
    }
}

/// A message on its way in: who it is for, the conversation it continues
/// (if the sender knew one), the sender's own id for it, and its text.
#[derive(Debug, Clone, Copy)]
pub struct Outgoing<'a> {
    pub to: &'a str,
    pub cid: Option<&'a str>,
    pub client_id: &'a str,
    pub text: &'a str,
}

/// Why a command was refused. Sends report it in their ack; typing and seen
/// reports are dropped quietly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    IdentityChanged,
    NotReady,
    NotAtTable,
    NotAllowed,
    ConversationEnded,
    Invalid,
    Conflict,
    TooFast(Duration),
}

impl Refusal {
    pub fn ack(self, client_id: &str) -> ChatAck {
        let (error, retry) = match self {
            Refusal::IdentityChanged => ("identity changed", None),
            Refusal::NotReady => ("not ready", None),
            Refusal::NotAtTable => ("not at the table", None),
            Refusal::NotAllowed => ("not allowed", None),
            Refusal::ConversationEnded => ("conversation ended", None),
            Refusal::Invalid => ("invalid", None),
            Refusal::Conflict => ("conflict", None),
            Refusal::TooFast(wait) => ("too fast", Some(wait.as_millis() as u64)),
        };
        ChatAck {
            client_id: client_id.to_owned(),
            error: Some(error.to_owned()),
            retry_after: retry,
            ..Default::default()
        }
    }
}

struct Conversation {
    cid: String,
    a: String,
    b: String,
    messages: VecDeque<ChatMessage>,
    next_seq: u64,
    seen: HashMap<String, u64>,
    /// Per reader: unseen messages to them that were dropped from the log.
    evicted_unread: HashMap<String, u64>,
}

impl Conversation {
    fn other(&self, key: &str) -> &str {
        if self.a == key { &self.b } else { &self.a }
    }
    fn has(&self, key: &str) -> bool {
        self.a == key || self.b == key
    }
    fn last_seq(&self) -> u64 {
        self.next_seq - 1
    }
    fn seen_by(&self, key: &str) -> u64 {
        self.seen.get(key).copied().unwrap_or(0)
    }
    /// Messages to `key` they have not seen, dropped ones included.
    fn unread_for(&self, key: &str) -> u64 {
        let seen = self.seen_by(key);
        let kept = self
            .messages
            .iter()
            .filter(|m| m.from != key && m.seq > seen)
            .count() as u64;
        kept + self.evicted_unread.get(key).copied().unwrap_or(0)
    }
    /// Drops the oldest message, keeping its reader's unread count.
    fn drop_oldest(&mut self) -> Option<ChatMessage> {
        let m = self.messages.pop_front()?;
        let reader = self.other(&m.from).to_owned();
        if m.seq > self.seen_by(&reader) {
            *self.evicted_unread.entry(reader).or_default() += 1;
        }
        Some(m)
    }
    /// A copy of `m` as `viewer` may see it: the client id only on the
    /// sender's own copies.
    fn copy_for(m: &ChatMessage, viewer: &str) -> ChatMessage {
        let mut m = m.clone();
        if m.from != viewer {
            m.client_id = None;
        }
        m
    }
}

struct Dedupe {
    client_id: String,
    hash: [u8; 32],
    ack: ChatAck,
    at: Instant,
}

struct Lease {
    from: String,
    to: String,
    expires: Instant,
    refreshed: Instant,
}

#[derive(Default)]
struct Hub {
    /// Moves with every change, under this lock, so a frame and the state
    /// it describes always agree on it.
    revision: u64,
    /// People on the roster as last published, and their roles.
    present: HashMap<String, RosterRole>,
    rules: MessageRules,
    conversations: HashMap<String, Conversation>,
    /// The live conversation between two people, by their sorted pair.
    by_pair: HashMap<(String, String), String>,
    /// Every retained message, oldest first, for table-wide eviction.
    order: VecDeque<(String, u64)>,
    total_messages: usize,
    total_bytes: usize,
    sends: HashMap<String, VecDeque<Instant>>,
    dedupe: HashMap<String, VecDeque<Dedupe>>,
    /// Typing leases by socket (the hosting window is socket 0).
    leases: HashMap<u64, Lease>,
}

fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_owned(), b.to_owned())
    } else {
        (b.to_owned(), a.to_owned())
    }
}

/// Whether `from` may message (or type to, or mark seen) `to`.
fn allowed(from: RosterRole, to: RosterRole, rules: MessageRules) -> bool {
    let gm = |r| matches!(r, RosterRole::Host | RosterRole::Gm);
    gm(from) || gm(to) || rules.players_may_message
}

/// Trims and checks a message's text.
pub fn clean_text(text: &str) -> Option<String> {
    let text = text.trim();
    let chars = text.chars().count();
    let ok = (1..=TEXT_MAX_CHARS).contains(&chars)
        && text.len() <= TEXT_MAX_BYTES
        && text
            .chars()
            .all(|c| !c.is_control() || c == '\n' || c == '\t');
    ok.then(|| text.to_owned())
}

fn valid_client_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Sent {
    seq: u64,
    me: u64,
    them: u64,
    unread: u64,
}

/// What one socket (or the hosting window) has been told so far, so each
/// frame carries only what changed.
#[derive(Default)]
pub struct ChatView {
    started: bool,
    /// Per conversation: last seq, seen marks and unread count sent.
    sent: HashMap<String, Sent>,
    typing: Option<Vec<String>>,
    rules: Option<MessageRules>,
    last_seen_report: Option<Instant>,
}

impl ChatView {
    /// Starts over: the next frame carries a full snapshot (after an
    /// identity change, say).
    pub fn reset(&mut self) {
        *self = ChatView::default();
    }

    /// A view whose frames only ever carry changes: for the hosting window,
    /// which reads its snapshot with a command and merges changes after.
    fn changes_only() -> Self {
        ChatView {
            started: true,
            ..ChatView::default()
        }
    }
}

/// Tauri event carrying the hosting window's message changes.
pub const CHATS_EVENT: &str = "table://chats";

/// Now, as Unix ms on the host clock.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Expires typing leases on time, and tells the hosting window what changed
/// for it, until the table closes.
pub async fn run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    hub: Arc<MessageHub>,
    mut closing: watch::Receiver<bool>,
) {
    use tauri::Emitter;
    let mut revision = hub.subscribe();
    let mut view = ChatView::changes_only();
    loop {
        if *closing.borrow_and_update() {
            break;
        }
        let now = Instant::now();
        let next = hub.expire(now);
        let frame = hub.frame_for(HOST_KEY, &mut view, now);
        if !frame.is_empty() {
            let _ = app.emit(CHATS_EVENT, &frame);
        }
        let expiry = async {
            match next {
                Some(at) => tokio::time::sleep_until(at.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            result = revision.changed() => if result.is_err() { break },
            result = closing.changed() => if result.is_err() { break },
            () = expiry => {}
        }
    }
}

/// What a socket should send next about messages, if anything. The
/// hosting window gets the same shape as a Tauri event.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFrame {
    /// The hub's revision this frame was made at. The hosting window uses it
    /// to drop events older than the snapshot it started from.
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chats: Option<Chats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typing: Option<Vec<String>>,
    #[serde(rename = "messageRules", skip_serializing_if = "Option::is_none")]
    pub rules: Option<MessageRules>,
}

impl ChatFrame {
    pub fn is_empty(&self) -> bool {
        self.chats.is_none() && self.typing.is_none() && self.rules.is_none()
    }
}

pub struct MessageHub {
    inner: Mutex<Hub>,
    /// Bumped on every change; sockets and the hosting window's task watch
    /// it and work out for themselves whether anything concerns them. Never
    /// sent anywhere.
    revision: watch::Sender<u64>,
}

impl Default for MessageHub {
    fn default() -> Self {
        Self {
            inner: Mutex::default(),
            revision: watch::channel(0).0,
        }
    }
}

impl MessageHub {
    fn hub(&self) -> std::sync::MutexGuard<'_, Hub> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records a change made under `hub` and wakes everyone watching.
    fn commit(&self, mut hub: std::sync::MutexGuard<'_, Hub>) {
        hub.revision += 1;
        let revision = hub.revision;
        drop(hub);
        self.revision.send_replace(revision);
    }

    /// Wakes every socket to look again (after a seat's identity changed,
    /// say), without changing anything here.
    pub fn wake(&self) {
        let hub = self.hub();
        self.commit(hub);
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// Replaces the present set from the roster just built, ending every
    /// conversation and typing lease of anyone no longer on it. Called by the
    /// roster task before it publishes the same roster, so nobody can be
    /// messaged in between leaving and their conversations ending.
    pub fn set_present(&self, roster: &[RosterEntry]) {
        let mut hub = self.hub();
        let present: HashMap<String, RosterRole> =
            roster.iter().map(|e| (e.key.clone(), e.role)).collect();
        if present == hub.present {
            return;
        }
        let gone: Vec<String> = hub
            .conversations
            .values()
            .filter(|c| !present.contains_key(&c.a) || !present.contains_key(&c.b))
            .map(|c| c.cid.clone())
            .collect();
        for cid in gone {
            hub.end(&cid);
        }
        hub.leases
            .retain(|_, l| present.contains_key(&l.from) && present.contains_key(&l.to));
        hub.present = present;
        // Roles may have changed (a player made GM): drop typing the rules no
        // longer allow.
        let rules = hub.rules;
        let roles = hub.present.clone();
        hub.leases
            .retain(|_, l| match (roles.get(&l.from), roles.get(&l.to)) {
                (Some(f), Some(t)) => allowed(*f, *t, rules),
                _ => false,
            });
        self.commit(hub);
    }

    pub fn set_rules(&self, rules: MessageRules) {
        let mut hub = self.hub();
        if hub.rules == rules {
            return;
        }
        hub.rules = rules;
        let roles = hub.present.clone();
        hub.leases
            .retain(|_, l| match (roles.get(&l.from), roles.get(&l.to)) {
                (Some(f), Some(t)) => allowed(*f, *t, rules),
                _ => false,
            });
        self.commit(hub);
    }

    /// Sends a message from `from`. The caller has checked the sender's
    /// identity (and, for a socket, still holds the seats lock). `at` is the
    /// host clock in Unix ms.
    pub fn send(
        &self,
        socket: u64,
        from: &str,
        message: Outgoing<'_>,
        now: Instant,
        at: u64,
    ) -> ChatAck {
        let Outgoing {
            to,
            cid,
            client_id,
            text,
        } = message;
        if !valid_client_id(client_id) || to.len() > 128 {
            return Refusal::Invalid.ack(client_id);
        }
        let Some(text) = clean_text(text) else {
            return Refusal::Invalid.ack(client_id);
        };
        let mut hub = self.hub();
        let hash: [u8; 32] = Sha256::digest(format!("{to}\n{text}").as_bytes()).into();
        // A resend of something already posted gets the same answer.
        if let Some(records) = hub.dedupe.get_mut(from) {
            records.retain(|r| now.saturating_duration_since(r.at) < DEDUPE_TTL);
            if let Some(r) = records.iter().find(|r| r.client_id == client_id) {
                return if r.hash == hash {
                    r.ack.clone()
                } else {
                    Refusal::Conflict.ack(client_id)
                };
            }
        }
        let Some(&from_role) = hub.present.get(from) else {
            return Refusal::NotReady.ack(client_id);
        };
        if to == from {
            return Refusal::Invalid.ack(client_id);
        }
        let Some(&to_role) = hub.present.get(to) else {
            return Refusal::NotAtTable.ack(client_id);
        };
        if !allowed(from_role, to_role, hub.rules) {
            return Refusal::NotAllowed.ack(client_id);
        }
        let key = pair(from, to);
        let current = hub.by_pair.get(&key).cloned();
        if let Some(cid) = cid
            && current.as_deref() != Some(cid)
        {
            return Refusal::ConversationEnded.ack(client_id);
        }
        let sends = hub.sends.entry(from.to_owned()).or_default();
        sends.retain(|t| now.saturating_duration_since(*t) < SEND_WINDOW);
        if sends.len() >= SEND_BURST {
            let wait = SEND_WINDOW.saturating_sub(now.saturating_duration_since(sends[0]));
            return Refusal::TooFast(wait).ack(client_id);
        }
        sends.push_back(now);
        let cid = current.unwrap_or_else(|| {
            let cid = uuid::Uuid::new_v4().to_string();
            hub.conversations.insert(
                cid.clone(),
                Conversation {
                    cid: cid.clone(),
                    a: key.0.clone(),
                    b: key.1.clone(),
                    messages: VecDeque::new(),
                    next_seq: 1,
                    seen: HashMap::new(),
                    evicted_unread: HashMap::new(),
                },
            );
            hub.by_pair.insert(key, cid.clone());
            cid
        });
        let conversation = hub.conversations.get_mut(&cid).expect("just found or made");
        let seq = conversation.next_seq;
        conversation.next_seq += 1;
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = text.len();
        conversation.messages.push_back(ChatMessage {
            id: id.clone(),
            seq,
            from: from.to_owned(),
            text,
            at,
            client_id: Some(client_id.to_owned()),
        });
        // Writing in a conversation means having read it: everything up to
        // your own message is seen by you, dropped messages included.
        conversation.seen.insert(from.to_owned(), seq);
        conversation.evicted_unread.remove(from);
        hub.order.push_back((cid.clone(), seq));
        hub.total_messages += 1;
        hub.total_bytes += bytes;
        hub.evict(&cid);
        // Sending ends this socket's typing.
        hub.leases.remove(&socket);
        let ack = ChatAck {
            client_id: client_id.to_owned(),
            id: Some(id),
            cid: Some(cid),
            seq: Some(seq),
            ..Default::default()
        };
        let records = hub.dedupe.entry(from.to_owned()).or_default();
        records.push_back(Dedupe {
            client_id: client_id.to_owned(),
            hash,
            ack: ack.clone(),
            at: now,
        });
        while records.len() > DEDUPE_CAP {
            records.pop_front();
        }
        self.commit(hub);
        ack
    }

    /// Starts, refreshes or ends `socket`'s typing lease. One lease per
    /// socket: typing to someone new replaces it.
    pub fn typing(&self, socket: u64, from: &str, to: &str, on: bool, now: Instant) {
        let mut hub = self.hub();
        if !on {
            if hub.leases.remove(&socket).is_some() {
                self.commit(hub);
            }
            return;
        }
        let (Some(&f), Some(&t)) = (hub.present.get(from), hub.present.get(to)) else {
            return;
        };
        if from == to || !allowed(f, t, hub.rules) {
            return;
        }
        let changed = match hub.leases.get_mut(&socket) {
            Some(l) if l.to == to && l.from == from => {
                if now.saturating_duration_since(l.refreshed) < TYPING_REFRESH {
                    return;
                }
                l.refreshed = now;
                l.expires = now + TYPING_TTL;
                false
            }
            _ => {
                hub.leases.insert(
                    socket,
                    Lease {
                        from: from.to_owned(),
                        to: to.to_owned(),
                        expires: now + TYPING_TTL,
                        refreshed: now,
                    },
                );
                true
            }
        };
        if changed {
            self.commit(hub);
        }
    }

    /// Ends a socket's typing, when it closes.
    pub fn drop_socket(&self, socket: u64) {
        self.typing(socket, "", "", false, Instant::now());
    }

    /// Records that `from` has read conversation `cid` up to `seq`.
    pub fn seen(&self, view: &mut ChatView, from: &str, cid: &str, seq: u64, now: Instant) {
        if view
            .last_seen_report
            .is_some_and(|t| now.saturating_duration_since(t) < SEEN_REFRESH)
        {
            return;
        }
        view.last_seen_report = Some(now);
        let mut hub = self.hub();
        let rules = hub.rules;
        let roles = hub.present.clone();
        let Some(c) = hub.conversations.get_mut(cid) else {
            return;
        };
        if !c.has(from) {
            return;
        }
        let other = c.other(from).to_owned();
        match (roles.get(from), roles.get(&other)) {
            (Some(f), Some(t)) if allowed(*f, *t, rules) => {}
            _ => return,
        }
        let seq = seq.min(c.last_seq());
        if seq <= c.seen_by(from) {
            return;
        }
        c.seen.insert(from.to_owned(), seq);
        // Devices only report what they show, which is the kept log: every
        // dropped message is older, so now seen too.
        if c.messages.front().is_none_or(|m| seq >= m.seq) {
            c.evicted_unread.remove(from);
        }
        self.commit(hub);
    }

    /// Drops expired typing leases; returns when the next one expires.
    pub fn expire(&self, now: Instant) -> Option<Instant> {
        let mut hub = self.hub();
        let before = hub.leases.len();
        hub.leases.retain(|_, l| l.expires > now);
        let changed = hub.leases.len() != before;
        // Records of people who have gone quiet, or left, go once their
        // window is over, so the hub never grows with everyone who ever sat
        // down.
        hub.dedupe.retain(|_, records| {
            records.retain(|r| now.saturating_duration_since(r.at) < DEDUPE_TTL);
            !records.is_empty()
        });
        hub.sends.retain(|_, sends| {
            sends.retain(|t| now.saturating_duration_since(*t) < SEND_WINDOW);
            !sends.is_empty()
        });
        let next = hub.leases.values().map(|l| l.expires).min();
        if changed {
            self.commit(hub);
        }
        next
    }

    /// What `key`'s socket (or the hosting window) should be sent now,
    /// given what `view` says it already has. The first call after a reset
    /// is a full snapshot.
    pub fn frame_for(&self, key: &str, view: &mut ChatView, now: Instant) -> ChatFrame {
        let hub = self.hub();
        let mut frame = ChatFrame {
            revision: hub.revision,
            ..ChatFrame::default()
        };
        let snapshot = !view.started;
        view.started = true;

        let mut mine: Vec<&Conversation> =
            hub.conversations.values().filter(|c| c.has(key)).collect();
        mine.sort_by(|a, b| a.cid.cmp(&b.cid));
        if snapshot {
            let conversations = snapshot_within_budget(&mine, key, SNAPSHOT_BUDGET);
            view.sent = mine
                .iter()
                .map(|c| (c.cid.clone(), sent_of(c, key)))
                .collect();
            frame.chats = Some(Chats {
                snapshot: true,
                conversations,
            });
        } else {
            let mut changed = Vec::new();
            let live: HashSet<&str> = mine.iter().map(|c| c.cid.as_str()).collect();
            for c in &mine {
                let now_sent = sent_of(c, key);
                let before = view.sent.get(&c.cid).copied();
                if before == Some(now_sent) {
                    continue;
                }
                let after = before.map_or(0, |b| b.seq);
                changed.push(ChatConversation {
                    cid: c.cid.clone(),
                    with: c.other(key).to_owned(),
                    messages: c
                        .messages
                        .iter()
                        .filter(|m| m.seq > after)
                        .map(|m| Conversation::copy_for(m, key))
                        .collect(),
                    seen_by_me: now_sent.me,
                    seen_by_them: now_sent.them,
                    unread: now_sent.unread,
                    ..Default::default()
                });
                view.sent.insert(c.cid.clone(), now_sent);
            }
            let ended: Vec<String> = view
                .sent
                .keys()
                .filter(|cid| !live.contains(cid.as_str()))
                .cloned()
                .collect();
            for cid in ended {
                view.sent.remove(&cid);
                changed.push(ChatConversation {
                    cid,
                    ended: true,
                    ..Default::default()
                });
            }
            if !changed.is_empty() {
                frame.chats = Some(Chats {
                    snapshot: false,
                    conversations: changed,
                });
            }
        }

        let mut typing: Vec<String> = hub
            .leases
            .values()
            .filter(|l| l.to == key && l.expires > now)
            .map(|l| l.from.clone())
            .collect();
        typing.sort();
        typing.dedup();
        if view.typing.as_ref() != Some(&typing) {
            view.typing = Some(typing.clone());
            frame.typing = Some(typing);
        }
        if view.rules != Some(hub.rules) {
            view.rules = Some(hub.rules);
            frame.rules = Some(hub.rules);
        }
        frame
    }
}

fn sent_of(c: &Conversation, key: &str) -> Sent {
    Sent {
        seq: c.last_seq(),
        me: c.seen_by(key),
        them: c.seen_by(c.other(key)),
        unread: c.unread_for(key),
    }
}

impl Hub {
    fn end(&mut self, cid: &str) {
        if let Some(c) = self.conversations.remove(cid) {
            self.by_pair.remove(&pair(&c.a, &c.b));
            self.total_messages -= c.messages.len();
            self.total_bytes -= c.messages.iter().map(|m| m.text.len()).sum::<usize>();
        }
    }

    /// Keeps the conversation at its cap and the table within its totals,
    /// the oldest message anywhere going first.
    fn evict(&mut self, cid: &str) {
        if let Some(c) = self.conversations.get_mut(cid) {
            while c.messages.len() > PER_CONVERSATION {
                let m = c.drop_oldest().expect("over the cap");
                self.total_messages -= 1;
                self.total_bytes -= m.text.len();
            }
        }
        while self.total_messages > MAX_MESSAGES || self.total_bytes > MAX_TEXT_BYTES {
            let Some((cid, seq)) = self.order.pop_front() else {
                break;
            };
            let Some(c) = self.conversations.get_mut(&cid) else {
                continue;
            };
            if c.messages.front().is_some_and(|m| m.seq == seq) {
                let m = c.drop_oldest().expect("checked");
                self.total_messages -= 1;
                self.total_bytes -= m.text.len();
            }
        }
        // The order list may hold entries already dropped by the per
        // conversation cap or a conversation ending; keep it from growing.
        if self.order.len() > 2 * MAX_MESSAGES {
            let live: HashSet<(String, u64)> = self
                .conversations
                .values()
                .flat_map(|c| c.messages.iter().map(|m| (c.cid.clone(), m.seq)))
                .collect();
            self.order.retain(|e| live.contains(e));
        }
    }
}

/// A person's whole set of conversations, newest messages kept first when
/// the serialized whole would pass `budget`.
fn snapshot_within_budget(
    mine: &[&Conversation],
    key: &str,
    budget: usize,
) -> Vec<ChatConversation> {
    let mut out: Vec<ChatConversation> = mine
        .iter()
        .map(|c| ChatConversation {
            cid: c.cid.clone(),
            with: c.other(key).to_owned(),
            messages: c
                .messages
                .iter()
                .map(|m| Conversation::copy_for(m, key))
                .collect(),
            seen_by_me: c.seen_by(key),
            seen_by_them: c.seen_by(c.other(key)),
            unread: c.unread_for(key),
            ..Default::default()
        })
        .collect();
    let size = |m: &ChatMessage| serde_json::to_string(m).map_or(0, |s| s.len() + 1);
    let mut total: usize = out
        .iter()
        .map(|c| 160 + c.messages.iter().map(size).sum::<usize>())
        .sum();
    while total > budget {
        // Drop the oldest message of the longest conversation.
        let Some(c) = out.iter_mut().max_by_key(|c| c.messages.len()) else {
            break;
        };
        if c.messages.is_empty() {
            break;
        }
        let m = c.messages.remove(0);
        total -= size(&m);
        c.trimmed = true;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::share::roster::RosterState;

    /// `send` with its message spelled out, for short tests.
    trait Post {
        #[allow(clippy::too_many_arguments)]
        fn post(
            &self,
            socket: u64,
            from: &str,
            to: &str,
            cid: Option<&str>,
            client_id: &str,
            text: &str,
            now: Instant,
            at: u64,
        ) -> ChatAck;
    }

    impl Post for MessageHub {
        fn post(
            &self,
            socket: u64,
            from: &str,
            to: &str,
            cid: Option<&str>,
            client_id: &str,
            text: &str,
            now: Instant,
            at: u64,
        ) -> ChatAck {
            self.send(
                socket,
                from,
                Outgoing {
                    to,
                    cid,
                    client_id,
                    text,
                },
                now,
                at,
            )
        }
    }

    fn entry(key: &str, role: RosterRole) -> RosterEntry {
        RosterEntry {
            key: key.into(),
            name: key.into(),
            role,
            state: RosterState::Active,
            away_since: None,
        }
    }

    fn table() -> MessageHub {
        let hub = MessageHub::default();
        hub.set_present(&[
            entry(HOST_KEY, RosterRole::Host),
            entry("player:a", RosterRole::Player),
            entry("player:b", RosterRole::Player),
            entry("guest:c", RosterRole::Guest),
        ]);
        hub
    }

    fn send(hub: &MessageHub, from: &str, to: &str, id: &str, text: &str) -> ChatAck {
        hub.post(1, from, to, None, id, text, Instant::now(), 1)
    }

    #[test]
    fn text_is_trimmed_and_bounded() {
        assert_eq!(clean_text("  hi \n").as_deref(), Some("hi"));
        assert_eq!(clean_text("   "), None);
        assert_eq!(clean_text("a\u{0007}b"), None);
        assert_eq!(
            clean_text("line\nnext\tcol").as_deref(),
            Some("line\nnext\tcol")
        );
        assert!(clean_text(&"x".repeat(TEXT_MAX_CHARS)).is_some());
        assert!(clean_text(&"x".repeat(TEXT_MAX_CHARS + 1)).is_none());
        // 500 four-byte emoji are 2,000 bytes: allowed. 501 are not.
        assert!(clean_text(&"😀".repeat(500)).is_some());
        assert!(clean_text(&"😀".repeat(501)).is_none());
        // Padding does not count, and is not stored.
        let padded = format!("{}hi{}", " ".repeat(5000), " ".repeat(5000));
        assert_eq!(clean_text(&padded).as_deref(), Some("hi"));
    }

    #[test]
    fn messages_reach_only_the_two_people() {
        let hub = table();
        let ack = send(&hub, "player:a", "player:b", "m1", "hello");
        assert!(ack.error.is_none(), "{ack:?}");
        let now = Instant::now();
        let mut a = ChatView::default();
        let mut b = ChatView::default();
        let mut c = ChatView::default();
        let fa = hub.frame_for("player:a", &mut a, now);
        let fb = hub.frame_for("player:b", &mut b, now);
        let fc = hub.frame_for("guest:c", &mut c, now);
        let mine = &fa.chats.unwrap().conversations[0];
        assert_eq!(mine.with, "player:b");
        assert_eq!(mine.messages[0].client_id.as_deref(), Some("m1"));
        let theirs = &fb.chats.unwrap().conversations[0];
        assert_eq!(theirs.messages[0].text, "hello");
        assert_eq!(
            theirs.messages[0].client_id, None,
            "only the sender sees its client id"
        );
        assert!(fc.chats.unwrap().conversations.is_empty());
        // Nothing changed for c: its next frame is empty.
        send(&hub, "player:a", "player:b", "m2", "again");
        assert!(hub.frame_for("guest:c", &mut c, now).is_empty());
        let next = hub.frame_for("player:b", &mut b, now).chats.unwrap();
        assert!(!next.snapshot);
        assert_eq!(next.conversations[0].messages.len(), 1);
        assert_eq!(next.conversations[0].messages[0].seq, 2);
    }

    #[test]
    fn resends_are_posted_once_and_conflicts_refused() {
        let hub = table();
        let first = send(&hub, "player:a", HOST_KEY, "m1", "hi");
        let again = send(&hub, "player:a", HOST_KEY, "m1", "hi");
        assert_eq!(first, again);
        assert_eq!(
            send(&hub, "player:a", HOST_KEY, "m1", "different")
                .error
                .as_deref(),
            Some("conflict")
        );
    }

    #[test]
    fn dedupe_outlasts_everything_the_send_limit_allows() {
        let hub = table();
        let start = Instant::now();
        let lost = hub.post(1, "player:a", HOST_KEY, None, "lost", "first", start, 1);
        // Another socket of the same person sends as fast as allowed for the
        // whole retry window.
        let mut t = start;
        let mut n = 0;
        while t.duration_since(start) < Duration::from_secs(170) {
            t += Duration::from_millis(1000);
            let ack = hub.post(
                2,
                "player:a",
                HOST_KEY,
                None,
                &format!("x{n}"),
                "more",
                t,
                1,
            );
            if ack.error.is_none() {
                n += 1;
            }
        }
        assert!(n > 160, "{n} sends");
        let resent = hub.post(1, "player:a", HOST_KEY, None, "lost", "first", t, 1);
        assert_eq!(resent, lost);
    }

    #[test]
    fn records_of_people_who_left_are_pruned() {
        let hub = table();
        let start = Instant::now();
        hub.post(1, "guest:c", HOST_KEY, None, "m1", "bye", start, 1);
        assert!(!hub.hub().dedupe.is_empty());
        hub.set_present(&[entry(HOST_KEY, RosterRole::Host)]);
        hub.expire(start + DEDUPE_TTL);
        let h = hub.hub();
        assert!(h.dedupe.is_empty(), "dedupe records outlived their window");
        assert!(h.sends.is_empty(), "send buckets outlived their window");
    }

    #[test]
    fn frames_carry_the_revision_of_the_state_they_show() {
        let hub = table();
        let before = hub.frame_for(HOST_KEY, &mut ChatView::default(), Instant::now());
        send(&hub, "player:a", HOST_KEY, "m1", "hi");
        let after = hub.frame_for(HOST_KEY, &mut ChatView::default(), Instant::now());
        assert!(after.revision > before.revision);
        assert_eq!(after.chats.unwrap().conversations[0].messages.len(), 1);
    }

    #[test]
    fn the_send_limit_is_per_person_across_sockets() {
        let hub = table();
        let now = Instant::now();
        for i in 0..SEND_BURST {
            let ack = hub.post(
                i as u64,
                "player:a",
                HOST_KEY,
                None,
                &format!("m{i}"),
                "x",
                now,
                1,
            );
            assert!(ack.error.is_none());
        }
        let ack = hub.post(9, "player:a", HOST_KEY, None, "late", "x", now, 1);
        assert_eq!(ack.error.as_deref(), Some("too fast"));
        assert!(ack.retry_after.unwrap() > 0);
    }

    #[test]
    fn the_switch_governs_players_but_never_the_gm() {
        let hub = table();
        hub.set_rules(MessageRules {
            players_may_message: false,
        });
        assert_eq!(
            send(&hub, "player:a", "player:b", "m1", "psst")
                .error
                .as_deref(),
            Some("not allowed")
        );
        assert!(
            send(&hub, "player:a", HOST_KEY, "m2", "hi GM")
                .error
                .is_none()
        );
        assert!(send(&hub, HOST_KEY, "guest:c", "m3", "hi").error.is_none());
        // Typing follows the matrix too.
        hub.typing(5, "player:a", "player:b", true, Instant::now());
        let mut b = ChatView::default();
        assert_eq!(
            hub.frame_for("player:b", &mut b, Instant::now()).typing,
            Some(vec![])
        );
    }

    #[test]
    fn leaving_ends_conversations_and_their_late_resends() {
        let hub = table();
        let ack = send(&hub, "player:a", "guest:c", "m1", "bye soon");
        let cid = ack.cid.unwrap();
        let mut a = ChatView::default();
        hub.frame_for("player:a", &mut a, Instant::now());
        // c leaves the roster.
        hub.set_present(&[
            entry(HOST_KEY, RosterRole::Host),
            entry("player:a", RosterRole::Player),
        ]);
        let ended = hub
            .frame_for("player:a", &mut a, Instant::now())
            .chats
            .unwrap();
        assert!(ended.conversations[0].ended);
        assert_eq!(ended.conversations[0].cid, cid);
        // c comes back (a new seat, same key for this test): a resend naming
        // the old conversation is refused rather than landing in a new one.
        hub.set_present(&[
            entry(HOST_KEY, RosterRole::Host),
            entry("player:a", RosterRole::Player),
            entry("guest:c", RosterRole::Guest),
        ]);
        let late = hub.post(
            1,
            "player:a",
            "guest:c",
            Some(&cid),
            "m9",
            "still there?",
            Instant::now(),
            1,
        );
        assert_eq!(late.error.as_deref(), Some("conversation ended"));
        assert_eq!(
            send(&hub, "player:a", "player:z", "m10", "who?")
                .error
                .as_deref(),
            Some("not at the table")
        );
        assert_eq!(
            send(&hub, "player:z", "player:a", "m11", "me")
                .error
                .as_deref(),
            Some("not ready")
        );
    }

    #[test]
    fn a_snapshot_is_the_whole_set_even_when_empty() {
        let hub = table();
        let mut v = ChatView::default();
        let first = hub.frame_for("player:a", &mut v, Instant::now());
        let chats = first.chats.unwrap();
        assert!(chats.snapshot);
        assert!(chats.conversations.is_empty());
        assert_eq!(first.typing, Some(vec![]));
        assert_eq!(first.rules, Some(MessageRules::default()));
        assert!(hub.frame_for("player:a", &mut v, Instant::now()).is_empty());
    }

    #[test]
    fn typing_is_per_socket_and_reaches_only_the_recipient() {
        let hub = table();
        let now = Instant::now();
        hub.typing(1, "player:a", "player:b", true, now);
        hub.typing(2, "player:a", "player:b", true, now);
        let mut b = ChatView::default();
        let mut c = ChatView::default();
        let mut a = ChatView::default();
        assert_eq!(
            hub.frame_for("player:b", &mut b, now).typing,
            Some(vec!["player:a".into()])
        );
        assert_eq!(hub.frame_for("guest:c", &mut c, now).typing, Some(vec![]));
        assert_eq!(hub.frame_for("player:a", &mut a, now).typing, Some(vec![]));
        // One tab stops: the other still types.
        hub.typing(1, "", "", false, now);
        assert!(hub.frame_for("player:b", &mut b, now).typing.is_none());
        // The other socket closes: nobody types.
        hub.drop_socket(2);
        assert_eq!(hub.frame_for("player:b", &mut b, now).typing, Some(vec![]));
        // Leases expire.
        hub.typing(3, "player:a", "player:b", true, now);
        assert!(hub.expire(now + TYPING_TTL / 2).is_some());
        assert!(hub.expire(now + TYPING_TTL).is_none());
        hub.frame_for("player:b", &mut b, now + TYPING_TTL);
        assert_eq!(
            hub.frame_for("player:b", &mut b, now + TYPING_TTL).typing,
            None
        );
        // A send ends the sending socket's lease.
        hub.typing(4, "player:a", "player:b", true, now);
        assert_eq!(
            hub.frame_for("player:b", &mut b, now).typing,
            Some(vec!["player:a".to_owned()])
        );
        hub.post(4, "player:a", "player:b", None, "s1", "done", now, 1);
        assert_eq!(hub.frame_for("player:b", &mut b, now).typing, Some(vec![]));
    }

    #[test]
    fn seen_moves_forward_reaches_both_sides_and_is_clamped() {
        let hub = table();
        let cid = send(&hub, "player:a", "player:b", "m1", "one").cid.unwrap();
        send(&hub, "player:a", "player:b", "m2", "two");
        let now = Instant::now();
        let mut a = ChatView::default();
        let mut b = ChatView::default();
        let snap = hub.frame_for("player:b", &mut b, now).chats.unwrap();
        assert_eq!(snap.conversations[0].seen_by_me, 0);
        hub.frame_for("player:a", &mut a, now);
        let mut reader = ChatView::default();
        hub.seen(&mut reader, "player:b", &cid, 99, now);
        let to_a = hub.frame_for("player:a", &mut a, now).chats.unwrap();
        assert_eq!(
            to_a.conversations[0].seen_by_them, 2,
            "clamped to the latest"
        );
        let to_b = hub.frame_for("player:b", &mut b, now).chats.unwrap();
        assert_eq!(to_b.conversations[0].seen_by_me, 2);
        // Backwards is ignored; a stranger cannot mark it.
        hub.seen(
            &mut ChatView::default(),
            "player:b",
            &cid,
            1,
            now + Duration::from_secs(2),
        );
        hub.seen(&mut ChatView::default(), "guest:c", &cid, 2, now);
        assert!(hub.frame_for("player:a", &mut a, now).is_empty());
    }

    #[test]
    fn unread_counts_survive_dropped_messages() {
        let hub = table();
        let mut t = Instant::now();
        // b writes 60, then a replies 60: b's early messages are dropped by
        // the 100-message cap while a has read none of them.
        let mut cid = String::new();
        // b writes 120: the first 20 are dropped by the 100-message cap
        // while a has read none of them.
        let from_b = |hub: &MessageHub, t, i: &str| {
            hub.post(1, "player:b", "player:a", None, i, "from b", t, 1)
        };
        for i in 0..120 {
            t += Duration::from_secs(2);
            cid = from_b(&hub, t, &format!("b{i}")).cid.unwrap();
        }
        let unread = |hub: &MessageHub, t| {
            hub.frame_for("player:a", &mut ChatView::default(), t)
                .chats
                .unwrap()
                .conversations[0]
                .clone()
        };
        let c = unread(&hub, t);
        assert_eq!(c.messages.len(), PER_CONVERSATION);
        assert_eq!(c.unread, 120, "a has read none of the 120 from b");
        // Reading what is shown clears it all.
        hub.seen(&mut ChatView::default(), "player:a", &cid, 120, t);
        assert_eq!(unread(&hub, t).unread, 0);
        // More arrive and are dropped unread; replying counts as reading.
        for i in 0..110 {
            t += Duration::from_secs(2);
            from_b(&hub, t, &format!("c{i}"));
        }
        assert_eq!(unread(&hub, t).unread, 110);
        t += Duration::from_secs(2);
        hub.post(2, "player:a", "player:b", None, "reply", "ok!", t, 1);
        assert_eq!(unread(&hub, t).unread, 0);
    }

    #[test]
    fn memory_and_snapshots_stay_within_their_caps() {
        let hub = MessageHub::default();
        let mut roster = vec![entry(HOST_KEY, RosterRole::Host)];
        for i in 0..40 {
            roster.push(entry(&format!("player:{i}"), RosterRole::Player));
        }
        hub.set_present(&roster);
        let big = "😀".repeat(500);
        let mut t = Instant::now();
        for round in 0..150 {
            for i in 0..40 {
                t += Duration::from_millis(1200);
                let ack = hub.post(
                    i,
                    &format!("player:{i}"),
                    HOST_KEY,
                    None,
                    &format!("r{round}-{i}"),
                    &big,
                    t,
                    1,
                );
                assert!(ack.error.is_none(), "{ack:?}");
            }
        }
        {
            let h = hub.hub();
            assert!(h.total_messages <= MAX_MESSAGES);
            assert!(h.total_bytes <= MAX_TEXT_BYTES);
            assert!(
                h.conversations
                    .values()
                    .all(|c| c.messages.len() <= PER_CONVERSATION)
            );
        }
        let snap = hub
            .frame_for(HOST_KEY, &mut ChatView::default(), t)
            .chats
            .unwrap();
        let size = serde_json::to_string(&snap).unwrap().len();
        assert!(size <= SNAPSHOT_BUDGET, "{size}");
        assert!(snap.conversations.iter().any(|c| c.trimmed));
    }
}
