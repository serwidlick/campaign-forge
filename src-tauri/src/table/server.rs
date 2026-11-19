//! The GM's table server: a small HTTP API on the local network that hands
//! players the shared parts of the open campaign.
//!
//! ```text
//! GET  /api/table                       who is hosting what (no auth)
//! POST /api/join   {name, code}         -> {token, info}
//! GET  /api/elements                    shared summaries
//! GET  /api/elements/{id}               one shared element
//! GET  /api/assets/{*path}              a shared map image
//! PUT  /api/elements/{id}/sheet         the owner of a character saves its sheet
//! POST /api/notes  {name, body}         a player writes a note into the campaign
//! PUT  /api/notes/{id}                  the author changes or shares a note
//! DELETE /api/notes/{id}                the author deletes a note
//! GET  /api/version?after=N             long-poll: returns once version > N
//!
//! POST /api/gm/call {command, args}     a GM's device: run any storage command
//! GET  /api/gm/assets/{*path}           a GM's device: any asset
//! POST /api/gm/upload/{kind}?id&name    a GM's device: import a file's bytes
//! ```
//!
//! The same server also serves a small web page at `/` so a phone or
//! tablet can sit at the table from its browser, with the same API.
//!
//! Everything but `/api/table` and the page needs `Authorization: Bearer <token>`. The
//! token comes from `/api/join`, which checks the six-digit code the GM reads
//! out at the table. That is the whole security model: same Wi-Fi plus the
//! code. Fine for a living room, and we say so in the UI. The `/api/gm/`
//! routes answer only a device paired with a player the GM marked as a GM
//! ([`super::gm`]); they see and change everything, like the GM's own window.

mod live;
use live::{Tickets, issue_ticket, load_tls, upgrade};

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

/// How long a version long-poll waits before answering "nothing new".
const LONG_POLL: Duration = Duration::from_secs(25);

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
/// their name. A connected page polls at least every 25 seconds.
const SEAT_TIMEOUT: chrono::Duration = chrono::Duration::seconds(60);

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
/// name of someone at the table right now.
fn name_taken(
    registry: &[players::PlayerRecord],
    seated: &HashMap<String, Player>,
    name: &str,
) -> Option<&'static str> {
    let same = |other: &str| other.trim().eq_ignore_ascii_case(name.trim());
    if registry.iter().any(|p| same(&p.name)) {
        return Some(
            "that is a paired player's name: use another, or have the GM pair this device as them",
        );
    }
    let cutoff = chrono::Utc::now() - SEAT_TIMEOUT;
    let present = |p: &Player| {
        chrono::DateTime::parse_from_rfc3339(&p.last_seen)
            .is_ok_and(|t| t.with_timezone(&chrono::Utc) >= cutoff)
    };
    if seated.values().any(|p| same(&p.name) && present(p)) {
        return Some(
            "someone is already at the table under that name: use another, or wait a minute if that was you",
        );
    }
    None
}

pub type Players = Arc<Mutex<HashMap<String, Player>>>;

#[derive(Debug, Deserialize)]
pub struct JoinRequest {
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

#[derive(Debug, Deserialize)]
pub struct AfterQuery {
    #[serde(default)]
    pub after: u64,
    /// Last spotlight sequence number the player has seen.
    #[serde(default)]
    pub event: u64,
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
pub struct VersionResponse {
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
    /// For a GM's device: what changed since `after`, so its window can
    /// reload exactly what the hosting window would on an outside edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<DiskChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<PlayerDelta>,
    #[serde(default)]
    pub player_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerDelta {
    pub reset: bool,
    pub upserts: Vec<ElementSummary>,
    pub removed: Vec<String>,
}

type Served<R = tauri::Wry> = Arc<ServerState<R>>;

struct ServerState<R: tauri::Runtime> {
    origin: Option<String>,
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
}

/// A running server; dropping the stop sender ends it.
pub struct Running {
    pub origin: Option<String>,
    pub port: u16,
    pub players: Players,
    pub stop: watch::Sender<bool>,
    pub spotlight: watch::Sender<Spotlight>,
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

