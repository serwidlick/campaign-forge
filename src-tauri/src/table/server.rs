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
//! Everything but `/api/table` needs `Authorization: Bearer <token>`. The
//! token comes from `/api/join`, which checks the six-digit code the GM reads
//! out at the table. That is the whole security model: same Wi-Fi plus the
//! code. Fine for a living room, and we say so in the UI.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::storage::{AppState, Element, ElementSummary};

use super::share;

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
}

pub type Players = Arc<Mutex<HashMap<String, Player>>>;

#[derive(Debug, Deserialize)]
pub struct JoinRequest {
    pub name: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinResponse {
    pub token: String,
    pub info: TableInfo,
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
    };
    let router = Router::new()
        .route("/api/table", get(table_info))
        .route("/api/join", post(join))
        .route("/api/elements", get(elements))
        .route("/api/elements/{id}", get(element))
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
fn authed(s: &Served, headers: &HeaderMap) -> Result<(), ApiError> {
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
            Ok(())
        }
        None => Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "not joined to this table".to_owned(),
        )),
    }
}

async fn table_info(State(s): State<Served>) -> Result<Json<TableInfo>, ApiError> {
    Ok(Json(info_of(&s.app)?))
}

async fn join(
    State(s): State<Served>,
    Json(req): Json<JoinRequest>,
) -> Result<Json<JoinResponse>, ApiError> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "give yourself a name first".to_owned(),
        ));
    }
    if req.code.trim() != s.code {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "wrong join code".to_owned(),
        ));
    }
    let info = info_of(&s.app)?;
    let token = uuid::Uuid::new_v4().to_string();
    let stamp = now();
    s.players
        .lock()
        .map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "player list poisoned".to_owned(),
            )
        })?
        .insert(
            token.clone(),
            Player {
                name: name.to_owned(),
                joined_at: stamp.clone(),
                last_seen: stamp,
            },
        );
    Ok(Json(JoinResponse { token, info }))
}

async fn elements(
    State(s): State<Served>,
    headers: HeaderMap,
) -> Result<Json<Vec<ElementSummary>>, ApiError> {
    authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    share::shared_summaries(&state)
        .map(Json)
        .map_err(storage_error)
}

async fn element(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Element>, ApiError> {
    authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    match share::shared_element(&state, &id).map_err(storage_error)? {
        Some(e) => Ok(Json(e)),
        None => Err(ApiError(StatusCode::NOT_FOUND, "not shared".to_owned())),
    }
}

async fn asset(
    State(s): State<Served>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    authed(&s, &headers)?;
    let state = s.app.state::<AppState>();
    let allowed = share::shared_asset_paths(&state).map_err(storage_error)?;
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
