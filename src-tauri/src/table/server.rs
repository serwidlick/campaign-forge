//! The GM's table server: a small HTTP API on the local network that hands
//! players the shared parts of the open campaign.
//!
//! ```text
//! GET  /api/table                       who is hosting what (no auth)
//! POST /api/join   {name, liveProtocol, code or device proof} -> {token, info}
//! GET  /api/elements                    shared summaries
//! GET  /api/elements/{id}               one shared element
//! GET  /api/assets/{*path}              a shared map image
//! PUT  /api/elements/{id}/sheet         the owner of a character saves its sheet
//! POST /api/notes  {name, body}         a player writes a note into the campaign
//! PUT  /api/notes/{id}                  the author changes or shares a note
//! DELETE /api/notes/{id}                the author deletes a note
//! POST /api/live/ticket                 mint a single-use WebSocket ticket
//! GET  /api/live                        upgrade to the live table WebSocket
//!                                       (two-way: devices send messages,
//!                                       typing and seen marks on it; see
//!                                       `messages`)
//!
//! POST /api/gm/call {command, args}     a GM's device: run any storage command
//! GET  /api/gm/assets/{*path}           a GM's device: any asset
//! POST /api/gm/upload/{kind}?id&name    a GM's device: import a file's bytes
//! ```
//!
//! The same server also serves a small web page at `/` so a phone or
//! tablet can sit at the table from its browser, with the same API.
//!
//! The host checks the live protocol and join code or paired-device proof
//! before issuing a session token. Protected HTTP requests use that bearer.
//! Each WebSocket authenticates with a single-use ticket. GM-only commands
//! additionally check the device's current role.

mod live;
use live::{Tickets, issue_ticket, load_tls, upgrade};
pub mod messages;
pub use messages::MessageHub;
mod roster;
use roster::ROSTER_GRACE;
pub use roster::RosterHub;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::identity;
use crate::storage::{AppState, DiskChanges, Element, ElementSummary, MAX_DOCUMENT_BYTES};

use super::gm;
use super::players;
use super::share::{self, Viewer};

pub(super) const LIVE_PROTOCOL: &str = "table.ws.v1";

/// Sent to players once the GM has stopped hosting.
pub const CLOSED_MESSAGE: &str = "the GM ended the table";

/// What a player learns about the table on joining.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    #[serde(default)]
    pub live_protocol: Option<String>,
    pub name: String,
    #[serde(default)]
    pub system: Option<String>,
    /// The campaign's calendar setting, passed through verbatim.
    #[serde(default)]
    pub calendar: Option<Value>,
    pub version: u64,
    /// The campaign's paired players, so a sheet's owner id can be shown
    /// as a name. Names only; devices stay with the GM.
    #[serde(default)]
    pub players: Vec<PlayerName>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerName {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub name: String,
    pub joined_at: String,
    pub last_seen: String,
    /// Public management handle. Older GM clients read the wire field "token".
    #[serde(rename = "token")]
    pub connection_id: String,
    /// Present when the app joined (a browser joins without a key).
    pub device: Option<ConnectedDevice>,
    /// Set once the device is paired with a player in the campaign.
    pub player_id: Option<String>,
    /// The paired player is a GM: this connection gets the GM API.
    pub gm: bool,
    /// At least one live socket is open for this seat right now.
    pub online: bool,
    /// Live-socket accounting, kept under the same lock as the seat so a
    /// removed seat takes its presence with it.
    #[serde(skip)]
    pub(super) presence: Presence,
    /// Opaque id the public roster uses for a guest seat. Never the bearer
    /// token or the management `connection_id`.
    #[serde(skip)]
    pub(super) roster_key: String,
    /// Bumped whenever this seat becomes someone else (pairing), under the
    /// seats lock. Message commands carry the epoch their device last saw,
    /// and a stale one is refused, so nothing is ever sent as the wrong
    /// person.
    #[serde(skip)]
    pub epoch: u64,
}

/// Live sockets for one seat, and when they came and went.
#[derive(Debug, Clone, Default)]
pub(super) struct Presence {
    pub sockets: u32,
    pub first_connected: Option<Instant>,
    pub last_closed: Option<Instant>,
    /// When the device reported going idle (Unix ms); `None` while in use.
    pub away_since: Option<u64>,
}

impl Player {
    /// Whether this seat still holds its name: heard from recently (an HTTP
    /// request or a heartbeat), a socket open, or a socket closed within the
    /// roster's grace period. A name is never released before the roster
    /// stops showing it.
    fn holds_name(&self, now: Instant, grace: Duration) -> bool {
        let cutoff = chrono::Utc::now() - SEAT_TIMEOUT;
        let heard_from = chrono::DateTime::parse_from_rfc3339(&self.last_seen)
            .is_ok_and(|t| t.with_timezone(&chrono::Utc) >= cutoff);
        heard_from
            || self.presence.sockets > 0
            || self
                .presence
                .last_closed
                .is_some_and(|closed| now.saturating_duration_since(closed) < grace)
    }

