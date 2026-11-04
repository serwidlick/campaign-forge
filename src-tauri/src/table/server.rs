//! The GM's table server: a small HTTP API on the local network that hands
//! players the shared parts of the open campaign.
//!
//! ```text
//! GET  /api/table                       who is hosting what (no auth)
//! POST /api/join   {name, code}         -> {token, info}
//! GET  /api/elements                    shared summaries
//! GET  /api/elements/{id}               one shared element
//! GET  /api/assets/{*path}              a shared map image
//! GET  /api/version?after=N             long-poll: returns once version > N
//! ```
//!
//! The same server also serves a small web page at `/` so a phone or
//! tablet can sit at the table from its browser, with the same API.
//!
//! Everything but `/api/table` and the page needs `Authorization: Bearer <token>`. The
//! token comes from `/api/join`, which checks the six-digit code the GM reads
//! out at the table. That is the whole security model: same Wi-Fi plus the
//! code. Fine for a living room, and we say so in the UI.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::identity;
use crate::storage::{AppState, Element, ElementSummary};

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
    pub name: String,
    #[serde(default)]
    pub system: Option<String>,
    /// The campaign's calendar setting, passed through verbatim.
    #[serde(default)]
    pub calendar: Option<Value>,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub name: String,
    pub joined_at: String,
    pub last_seen: String,
    /// The bearer token, so the GM's own UI can refer to this connection.
    pub token: String,
    /// Present when the app joined (a browser joins without a key).
    pub device: Option<ConnectedDevice>,
    /// Set once the device is paired with a player in the campaign.
    pub player_id: Option<String>,
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

pub type Players = Arc<Mutex<HashMap<String, Player>>>;

#[derive(Debug, Deserialize)]
pub struct JoinRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub device: Option<DeviceProof>,
}

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
}

#[derive(Clone)]
struct Served {
    app: AppHandle,
    code: String,
    players: Players,
    /// Flips to true when the GM stops hosting.
    closing: watch::Receiver<bool>,
    spotlight: watch::Receiver<Spotlight>,
    /// Outstanding challenge nonces and when they were issued.
    nonces: Arc<Mutex<HashMap<String, Instant>>>,
}

/// A running server; dropping the stop sender ends it.
pub struct Running {
    pub port: u16,
    pub players: Players,
    pub stop: watch::Sender<bool>,
    pub spotlight: watch::Sender<Spotlight>,
}

/// Binds a free port on every interface and serves until `stop` is sent.
pub async fn start(app: AppHandle, code: String) -> Result<Running, String> {
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", 0))
        .await
        .map_err(|e| format!("could not open a port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let players: Players = Arc::default();
    let (stop, mut stop_rx) = watch::channel(false);
    let (spotlight, spotlight_rx) = watch::channel(Spotlight::default());

    let served = Served {
        app,
        code,
        players: players.clone(),
        closing: stop_rx.clone(),
        spotlight: spotlight_rx,
        nonces: Arc::default(),
    };
    let router = Router::new()
        .route("/", get(player_page))
        .route("/marked.umd.js", get(player_script))
        .route("/icon.png", get(player_icon))
        .route("/api/table", get(table_info))
        .route("/api/challenge", get(challenge))
        .route("/api/join", post(join))
        .route("/api/elements", get(elements))
        .route("/api/elements/{id}", get(element))
        .route("/api/elements/{id}/sheet", put(update_sheet))
        .route("/api/assets/{*path}", get(asset))
        .route("/api/version", get(version))
        .with_state(served);

    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            // Ends when stop is set to true or the sender is dropped.
            while !*stop_rx.borrow() {
                if stop_rx.changed().await.is_err() {
                    break;
                }
            }
        };
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
        {
            eprintln!("table server stopped with error: {e}");
        }
    });

    Ok(Running {
        port,
        players,
        stop,
        spotlight,
    })
}

// ---- The phone page ------------------------------------------------------

const PLAYER_PAGE: &str = include_str!("../../web/player.html");
const PLAYER_SCRIPT: &str = include_str!("../../web/marked.umd.js");
const PLAYER_ICON: &[u8] = include_bytes!("../../icons/128x128.png");

async fn player_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        PLAYER_PAGE,
    )
        .into_response()
}

async fn player_script() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        PLAYER_SCRIPT,
    )
        .into_response()
}