    let origin = tls.as_ref().map(|(host, _)| {
        if port == 443 {
            format!("https://{host}")
        } else {
            format!("https://{host}:{port}")
        }
    });
    let served = Arc::new(ServerState {
        origin: origin.clone(),
        tickets: Arc::default(),
        handshakes: Arc::new(tokio::sync::Semaphore::new(32)),
        app,
        code,
        players: players.clone(),
        closing: stop_rx.clone(),
        spotlight: spotlight_rx,
        nonces: Arc::default(),
        failures: Arc::default(),
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
        .route("/api/version", get(version))
        .route("/api/live/ticket", post(issue_ticket))
        .route("/api/live", get(upgrade))
        .route("/table-live.js", get(live_script))
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
/// hashed exactly as a browser does: the text between the tags, verbatim.
fn inline_hashes(html: &str, open: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.find(open) {
        let body = &rest[start + open.len()..];
        let Some(end) = body.find(close) else {
            break;
        };
        let digest = Sha256::digest(&body.as_bytes()[..end]);
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

fn socket_csp(policy: &str, origin: Option<&str>) -> String {
    match origin {
        Some(origin) => policy.replace(
            "connect-src ",
            &format!("connect-src {} ", origin.replacen("https:", "wss:", 1)),
        ),
        None => policy.to_owned(),
    }
}

async fn live_script() -> Response {
    served(JS, include_str!("../../../src/lib/table-live.js"), None)
}

async fn player_page(State(s): State<Served>) -> Response {
    let csp = socket_csp(page_csp(), s.origin.as_deref());
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
fn app_asset_response(s: &Served, path: &str) -> Option<Response> {
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
        let csp = socket_csp(csp, s.origin.as_deref());
        if let Ok(value) = HeaderValue::from_str(&csp) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
    }
    Some(response)
}

async fn gm_page(State(s): State<Served>) -> Response {
    app_asset_response(&s, "/index.html").unwrap_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "The GM page is not built into this copy of Campaign Forge. In development, run `pnpm build` once so the dist folder exists.",
        )
            .into_response()
    })
}

/// Scripts, styles and images the GM page refers to by absolute path.
async fn app_asset(State(s): State<Served>, uri: axum::http::Uri) -> Response {
    app_asset_response(&s, uri.path())
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
        live_protocol: s.origin.as_ref().map(|_| LIVE_PROTOCOL.to_owned()),
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
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    authorize(s, token, true)
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
        let registry = players::load(&s.app.state::<AppState>());
        let record = p
            .device
            .as_ref()
            .and_then(|d| players::find_by_device(&registry, &d.fingerprint))
            .filter(|record| &record.id == id);
        let Some(record) = record else {
            seats.remove(token);
            return Err(unauthorized());
        };
        p.gm = record.gm;
        p.name.clone_from(&record.name);
    }
    if seen {
        p.last_seen = now();
    }
    Ok(Who {
        name: p.name.clone(),
        player_id: p.player_id.clone(),
        gm: p.gm,
    })
}

/// A joined connection's identity, as the sharing rules see it.
struct Who {
    name: String,
    player_id: Option<String>,
    gm: bool,
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

    let typed = req.name.trim();
    let name = match &known {
        Some(p) => p.name.clone(),
        None if typed.is_empty() => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "give yourself a name first".to_owned(),
            ));
        }
        None => {
            let seated = s.players.lock().map_err(|_| poisoned())?;
            if let Some(why) = name_taken(&registry, &seated, typed) {
                return Err(ApiError(StatusCode::CONFLICT, why.to_owned()));
            }
            typed.to_owned()
        }
    };
    if let Some(p) = &known {
        let _ = players::touch(&state, &p.id);
    }