    fn roster_seat(&self) -> share::RosterSeat {
        share::RosterSeat {
            roster_key: self.roster_key.clone(),
            name: self.name.clone(),
            player_id: self.player_id.clone(),
            fingerprint: self.device.as_ref().map(|d| d.fingerprint.clone()),
            sockets: self.presence.sockets,
            first_connected: self.presence.first_connected,
            last_closed: self.presence.last_closed,
            away_since: self.presence.away_since,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedDevice {
    pub fingerprint: String,
    pub public_key: String,
    pub label: String,
}

/// Proof that the joining app holds a device key: a signature over a nonce
/// this server handed out moments ago.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProof {
    pub public_key: String,
    #[serde(default)]
    pub label: String,
    pub nonce: String,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Challenge {
    pub nonce: String,
}

/// How long a challenge nonce stays valid.
const CHALLENGE_TTL: Duration = Duration::from_secs(120);

/// Wrong join codes one address may send before it is locked out, and for
/// how long. Six digits are a million codes; at LAN speed that is minutes
/// of guessing unless each miss costs something.
const CODE_ATTEMPTS: u32 = 5;
const CODE_LOCKOUT: Duration = Duration::from_secs(60);
/// An address's misses are forgotten after this long without another.
const CODE_MEMORY: Duration = Duration::from_secs(600);

/// How recently a seated guest must have been heard from to still hold
/// their name. Connected clients answer WebSocket heartbeats.
const SEAT_TIMEOUT: chrono::Duration = chrono::Duration::seconds(60);

/// Most seats a table holds at once. It bounds everything kept per person
/// (conversations, typing, send limits) whatever joins. When full, seats
/// that no longer hold their name are cleared to make room first.
pub const MAX_SEATS: usize = 64;

/// Wrong join codes from one address.
#[derive(Debug, Clone, Copy)]
struct CodeFailures {
    count: u32,
    last: Instant,
}

/// What the lockout says about a join attempt from one address.
#[derive(Debug, PartialEq, Eq)]
enum Attempt {
    /// The code was right, or no code was tried; misses are forgotten.
    Allowed,
    /// The code was wrong; counted.
    Wrong,
    /// The address is locked out for this much longer, whatever it sent.
    Locked(Duration),
}

/// Records a join attempt from `ip` and says whether it may go on. A locked
/// address is refused even with the right code, so guessing cannot pay.
fn code_attempt(
    failures: &mut HashMap<IpAddr, CodeFailures>,
    ip: IpAddr,
    correct: bool,
    now: Instant,
) -> Attempt {
    failures.retain(|_, f| now.duration_since(f.last) < CODE_MEMORY);
    if let Some(f) = failures.get(&ip)
        && f.count >= CODE_ATTEMPTS
    {
        let since = now.duration_since(f.last);
        if since < CODE_LOCKOUT {
            return Attempt::Locked(CODE_LOCKOUT - since);
        }
        // The lock has run out: start counting afresh.
        failures.remove(&ip);
    }
    if correct {
        failures.remove(&ip);
        return Attempt::Allowed;
    }
    let f = failures.entry(ip).or_insert(CodeFailures {
        count: 0,
        last: now,
    });
    f.count += 1;
    f.last = now;
    if f.count >= CODE_ATTEMPTS {
        eprintln!(
            "table: {ip} sent {} wrong join codes and is locked out for {} s",
            f.count,
            CODE_LOCKOUT.as_secs()
        );
    }
    Attempt::Wrong
}

/// Whether a guest may sit down as `name`. Notes and sheets from before
/// pairing are matched by the name their player joined with, so the name
/// is the identity: a guest may not take a paired player's name, nor the
/// name of someone at the table right now. The exception is the same
/// device coming back (`device`, its proven fingerprint): someone who
/// left, or whose page reloaded, may sit down again under their own name
/// at once.
fn name_taken(
    registry: &[players::PlayerRecord],
    seated: &HashMap<String, Player>,
    name: &str,
    device: Option<&str>,
    now: Instant,
    grace: Duration,
) -> Option<&'static str> {
    if registry.iter().any(|p| same_name(&p.name, name)) {
        return Some(
            "that is a paired player's name: use another, or have the GM pair this device as them",
        );
    }
    let same_device = |p: &Player| {
        device.is_some_and(|fp| p.device.as_ref().is_some_and(|d| d.fingerprint == fp))
    };
    if seated
        .values()
        .any(|p| same_name(&p.name, name) && p.holds_name(now, grace) && !same_device(p))
    {
        return Some(
            "someone is already at the table under that name: use another, or wait a minute if that was you",
        );
    }
    None
}

/// Names compare as notes authorize them: trimmed, ignoring ASCII case.
fn same_name(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Whether a join takes a place at the table: not when it replaces the same
/// device's own guest seat under the same name (`seat_guest` swaps it).
fn needs_new_seat(seats: &HashMap<String, Player>, joining: &Player) -> bool {
    let Some(fp) = joining.device.as_ref().map(|d| &d.fingerprint) else {
        return true;
    };
    !seats.values().any(|p| {
        p.player_id.is_none()
            && joining.player_id.is_none()
            && same_name(&p.name, &joining.name)
            && p.device.as_ref().is_some_and(|d| &d.fingerprint == fp)
    })
}

/// Admits a guest under `name` and seats them, in one critical section so
/// two joins cannot both pass the check. Older guest seats under the same
/// name hold it no longer (or the join is refused), so they are removed:
/// one name, one live holder. Their tokens stop working and any ticket
/// issued to them fails to register. The same device coming back keeps its
/// place in the roster (bubble, colour and conversations) by taking over
/// the old seat's roster key.
fn seat_guest(
    seats: &mut HashMap<String, Player>,
    registry: &[players::PlayerRecord],
    token: String,
    mut player: Player,
    now: Instant,
    grace: Duration,
) -> Result<(), &'static str> {
    let device = player.device.as_ref().map(|d| d.fingerprint.clone());
    if let Some(why) = name_taken(registry, seats, &player.name, device.as_deref(), now, grace) {
        return Err(why);
    }
    if let Some(fp) = &device
        && let Some(old) = seats.values().find(|p| {
            p.player_id.is_none()
                && same_name(&p.name, &player.name)
                && p.device.as_ref().is_some_and(|d| &d.fingerprint == fp)
        })
    {
        player.roster_key.clone_from(&old.roster_key);
        player.presence.first_connected = old.presence.first_connected;
        // Until the new socket connects, the person is "just disconnected",
        // not gone: their grace runs from now (or from when they did go), so
        // the roster keeps them and their conversations survive the handover.
        player.presence.last_closed = if old.presence.sockets > 0 {
            Some(now)
        } else {
            old.presence.last_closed
        };
    }
    seats.retain(|_, p| !(p.player_id.is_none() && same_name(&p.name, &player.name)));
    seats.insert(token, player);
    Ok(())
}

pub type Players = Arc<Mutex<HashMap<String, Player>>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    #[serde(default)]
    pub live_protocol: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub device: Option<DeviceProof>,
    /// The GM page asking: only a device already paired with a GM may sit
    /// down, and the code buys nothing.
    #[serde(default)]
    pub gm_only: bool,
}

/// Why the GM page turns a device away.
pub const NOT_A_GM_DEVICE: &str = "This page is only for the GM's own devices. Open the table's main page in this browser, sit down with the code, then have the GM pair it and press Make GM.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResponse {
    pub token: String,
    pub info: TableInfo,
    /// The name the table knows this player by (the GM's, once paired).
    pub name: String,
    #[serde(default)]
    pub player_id: Option<String>,
    /// True when the device was already paired and no code was needed.
    #[serde(default)]
    pub recognized: bool,
    /// The device belongs to a GM: the app should show the GM view, fed
    /// from this table, instead of the player view.
    #[serde(default)]
    pub gm: bool,
}