async fn player_icon() -> Response {
    ([(header::CONTENT_TYPE, "image/png")], PLAYER_ICON).into_response()
}

// ---- Handlers -------------------------------------------------------------

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn storage_error(e: crate::storage::StorageError) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn info_of(app: &AppHandle) -> Result<TableInfo, ApiError> {
    let state = app.state::<AppState>();
    let meta = state.current_campaign().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "the GM has no campaign open".to_owned(),
        )
    })?;
    Ok(TableInfo {
        name: meta.name,
        system: meta.system,
        calendar: meta.extra.get("calendar").cloned(),
        version: state.version(),
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Checks the bearer token and records that the player is still around.
/// Who is asking: checks the bearer token, records the player as seen, and
/// returns their name and (when paired) player id.
fn authed(s: &Served, headers: &HeaderMap) -> Result<Who, ApiError> {
    if *s.closing.borrow() {
        return Err(ApiError(StatusCode::GONE, CLOSED_MESSAGE.to_owned()));
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    let mut players = s.players.lock().map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "player list poisoned".to_owned(),
        )
    })?;
    match players.get_mut(token) {
        Some(p) => {
            p.last_seen = now();
            Ok(Who {
                name: p.name.clone(),
                player_id: p.player_id.clone(),
            })
        }
        None => Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "not joined to this table".to_owned(),
        )),
    }
}

/// A joined connection's identity, as the sharing rules see it.
struct Who {
    name: String,
    player_id: Option<String>,
}

impl Who {
    fn viewer(&self) -> Viewer<'_> {
        Viewer {
            name: &self.name,
            player_id: self.player_id.as_deref(),
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
    Ok(Json(info_of(&s.app)?))
}

async fn join(
    State(s): State<Served>,
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

    if known.is_none() {
        let code = req.code.as_deref().map(str::trim).unwrap_or("");
        if code.is_empty() {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "this device is new to the GM: enter the join code".to_owned(),
            ));
        }
        if code != s.code {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "wrong join code".to_owned(),
            ));
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
        None => typed.to_owned(),
    };
    if let Some(p) = &known {
        let _ = players::touch(&state, &p.id);
    }

    let info = info_of(&s.app)?;
    let token = uuid::Uuid::new_v4().to_string();
    let stamp = now();
    let player_id = known.as_ref().map(|p| p.id.clone());
    s.players.lock().map_err(|_| poisoned())?.insert(
        token.clone(),
        Player {
            name: name.clone(),
            joined_at: stamp.clone(),
            last_seen: stamp,
            token: token.clone(),
            device,
            player_id: player_id.clone(),
        },
    );
    Ok(Json(JoinResponse {
        token,
        info,
        name,
        recognized: known.is_some(),
        player_id,
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
    let content_type = match path.rsplit('.').next().map(str::to_ascii_lowercase) {
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        Some(ext) if ext == "webp" => "image/webp",
        Some(ext) if ext == "gif" => "image/gif",
        _ => "application/octet-stream",
    };
    Ok(([(header::CONTENT_TYPE, content_type)], bytes).into_response())
}

/// A player updating the sheet of the character the GM assigned to them.
async fn update_sheet(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(sheet): Json<Value>,
) -> Result<Json<Element>, ApiError> {
    let who = authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    match share::update_sheet(&state, &id, &who.viewer(), sheet).map_err(storage_error)? {
        Some(e) => Ok(Json(e)),
        None => Err(ApiError(
            StatusCode::FORBIDDEN,
            "this character is not yours to edit".to_owned(),
        )),
    }
}

/// Answers as soon as the campaign changes past `after`, or after a while
/// with the current version so clients can simply loop.
async fn version(
    State(s): State<Served>,
    headers: HeaderMap,
    Query(q): Query<AfterQuery>,
) -> Result<Json<VersionResponse>, ApiError> {
    authed(&s, &headers)?;
    let mut rx = s.app.state::<AppState>().changes();
    let mut closing = s.closing.clone();
    let mut spot_rx = s.spotlight.clone();
    let deadline = tokio::time::sleep(LONG_POLL);
    tokio::pin!(deadline);
    let respond = |version: u64, spot: Spotlight, closed: bool| {
        Ok(Json(VersionResponse {
            version,
            closed,
            spotlight: spot.element,
            spotlight_seq: spot.seq,
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