    let info = info_of(&s)?;
    let token = uuid::Uuid::new_v4().to_string();
    let stamp = now();
    let player_id = known.as_ref().map(|p| p.id.clone());
    let gm = known.as_ref().is_some_and(|p| p.gm);
    s.players.lock().map_err(|_| poisoned())?.insert(
        token.clone(),
        Player {
            name: name.clone(),
            joined_at: stamp.clone(),
            last_seen: stamp,
            connection_id: uuid::Uuid::new_v4().to_string(),
            device,
            player_id: player_id.clone(),
            gm,
        },
    );
    Ok(Json(JoinResponse {
        token,
        info,
        name,
        recognized: known.is_some(),
        player_id,
        gm,
    }))
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

fn visible_spotlight(
    state: &AppState,
    who: &Who,
    id: Option<String>,
) -> Result<Option<String>, ApiError> {
    if who.gm || id.is_none() {
        return Ok(id);
    }
    let entries = share::shared_versions(state, Some(&who.viewer())).map_err(storage_error)?;
    Ok(id.filter(|id| entries.iter().any(|(e, _)| &e.meta.id == id)))
}

pub(super) const LIVE_PROTOCOL: &str = "table.ws.v1";

/// Answers as soon as the campaign changes past `after`, or after a while
/// with the current version so clients can simply loop.
async fn version(
    State(s): State<Served>,
    headers: HeaderMap,
    Query(q): Query<AfterQuery>,
) -> Result<Json<VersionResponse>, ApiError> {
    authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    let mut rx = state.changes();
    let mut closing = s.closing.clone();
    let mut spot_rx = s.spotlight.clone();
    let deadline = tokio::time::sleep(LONG_POLL);
    tokio::pin!(deadline);
    let respond = |version: u64, spot: Spotlight, closed: bool| {
        // A GM's window reloads exactly what changed; players re-fetch the
        // shared list and need no detail.
        if closed {
            return Ok(Json(VersionResponse {
                closed: true,
                version,
                ..Default::default()
            }));
        }
        let who = authed(&s, &headers)?;
        let spotlight = visible_spotlight(&state, &who, spot.element)?;
        let changes = (who.gm && version > q.after).then(|| state.changes_since(q.after));
        Ok(Json(VersionResponse {
            version,
            closed,
            spotlight,
            spotlight_seq: spot.seq,
            gm: who.gm,
            player_id: who.player_id,
            delta: None,
            changes,
        }))
    };
    loop {
        let current = *rx.borrow();
        let spot = spot_rx.borrow().clone();
        if *closing.borrow() {
            return respond(current, spot, true);
        }
        if current > q.after || spot.seq > q.event {
            return respond(current, spot, false);
        }
        tokio::select! {
            _ = &mut deadline => return respond(current, spot, false),
            changed = rx.changed() => {
                if changed.is_err() {
                    return respond(current, spot, false);
                }
            }
            _ = spot_rx.changed() => {}
            // A closed channel means the host was dropped: that is a close too.
            _ = closing.changed() => return respond(current, spot, true),
        }
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

    fn seated(name: &str, seconds_ago: i64) -> HashMap<String, Player> {
        let when = (chrono::Utc::now() - chrono::Duration::seconds(seconds_ago))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        HashMap::from([(
            "tok".to_owned(),
            Player {
                name: name.to_owned(),
                joined_at: when.clone(),
                last_seen: when,
                connection_id: "seat".to_owned(),
                device: None,
                player_id: None,
                gm: false,
            },
        )])
    }

    #[test]
    fn guests_cannot_take_a_paired_or_seated_name() {
        let registry = vec![players::PlayerRecord {
            id: "p1".to_owned(),
            name: "Mira".to_owned(),
            devices: Vec::new(),
            last_seen: None,
            gm: false,
        }];
        assert!(name_taken(&registry, &HashMap::new(), " mira ").is_some());
        assert!(name_taken(&registry, &HashMap::new(), "Tam").is_none());
        assert!(name_taken(&[], &seated("Tam", 5), "TAM").is_some());
        // A name whose holder has gone quiet is free again.
        assert!(name_taken(&[], &seated("Tam", 300), "Tam").is_none());
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
}