/// What the GM is showing everyone right now. `seq` grows on every change
/// so players can tell a new spotlight from one they already opened.
#[derive(Debug, Clone, Default)]
pub struct Spotlight {
    pub seq: u64,
    pub element: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct TableChange {
    pub version: u64,
    /// The GM stopped hosting; the player should leave.
    #[serde(default)]
    pub closed: bool,
    /// Element the GM is showing everyone, if any.
    #[serde(default)]
    pub spotlight: Option<String>,
    #[serde(default)]
    pub spotlight_seq: u64,
    /// Whether the asking device counts as a GM right now; the GM can grant
    /// or revoke that while the device is connected.
    #[serde(default)]
    pub gm: bool,
    /// For a GM's device: what changed since the last event, so its window can
    /// reload exactly what the hosting window would on an outside edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<DiskChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<PlayerDelta>,
    #[serde(default)]
    pub player_id: Option<String>,
    /// Who is at the table. Present on a socket's first frame and whenever
    /// it changes; a frame without it leaves the client's copy alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roster: Option<Vec<share::RosterEntry>>,
    /// The host's clock (Unix ms) when a frame carrying the roster was sent,
    /// so clients can turn `awaySince` into "away for 7 min" whatever their
    /// own clock says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_time: Option<u64>,
    /// Which roster entry is the device receiving this frame, sent with the
    /// roster so its bubble can be marked as "you". A guest's key is opaque,
    /// so the device could not work it out for itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub you: Option<String>,
    /// The seat's identity epoch, sent with `you`. Message commands carry it
    /// back so a re-paired device cannot send as who it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// This person's conversations: the whole set, or what changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chats: Option<messages::Chats>,
    /// Answers to this socket's `send` commands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acks: Option<Vec<messages::ChatAck>>,
    /// Who is typing to this person now, whenever that changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typing: Option<Vec<String>>,
    /// Whether players may message each other, whenever that changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_rules: Option<messages::MessageRules>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerDelta {
    pub reset: bool,
    pub upserts: Vec<ElementSummary>,
    pub removed: Vec<String>,
}

type Served<R = tauri::Wry> = Arc<ServerState<R>>;

struct ServerState<R: tauri::Runtime> {
    secure: bool,
    tickets: Arc<Mutex<Tickets>>,
    handshakes: Arc<tokio::sync::Semaphore>,
    app: AppHandle<R>,
    code: String,
    players: Players,
    /// Flips to true when the GM stops hosting.
    closing: watch::Receiver<bool>,
    spotlight: watch::Receiver<Spotlight>,
    /// Outstanding challenge nonces and when they were issued.
    nonces: Arc<Mutex<HashMap<String, Instant>>>,
    /// Wrong join codes by address, for the lockout.
    failures: Arc<Mutex<HashMap<IpAddr, CodeFailures>>>,
    /// Who is at the table, published by the roster task.
    roster: Arc<RosterHub>,
    /// Table messages, in memory for the session.
    messages: Arc<MessageHub>,
}

/// A running server; dropping the stop sender ends it.
pub struct Running {
    pub origin: Option<String>,
    pub port: u16,
    pub players: Players,
    pub stop: watch::Sender<bool>,
    pub spotlight: watch::Sender<Spotlight>,
    pub roster: Arc<RosterHub>,
    pub messages: Arc<MessageHub>,
}

/// Ports tried in order. 80 first: phones then open the table at a bare
/// address with no port, and an ordinary user may bind it on Windows and
/// macOS when nothing else holds it (Linux needs a capability and falls
/// through). Then a fixed high port. A browser keeps its device key per
/// origin, which includes the port, so a phone paired tonight is only
/// recognised next week if the table comes back on the same one. A random
/// port is the last resort.
const PREFERRED_PORTS: [u16; 2] = [80, 47530];

/// Request bodies up to a whole document, plus room for a base64 image in
/// a JSON call. Only GM uploads come anywhere near it.
const BODY_LIMIT: usize = MAX_DOCUMENT_BYTES as usize + 16 * 1024 * 1024;

/// Binds the first free preferred port (or any free one) on every
/// interface and serves until `stop` is sent.
pub async fn start(app: AppHandle, code: String) -> Result<Running, String> {
    let tls = load_tls().await?;
    let ports = if tls.is_some() {
        [443, 47531]
    } else {
        PREFERRED_PORTS
    };
    let mut listener = None;
    for port in ports {
        if let Ok(l) = tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            listener = Some(l);
            break;
        }
    }
    let listener = match listener {
        Some(l) => l,
        None => tokio::net::TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|e| format!("could not open a port: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let players: Players = Arc::default();
    let (stop, mut stop_rx) = watch::channel(false);
    let (spotlight, spotlight_rx) = watch::channel(Spotlight::default());
    let roster = Arc::new(RosterHub::new(ROSTER_GRACE));
    let messages = Arc::new(MessageHub::default());

    let origin = tls.as_ref().map(|(host, _)| {
        if port == 443 {
            format!("https://{host}")
        } else {
            format!("https://{host}:{port}")
        }
    });
    let served = Arc::new(ServerState {
        secure: tls.is_some(),
        tickets: Arc::default(),
        handshakes: Arc::new(tokio::sync::Semaphore::new(32)),
        app,
        code,
        players: players.clone(),
        closing: stop_rx.clone(),
        spotlight: spotlight_rx,
        nonces: Arc::default(),
        failures: Arc::default(),
        roster: roster.clone(),
        messages: messages.clone(),
    });
    tauri::async_runtime::spawn(roster::run(served.clone()));
    tauri::async_runtime::spawn(messages::run(
        served.app.clone(),
        messages.clone(),
        stop_rx.clone(),
    ));
    let mut reconcile_stop = stop.subscribe();
    let reconcile_app = served.app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = reconcile_stop.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    let app = reconcile_app.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().refresh_table()).await;
                }
            }
        }
    });
    let router = Router::new()
        .route("/", get(player_page))
        .route("/marked.umd.js", get(player_script))
        .route("/nacl-fast.min.js", get(player_nacl))
        .route("/purify.min.js", get(player_purify))
        .route("/icon.png", get(player_icon))
        .route("/api/table", get(table_info))
        .route("/api/challenge", get(challenge))
        .route("/api/join", post(join))
        .route("/api/elements", get(elements))
        .route("/api/elements/{id}", get(element))
        .route("/api/elements/{id}/sheet", put(update_sheet))
        .route("/api/notes", post(create_note))
        .route("/api/notes/{id}", put(update_note).delete(delete_note))
        .route("/api/assets/{*path}", get(asset))
        .route("/api/live/ticket", post(issue_ticket))
        .route("/api/live", get(upgrade))
        .route("/api/presence", post(report_presence))
        .route("/table-live.js", get(live_script))
        .route("/table-presence.js", get(presence_script))
        .route("/table-presence.css", get(presence_style))
        .route("/presence/{file}", get(presence_module))
        .route("/api/gm/call", post(gm_call))
        .route("/api/gm/assets/{*path}", get(gm_asset))
        .route("/api/gm/upload/{kind}", post(gm_upload))
        .route("/gm", get(gm_page))
        .route("/gm/", get(gm_page))
        .fallback(get(app_asset))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(served);

    let listener = listener.into_std().map_err(|e| e.to_string())?;
    let handle = axum_server::Handle::new();
    let shutdown = handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = stop_rx.changed().await;
        shutdown.graceful_shutdown(Some(Duration::from_secs(5)));
    });
    let service = router.into_make_service_with_connect_info::<SocketAddr>();
    if let Some((_, config)) = tls {
        let server = axum_server::from_tcp_rustls(listener, config).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn(server.handle(handle).serve(service));
    } else {
        let server = axum_server::from_tcp(listener).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn(server.handle(handle).serve(service));
    }

    Ok(Running {
        port,
        origin,
        players,
        stop,
        spotlight,
        roster,
        messages,
    })
}

// ---- The phone page ------------------------------------------------------

const PLAYER_PAGE: &str = include_str!("../../web/player.html");
const PLAYER_SCRIPT: &str = include_str!("../../web/marked.umd.js");
/// TweetNaCl: Ed25519 for the browser. `crypto.subtle` is withheld on plain
/// HTTP, which is all a LAN address gets, so the page signs with this.
const PLAYER_NACL: &str = include_str!("../../web/nacl-fast.min.js");
/// DOMPurify: the page shows Markdown written by the GM and by other
/// players, and marked passes raw HTML and any link scheme through.
const PLAYER_PURIFY: &str = include_str!("../../web/purify.min.js");
const PLAYER_ICON: &[u8] = include_bytes!("../../icons/128x128.png");

const JS: &str = "application/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";

/// The phone page's Content Security Policy. Only the page's own scripts
/// run: the files it ships and its two inline blocks, allowed by hash, so
/// whatever a note smuggles past the sanitiser cannot run or phone home.
/// Pictures and PDFs come as blob URLs the page makes from authenticated
/// fetches; a PDF may open in a frame or a plugin of the browser's.
fn page_csp() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        let scripts = inline_hashes(PLAYER_PAGE, "<script>", "</script>");
        let styles = inline_hashes(PLAYER_PAGE, "<style>", "</style>");
        format!(
            "default-src 'self'; script-src 'self'{scripts}; style-src 'self'{styles}; \
             img-src 'self' blob: data:; connect-src 'self'; frame-src 'self' blob:; \
             object-src 'self' blob:; base-uri 'self'; form-action 'self'; \
             frame-ancestors 'none'"
        )
    })
}

/// `'sha256-…'` sources for every inline block between `open` and `close`,
/// hashed exactly as a browser does: the text between the tags, after the
/// HTML parser's newline normalisation (CRLF and lone CR become LF). A
/// Windows checkout with `core.autocrlf` embeds the page with CRLF, which
/// the browser never sees, so hashing the raw bytes would block the page.
fn inline_hashes(html: &str, open: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.find(open) {
        let body = &rest[start + open.len()..];
        let Some(end) = body.find(close) else {
            break;
        };
        let text = body[..end].replace("\r\n", "\n").replace('\r', "\n");
        let digest = Sha256::digest(text.as_bytes());
        out.push_str(&format!(" 'sha256-{}'", BASE64_STANDARD.encode(digest)));
        rest = &body[end + close.len()..];
    }
    out
}

/// A response with the headers everything the server serves to a browser
/// gets: the type, no sniffing, no referrer; the page also gets its CSP.
fn served(content_type: &'static str, body: impl IntoResponse, csp: Option<&str>) -> Response {
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if let Some(csp) = csp
        && let Ok(value) = HeaderValue::from_str(csp)
    {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

/// Browsers supply Host and Origin independently. Build the expected origin from
/// the listener scheme and a validated authority, including the effective port.
fn request_origin(secure: bool, headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
    {
        return None;
    }
    let scheme = if secure { "https" } else { "http" };
    let url = reqwest::Url::parse(&format!("{scheme}://{host}")).ok()?;
    Some(url.origin().ascii_serialization())
}

fn socket_csp(policy: &str, secure: bool, headers: &HeaderMap) -> String {
    match request_origin(secure, headers) {
        Some(origin) => {
            let socket = origin.replacen("http", "ws", 1);
            policy.replace("connect-src ", &format!("connect-src {socket} "))
        }
        None => policy.to_owned(),
    }
}

async fn live_script() -> Response {
    served(JS, include_str!("../../../src/lib/table-live.js"), None)
}

/// The self-contained "who is at the table" bubbles, shared with the app:
/// the entry module, its stylesheet and the modules it is built from.
async fn presence_script() -> Response {
    served(JS, include_str!("../../../src/lib/table-presence.js"), None)
}

async fn presence_style() -> Response {
    served(
        CSS,
        include_str!("../../../src/lib/table-presence.css"),
        None,
    )
}

/// The presence modules, compiled in. Only these names are served, so the
/// route cannot reach anything else.
const PRESENCE_MODULES: &[(&str, &str)] = &[
    (
        "activities.js",
        include_str!("../../../src/lib/presence/activities.js"),
    ),
    (
        "bubble.js",
        include_str!("../../../src/lib/presence/bubble.js"),
    ),
    ("dock.js", include_str!("../../../src/lib/presence/dock.js")),
    ("drag.js", include_str!("../../../src/lib/presence/drag.js")),
    (
        "haptics.js",
        include_str!("../../../src/lib/presence/haptics.js"),
    ),
    (
        "motion.js",
        include_str!("../../../src/lib/presence/motion.js"),
    ),
    (
        "element.js",
        include_str!("../../../src/lib/presence/element.js"),
    ),
    (
        "icons.js",
        include_str!("../../../src/lib/presence/icons.js"),
    ),
    ("idle.js", include_str!("../../../src/lib/presence/idle.js")),
    (
        "prefs.js",
        include_str!("../../../src/lib/presence/prefs.js"),
    ),
    (
        "statuses.js",
        include_str!("../../../src/lib/presence/statuses.js"),
    ),
    ("time.js", include_str!("../../../src/lib/presence/time.js")),
    ("view.js", include_str!("../../../src/lib/presence/view.js")),
    ("card.js", include_str!("../../../src/lib/presence/card.js")),
    (
        "card-motion.js",
        include_str!("../../../src/lib/presence/card-motion.js"),
    ),
    (
        "card-sections.js",
        include_str!("../../../src/lib/presence/card-sections.js"),
    ),
    ("chat.js", include_str!("../../../src/lib/presence/chat.js")),
    (
        "conversation.js",
        include_str!("../../../src/lib/presence/conversation.js"),
    ),
    (
        "messages.js",
        include_str!("../../../src/lib/presence/messages.js"),
    ),
    (
        "placement.js",
        include_str!("../../../src/lib/presence/placement.js"),
    ),
];

async fn presence_module(Path(file): Path<String>) -> Response {
    match PRESENCE_MODULES.iter().find(|(name, _)| *name == file) {
        Some((_, body)) => served(JS, *body, None),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn player_page(State(s): State<Served>, headers: HeaderMap) -> Response {
    let csp = socket_csp(page_csp(), s.secure, &headers);
    served("text/html; charset=utf-8", PLAYER_PAGE, Some(&csp))
}

async fn player_script() -> Response {
    served(JS, PLAYER_SCRIPT, None)
}

async fn player_nacl() -> Response {
    served(JS, PLAYER_NACL, None)
}

async fn player_purify() -> Response {
    served(JS, PLAYER_PURIFY, None)
}

async fn player_icon() -> Response {
    served("image/png", PLAYER_ICON, None)
}

// ---- The GM page: the whole app, in a browser ------------------------------
//
// The same frontend the desktop window shows is served at `/gm`, from the
// assets built into this executable (or, in development, from the `dist`
// folder, so `pnpm build` refreshes it). The page is only the app's code,
// which anyone may have; what it can do is decided by `/api/join` with
// `gmOnly`, which seats nobody but a device paired with a GM, and by the
// `/api/gm/` routes, which answer only such a device.

/// The app's CSP from `tauri.conf.json` comes with the HTML, as the app's
/// own window gets it; the browser is told the same.
fn app_asset_response(s: &Served, path: &str, request_headers: &HeaderMap) -> Option<Response> {
    let asset = s.app.asset_resolver().get(path.to_owned())?;
    let mut response = asset.bytes.into_response();
    let headers = response.headers_mut();
    if let Ok(mime) = HeaderValue::from_str(&asset.mime_type) {
        headers.insert(header::CONTENT_TYPE, mime);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Some(csp) = asset.csp_header.as_deref() {
        let csp = socket_csp(csp, s.secure, request_headers);
        if let Ok(value) = HeaderValue::from_str(&csp) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
    }
    Some(response)
}

async fn gm_page(State(s): State<Served>, headers: HeaderMap) -> Response {
    app_asset_response(&s, "/index.html", &headers).unwrap_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "The GM page is not built into this copy of Campaign Forge. In development, run `pnpm build` once so the dist folder exists.",
        )
            .into_response()
    })
}

/// Scripts, styles and images the GM page refers to by absolute path.
async fn app_asset(State(s): State<Served>, uri: axum::http::Uri, headers: HeaderMap) -> Response {
    if uri.path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    app_asset_response(&s, uri.path(), &headers)
        .unwrap_or_else(|| (StatusCode::NOT_FOUND, "not found").into_response())
}

// ---- Handlers -------------------------------------------------------------

pub(super) struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

/// The error text is passed through verbatim: the frontend recognises some
/// of it (a `conflict:` prefix on a stale save).
pub(super) fn storage_error(e: crate::storage::StorageError) -> ApiError {
    let status = match &e {
        crate::storage::StorageError::Conflict(_) => StatusCode::CONFLICT,
        crate::storage::StorageError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    ApiError(status, e.to_string())
}

fn info_of<R: tauri::Runtime>(s: &Served<R>) -> Result<TableInfo, ApiError> {
    let state = s.app.state::<AppState>();
    let meta = state.current_campaign().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "the GM has no campaign open".to_owned(),
        )
    })?;
    Ok(TableInfo {
        live_protocol: Some(LIVE_PROTOCOL.to_owned()),
        name: meta.name,
        system: meta.system,
        calendar: meta.extra.get("calendar").cloned(),
        version: state.version(),
        players: players::load(&state)
            .into_iter()
            .map(|p| PlayerName {
                id: p.id,
                name: p.name,
            })
            .collect(),
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A request proves liveness. Server pushes only check the current authorization.
fn authed<R: tauri::Runtime>(s: &Served<R>, headers: &HeaderMap) -> Result<Who, ApiError> {
    authorize(s, bearer(headers), true)
}

/// The seat token a request carries, or "" when it has none.
fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("")
}

fn authorize<R: tauri::Runtime>(s: &Served<R>, token: &str, seen: bool) -> Result<Who, ApiError> {
    if *s.closing.borrow() {
        return Err(ApiError(StatusCode::GONE, CLOSED_MESSAGE.to_owned()));
    }
    let mut seats = s.players.lock().map_err(|_| poisoned())?;
    let unauthorized = || {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "not joined to this table".to_owned(),
        )
    };
    let p = seats.get_mut(token).ok_or_else(unauthorized)?;
    if let Some(id) = &p.player_id {
        let identity = p.device.as_ref().and_then(|d| {
            s.app
                .state::<AppState>()
                .paired_identity(&d.fingerprint, id)
        });
        let Some((name, gm)) = identity else {
            seats.remove(token);
            return Err(unauthorized());
        };
        p.gm = gm;
        p.name = name;
    }
    if seen {
        p.last_seen = now();
    }
    Ok(Who {
        name: p.name.clone(),
        player_id: p.player_id.clone(),
        gm: p.gm,
        roster_key: share::roster::person_key(p.player_id.as_deref(), &p.roster_key),
        epoch: p.epoch,
    })
}

/// A joined connection's identity, as the sharing rules see it.
struct Who {
    name: String,
    player_id: Option<String>,
    gm: bool,
    /// The roster entry that is this connection's person.
    roster_key: String,
    /// The seat's identity epoch (see `Player::epoch`).
    epoch: u64,
}

impl Who {
    fn viewer(&self) -> Viewer<'_> {
        Viewer {
            name: &self.name,
            player_id: self.player_id.as_deref(),
        }
    }

    fn require_gm(&self) -> Result<(), ApiError> {
        if self.gm {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::FORBIDDEN,
                "the GM has not made this player a GM".to_owned(),
            ))
        }
    }
}

fn poisoned() -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "player list poisoned".to_owned(),
    )
}

/// A fresh nonce for the app to sign with its device key.
async fn challenge(State(s): State<Served>) -> Result<Json<Challenge>, ApiError> {
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut nonces = s.nonces.lock().map_err(|_| poisoned())?;
    nonces.retain(|_, issued| issued.elapsed() < CHALLENGE_TTL);
    nonces.insert(nonce.clone(), Instant::now());
    Ok(Json(Challenge { nonce }))
}

async fn table_info(State(s): State<Served>) -> Result<Json<TableInfo>, ApiError> {
    Ok(Json(info_of(&s)?))
}

async fn join<R: tauri::Runtime>(
    State(s): State<Served<R>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<JoinRequest>,
) -> Result<Json<JoinResponse>, ApiError> {
    if req.live_protocol.as_deref() != Some(LIVE_PROTOCOL) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Update your Campaign Forge client or reload this page to join this WebSocket table."
                .into(),
        ));
    }
    // A device proves itself by signing a nonce we issued; the nonce is
    // single-use and short-lived, so a captured join cannot be replayed.
    let device = match req.device {
        Some(proof) => {
            let fresh = {
                let mut nonces = s.nonces.lock().map_err(|_| poisoned())?;
                nonces
                    .remove(&proof.nonce)
                    .is_some_and(|issued| issued.elapsed() < CHALLENGE_TTL)
            };
            if !fresh {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "the join challenge expired; try again".to_owned(),
                ));
            }
            let fingerprint =
                identity::verify(&proof.public_key, proof.nonce.as_bytes(), &proof.signature)
                    .ok_or_else(|| {
                        ApiError(
                            StatusCode::BAD_REQUEST,
                            "device signature did not verify".to_owned(),
                        )
                    })?;
            Some(ConnectedDevice {
                fingerprint,
                public_key: proof.public_key,
                label: proof.label,
            })
        }
        None => None,
    };

    let state = s.app.state::<AppState>();
    let registry = players::load(&state);
    let known = device
        .as_ref()
        .and_then(|d| players::find_by_device(&registry, &d.fingerprint))
        .cloned();

    if req.gm_only && !known.as_ref().is_some_and(|p| p.gm) {
        return Err(ApiError(StatusCode::FORBIDDEN, NOT_A_GM_DEVICE.to_owned()));
    }

    if known.is_none() {
        let code = req.code.as_deref().map(str::trim).unwrap_or("");
        if code.is_empty() {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "this device is new to the GM: enter the join code".to_owned(),
            ));
        }
        let attempt = {
            let mut failures = s.failures.lock().map_err(|_| poisoned())?;
            code_attempt(&mut failures, peer.ip(), code == s.code, Instant::now())
        };
        match attempt {
            Attempt::Allowed => {}
            Attempt::Wrong => {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "wrong join code".to_owned(),
                ));
            }
            Attempt::Locked(wait) => {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    format!(
                        "too many wrong join codes from this device; try again in {} seconds",
                        wait.as_secs().max(1)
                    ),
                ));
            }
        }
    }

    // The name a guest joins with is their identity for their notes, so it is
    // kept exactly as typed (trimmed); only the roster cleans it for display.
    let typed = req.name.trim();
    let name = match &known {
        Some(p) => p.name.clone(),
        None if typed.is_empty() => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "give yourself a name first".to_owned(),
            ));
        }
        None => typed.to_owned(),
    };

    let info = info_of(&s)?;
    let token = uuid::Uuid::new_v4().to_string();
    let stamp = now();
    let player_id = known.as_ref().map(|p| p.id.clone());
    let gm = known.as_ref().is_some_and(|p| p.gm);
    let seat = Player {
        name: name.clone(),
        joined_at: stamp.clone(),
        last_seen: stamp,
        connection_id: uuid::Uuid::new_v4().to_string(),
        device,
        player_id: player_id.clone(),
        gm,
        online: false,
        presence: Presence::default(),
        roster_key: uuid::Uuid::new_v4().to_string(),
        epoch: 0,
    };
    {
        let mut seats = s.players.lock().map_err(|_| poisoned())?;
        // A device taking back its own seat needs no new place.
        let full = |seats: &HashMap<String, Player>| {
            seats.len() >= MAX_SEATS && needs_new_seat(seats, &seat)
        };
        if full(&seats) {
            // Only guests who no longer hold their name make room; a paired
            // player's or GM's device keeps its seat however long it sleeps.
            let (now, grace) = (Instant::now(), s.roster.grace());
            seats.retain(|_, p| p.player_id.is_some() || p.holds_name(now, grace));
        }
        if full(&seats) {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "the table is full".to_owned(),
            ));
        }
        if known.is_some() {
            seats.insert(token.clone(), seat);
        } else {
            seat_guest(
                &mut seats,
                &registry,
                token.clone(),
                seat,
                Instant::now(),
                s.roster.grace(),
            )
            .map_err(|why| ApiError(StatusCode::CONFLICT, why.to_owned()))?;
        }
    }
    s.roster.wake();
    if let Some(p) = &known {
        let _ = players::touch(&state, &p.id);
    }
    Ok(Json(JoinResponse {
        token,
        info,
        name,
        recognized: known.is_some(),
        player_id,
        gm,
    }))
}

/// What a device says about itself: whether its user has gone idle.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceReport {
    pub away: bool,
}

/// A device reports that its user went idle, or came back. Away keeps the
/// time it started, so a repeated report does not reset "away for".
async fn report_presence<R: tauri::Runtime>(
    State(s): State<Served<R>>,
    headers: HeaderMap,
    Json(report): Json<PresenceReport>,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers);
    authed(&s, &headers)?;
    {
        let mut seats = s.players.lock().map_err(|_| poisoned())?;
        let seat = seats.get_mut(token).ok_or_else(|| {
            ApiError(
                StatusCode::UNAUTHORIZED,
                "not joined to this table".to_owned(),
            )
        })?;
        seat.presence.away_since = if report.away {
            seat.presence.away_since.or_else(|| Some(unix_ms()))
        } else {
            None
        };
    }
    s.roster.wake();
    Ok(StatusCode::NO_CONTENT)
}

/// Now, in Unix milliseconds: the roster's clock for "away since".
pub(super) fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

async fn elements(
    State(s): State<Served>,
    headers: HeaderMap,
) -> Result<Json<Vec<ElementSummary>>, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    share::shared_summaries(&state, Some(&who.viewer()))
        .map(Json)
        .map_err(storage_error)
}

async fn element(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Element>, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    match share::shared_element(&state, &id, Some(&who.viewer())).map_err(storage_error)? {
        Some(e) => Ok(Json(e)),
        None => Err(ApiError(StatusCode::NOT_FOUND, "not shared".to_owned())),
    }
}

async fn asset(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    let allowed = share::shared_asset_paths(&state, Some(&who.viewer())).map_err(storage_error)?;
    if !allowed.contains(&path) {
        return Err(ApiError(StatusCode::NOT_FOUND, "not shared".to_owned()));
    }
    let bytes = state.read_asset(&path).map_err(storage_error)?;
    Ok(([(header::CONTENT_TYPE, content_type_of(&path))], bytes).into_response())
}

fn content_type_of(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_ascii_lowercase) {
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        Some(ext) if ext == "webp" => "image/webp",
        Some(ext) if ext == "gif" => "image/gif",
        Some(ext) if ext == "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

// ---- A GM's device --------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct GmCall {
    pub command: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Deserialize)]
pub struct UploadQuery {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Runs a storage or table command for a GM working from another machine.
async fn gm_call(
    State(s): State<Served>,
    headers: HeaderMap,
    Json(req): Json<GmCall>,
) -> Result<Json<Value>, ApiError> {
    authed(&s, &headers)?.require_gm()?;
    gm::call(&s.app, &req.command, req.args).await.map(Json)
}

/// Any asset of the campaign, for a GM's device.
async fn gm_asset(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    authed(&s, &headers)?.require_gm()?;
    let bytes = s
        .app
        .state::<AppState>()
        .read_asset(&path)
        .map_err(storage_error)?;
    Ok(([(header::CONTENT_TYPE, content_type_of(&path))], bytes).into_response())
}

/// A file from a GM's other machine, imported as if picked on this one.
async fn gm_upload(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    authed(&s, &headers)?.require_gm()?;
    gm::upload(&s.app, &kind, q.id.as_deref(), q.name.as_deref(), &body).map(Json)
}

/// A player updating the sheet of the character the GM assigned to them.
async fn update_sheet<R: tauri::Runtime>(
    State(s): State<Served<R>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(sheet): Json<Value>,
) -> Result<Json<Element>, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    let base = headers
        .get("x-base-version")
        .and_then(|h| h.to_str().ok())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            ApiError(
                StatusCode::PRECONDITION_REQUIRED,
                "reload the sheet in a current client before saving".to_owned(),
            )
        })?;
    match share::update_sheet(&state, &id, &who.viewer(), sheet, base.to_owned())
        .map_err(storage_error)?
    {
        Some(e) => Ok(Json(e)),
        None => Err(ApiError(
            StatusCode::FORBIDDEN,
            "this character is not yours to edit".to_owned(),
        )),
    }
}

/// A player writing a note: a new file in the GM's campaign folder, theirs
/// and the GM's until they share it.
async fn create_note(
    State(s): State<Served>,
    headers: HeaderMap,
    Json(input): Json<share::NoteInput>,
) -> Result<Json<Element>, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    share::create_note(&state, &who.viewer(), input)
        .map(Json)
        .map_err(storage_error)
}

/// The author of a note changing its title, body or sharing.
async fn update_note(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<share::NoteInput>,
) -> Result<Json<Element>, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    match share::update_note(&state, &id, &who.viewer(), input).map_err(storage_error)? {
        Some(e) => Ok(Json(e)),
        None => Err(ApiError(
            StatusCode::FORBIDDEN,
            "this note is not yours to edit".to_owned(),
        )),
    }
}

/// The author of a note deleting it, file and all.
async fn delete_note(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    if share::delete_note(&state, &id, &who.viewer()).map_err(storage_error)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError(
            StatusCode::FORBIDDEN,
            "this note is not yours to delete".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, last))
    }

    #[test]
    fn wrong_codes_lock_an_address_out_and_the_lock_runs_out() {
        let mut failures = HashMap::new();
        let t0 = Instant::now();
        for _ in 0..CODE_ATTEMPTS {
            assert_eq!(
                code_attempt(&mut failures, ip(7), false, t0),
                Attempt::Wrong
            );
        }
        // Locked now, even with the right code, and other addresses are not.
        assert!(matches!(
            code_attempt(&mut failures, ip(7), true, t0 + Duration::from_secs(1)),
            Attempt::Locked(_)
        ));
        assert_eq!(
            code_attempt(&mut failures, ip(8), true, t0 + Duration::from_secs(1)),
            Attempt::Allowed
        );
        // Once the lock has run out the right code gets in.
        assert_eq!(
            code_attempt(&mut failures, ip(7), true, t0 + CODE_LOCKOUT),
            Attempt::Allowed
        );
        assert!(!failures.contains_key(&ip(7)));
    }

    #[test]
    fn a_right_code_forgets_earlier_misses() {
        let mut failures = HashMap::new();
        let t0 = Instant::now();
        assert_eq!(
            code_attempt(&mut failures, ip(7), false, t0),
            Attempt::Wrong
        );
        assert_eq!(
            code_attempt(&mut failures, ip(7), true, t0),
            Attempt::Allowed
        );
        assert!(failures.is_empty());
    }

    const GRACE: Duration = Duration::from_secs(60);

    fn guest_seat(name: &str, seconds_ago: i64) -> Player {
        let when = (chrono::Utc::now() - chrono::Duration::seconds(seconds_ago))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        Player {
            name: name.to_owned(),
            joined_at: when.clone(),
            last_seen: when,
            connection_id: format!("seat-{name}"),
            device: None,
            player_id: None,
            gm: false,
            online: false,
            presence: Presence::default(),
            roster_key: format!("roster-{name}"),
            epoch: 0,
        }
    }

    fn seated(name: &str, seconds_ago: i64) -> HashMap<String, Player> {
        HashMap::from([("tok".to_owned(), guest_seat(name, seconds_ago))])
    }

    #[test]
    fn guests_cannot_take_a_paired_or_seated_name() {
        let now = Instant::now();
        let registry = vec![players::PlayerRecord {
            id: "p1".to_owned(),
            name: "Mira".to_owned(),
            devices: Vec::new(),
            last_seen: None,
            gm: false,
        }];
        assert!(name_taken(&registry, &HashMap::new(), " mira ", None, now, GRACE).is_some());
        assert!(name_taken(&registry, &HashMap::new(), "Tam", None, now, GRACE).is_none());
        assert!(name_taken(&[], &seated("Tam", 5), "TAM", None, now, GRACE).is_some());
        // A name whose holder has gone quiet is free again.
        assert!(name_taken(&[], &seated("Tam", 300), "Tam", None, now, GRACE).is_none());
    }

    #[test]
    fn an_open_or_recently_closed_socket_holds_the_name() {
        let now = Instant::now();
        let mut seats = seated("Tam", 300);
        let seat = seats.get_mut("tok").unwrap();
        seat.presence.sockets = 1;
        assert!(name_taken(&[], &seats, "tam", None, now, GRACE).is_some());
        let seat = seats.get_mut("tok").unwrap();
        seat.presence.sockets = 0;
        seat.presence.last_closed = Some(now - Duration::from_secs(10));
        assert!(name_taken(&[], &seats, "tam", None, now, GRACE).is_some());
        // Away past the grace period, and silent over HTTP: free again.
        let seat = seats.get_mut("tok").unwrap();
        seat.presence.last_closed = Some(now - GRACE - Duration::from_secs(1));
        assert!(name_taken(&[], &seats, "tam", None, now, GRACE).is_none());
    }

    #[test]
    fn a_guest_saving_over_http_keeps_their_name_after_the_roster_drops_them() {
        let now = Instant::now();
        // The socket closed long ago, but a note was saved five seconds ago.
        let mut seats = seated("Tam", 5);
        let seat = seats.get_mut("tok").unwrap();
        seat.presence.first_connected = Some(now - Duration::from_secs(400));
        seat.presence.last_closed = Some(now - Duration::from_secs(300));
        let (roster, _) = share::build_roster(
            &[seat.roster_seat()],
            &[],
            share::RosterHost::default(),
            GRACE,
            now,
        );
        assert_eq!(roster.len(), 1, "only the host is shown");
        assert!(name_taken(&[], &seats, "Tam", None, now, GRACE).is_some());
    }

    #[test]
    fn admission_keeps_one_holder_per_guest_name() {
        let now = Instant::now();
        let mut seats = HashMap::new();
        seat_guest(
            &mut seats,
            &[],
            "a".into(),
            guest_seat("Tam", 0),
            now,
            GRACE,
        )
        .unwrap();
        // While the first holder is protected the name is refused.
        assert!(
            seat_guest(
                &mut seats,
                &[],
                "b".into(),
                guest_seat("TAM", 0),
                now,
                GRACE
            )
            .is_err()
        );
        assert_eq!(seats.len(), 1);
        // Once it holds the name no longer, a newcomer replaces it, and the
        // old token stops working.
        let old = seats.get_mut("a").unwrap();
        old.last_seen = (chrono::Utc::now() - chrono::Duration::seconds(300))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        old.presence.last_closed = Some(now - GRACE - Duration::from_secs(1));
        seat_guest(
            &mut seats,
            &[],
            "b".into(),
            guest_seat("tam", 0),
            now,
            GRACE,
        )
        .unwrap();
        assert!(!seats.contains_key("a"));
        assert!(seats.contains_key("b"));
        // Another name is untouched.
        seat_guest(
            &mut seats,
            &[],
            "c".into(),
            guest_seat("Jules", 0),
            now,
            GRACE,
        )
        .unwrap();
        assert_eq!(seats.len(), 2);
    }

    #[test]
    fn stored_names_keep_their_exact_spelling() {
        // Notes authorize by the joined name, so admission must not rewrite
        // it; only the roster cleans names for display.
        let now = Instant::now();
        let odd = format!("Mary  Jane\u{7}{}", "x".repeat(50));
        let mut seats = HashMap::new();
        seat_guest(&mut seats, &[], "a".into(), guest_seat(&odd, 0), now, GRACE).unwrap();
        assert_eq!(seats["a"].name, odd);
        let viewer = Viewer {
            name: &seats["a"].name,
            player_id: None,
        };
        let mut extra = crate::storage::Extra::new();
        extra.insert("author".into(), json!(odd));
        assert!(share::is_own_note(share::NOTE_KIND, &extra, &viewer));
    }

    #[test]
    fn inline_blocks_are_hashed_like_a_browser_does() {
        let html = "<script src=\"/a.js\"></script><script>alert(1)</script><style>b{}</style>";
        // SHA-256 of "alert(1)", as a CSP would list it.
        assert_eq!(
            inline_hashes(html, "<script>", "</script>"),
            " 'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"
        );
        assert_eq!(
            inline_hashes(html, "<style>", "</style>")
                .matches("sha256-")
                .count(),
            1
        );
        assert!(page_csp().contains("script-src 'self' 'sha256-"));
    }

    #[test]
    fn inline_blocks_hash_the_same_whatever_the_line_endings() {
        // Escapes, not a multi-line literal: rustc turns CRLF in source into
        // LF, while `include_str!` keeps a CRLF checkout's bytes as they are.
        let lf = "<script>\nlet a = 1;\nlet b = 2;\n</script><style>\nb{}\n</style>";
        let crlf = "<script>\r\nlet a = 1;\r\nlet b = 2;\r\n</script><style>\r\nb{}\r\n</style>";
        let cr = "<script>\rlet a = 1;\rlet b = 2;\r</script><style>\rb{}\r</style>";
        for (open, close) in [("<script>", "</script>"), ("<style>", "</style>")] {
            let expected = inline_hashes(lf, open, close);
            assert_eq!(inline_hashes(crlf, open, close), expected);
            assert_eq!(inline_hashes(cr, open, close), expected);
        }
        // What a browser lists for the LF script: SHA-256 of its text.
        assert_eq!(
            inline_hashes(crlf, "<script>", "</script>"),
            format!(
                " 'sha256-{}'",
                BASE64_STANDARD.encode(Sha256::digest("\nlet a = 1;\nlet b = 2;\n"))
            )
        );
    }

    #[test]
    fn the_same_device_rejoins_under_its_name_at_once() {
        let now = Instant::now();
        let with_device = |name: &str, fp: &str| {
            let mut seat = guest_seat(name, 0);
            seat.device = Some(ConnectedDevice {
                fingerprint: fp.into(),
                public_key: "key".into(),
                label: "phone".into(),
            });
            seat
        };
        let mut seats = HashMap::new();
        let first = with_device("Tam", "fp-tam");
        let key = first.roster_key.clone();
        seat_guest(&mut seats, &[], "old".into(), first, now, GRACE).unwrap();
        seats.get_mut("old").unwrap().presence.sockets = 1;
        // Another device may not take the name while Tam holds it...
        let mut other = with_device("tam", "fp-other");
        other.roster_key = "roster-other".into();
        assert!(seat_guest(&mut seats, &[], "x".into(), other, now, GRACE).is_err());
        // ...but Tam's own device, back from leaving, sits straight down, in
        // the same place on the roster; the old seat is gone.
        let mut again = with_device("Tam", "fp-tam");
        again.roster_key = "roster-new".into();
        seat_guest(&mut seats, &[], "new".into(), again, now, GRACE).unwrap();
        assert!(!seats.contains_key("old"));
        assert_eq!(seats["new"].roster_key, key);
        // Until the new socket connects the person stays on the roster as
        // just disconnected, so their conversations are not ended.
        assert_eq!(seats["new"].presence.sockets, 0);
        assert_eq!(seats["new"].presence.last_closed, Some(now));
        // At a full table, taking back your own seat needs no new place.
        let mine = with_device("Tam", "fp-tam");
        assert!(!needs_new_seat(&seats, &mine));
        assert!(needs_new_seat(&seats, &with_device("Tam", "fp-other")));
        assert!(needs_new_seat(&seats, &guest_seat("Tam", 0)));
        // Without a device there is nothing to recognise: refused as before.
        assert!(
            seat_guest(
                &mut seats,
                &[],
                "y".into(),
                guest_seat("Tam", 0),
                now,
                GRACE
            )
            .is_err()
        );
    }

    #[test]
    fn every_presence_module_is_served() {
        // Phones load the bubbles from the host; one missing module and the
        // whole component fails to import there, silently.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/presence");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".js"))
            .collect();
        on_disk.sort();
        let mut served: Vec<String> = PRESENCE_MODULES
            .iter()
            .map(|(name, _)| (*name).to_owned())
            .collect();
        served.sort();
        assert_eq!(served, on_disk);
    }
}
