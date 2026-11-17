//! Playing at a table over the local network.
//!
//! The GM hosts: a small HTTP server ([`server`]) hands out the shared parts
//! of the open campaign, announced with mDNS ([`discovery`]). Players join
//! from their own copy of the app ([`client`]) with the six-digit code the GM
//! reads out. [`share`] decides what "shared" means, for the server and for
//! the GM's own preview alike. A player the GM has marked as a GM gets the
//! whole campaign instead ([`gm`]): the GM's own second machine at the table.

mod client;
mod discovery;
mod gm;
pub mod players;
mod server;
pub mod share;

use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;

use crate::storage::{AppState, Element, ElementSummary};

pub use client::SessionInfo;
pub use discovery::FoundTable;
pub use server::{Player, VersionResponse};

/// Everything about hosting and joining, managed by Tauri.
#[derive(Default)]
pub struct TableState {
    host: Mutex<Option<Host>>,
    client: Mutex<Option<client::Session>>,
    browser: Mutex<Option<discovery::Browser>>,
}

struct Host {
    port: u16,
    code: String,
    addresses: Vec<String>,
    /// `forge.local` while the mDNS announcement is up, so browsers can use
    /// a name instead of an IP.
    host_name: Option<String>,
    players: server::Players,
    stop: watch::Sender<bool>,
    spotlight: watch::Sender<server::Spotlight>,
    /// Kept alive while hosting; dropping it unregisters the service.
    _registration: Option<discovery::Registration>,
    announce_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub port: u16,
    pub code: String,
    /// `ip:port` pairs players can type if discovery fails.
    pub addresses: Vec<String>,
    /// mDNS name browsers can open instead of an IP, when announced.
    pub host_name: Option<String>,
    pub players: Vec<Player>,
    /// Set when the table is up but could not be announced on the network.
    pub announce_error: Option<String>,
    /// Element currently shown to everyone, if any.
    pub spotlight: Option<String>,
}

impl Host {
    fn status(&self) -> HostStatus {
        let mut players: Vec<Player> = self
            .players
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        players.sort_by(|a, b| a.joined_at.cmp(&b.joined_at));
        HostStatus {
            port: self.port,
            code: self.code.clone(),
            addresses: self.addresses.clone(),
            host_name: self.host_name.clone(),
            players,
            announce_error: self.announce_error.clone(),
            spotlight: self.spotlight.borrow().element.clone(),
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

type CommandResult<T> = Result<T, String>;

fn lock<T>(m: &Mutex<T>) -> CommandResult<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| "table state poisoned".to_owned())
}

/// Six digits from a fresh UUID. Not cryptography; it keeps the neighbours
/// out, which is all a living-room table needs.
fn join_code() -> String {
    let bytes = uuid::Uuid::new_v4();
    let n = u32::from_le_bytes([
        bytes.as_bytes()[0],
        bytes.as_bytes()[1],
        bytes.as_bytes()[2],
        bytes.as_bytes()[3],
    ]);
    format!("{:06}", n % 1_000_000)
}

// ---- Hosting --------------------------------------------------------------

#[tauri::command]
pub async fn table_start_hosting(
    app: AppHandle,
    table: State<'_, TableState>,
) -> CommandResult<HostStatus> {
    let meta = app
        .state::<AppState>()
        .current_campaign()
        .ok_or_else(|| "open a campaign before hosting a table".to_owned())?;
    if let Some(existing) = lock(&table.host)?.as_ref() {
        return Ok(existing.status());
    }
    let code = join_code();
    let running = server::start(app.clone(), code.clone()).await?;
    let ips = discovery::lan_ipv4_addresses();
    let addresses = ips
        .iter()
        .map(|ip| format!("{ip}:{}", running.port))
        .collect();
    let (registration, announce_error) =
        match discovery::register(&meta.name, meta.system.as_deref(), &ips, running.port) {
            Ok(r) => (Some(r), None),
            Err(e) => (None, Some(e)),
        };
    let host = Host {
        port: running.port,
        code,
        addresses,
        host_name: registration
            .is_some()
            .then(|| discovery::HOST_NAME.to_owned()),
        players: running.players,
        stop: running.stop,
        spotlight: running.spotlight,
        _registration: registration,
        announce_error,
    };
    let status = host.status();
    *lock(&table.host)? = Some(host);
    Ok(status)
}

#[tauri::command]
pub fn table_stop_hosting(table: State<'_, TableState>) -> CommandResult<()> {
    // Dropping the host stops the server and unregisters the service.
    *lock(&table.host)? = None;
    Ok(())
}

impl TableState {
    /// Called when the app is quitting: tell waiting players the table
    /// closed and give the server a moment to deliver that before the
    /// process goes away.
    pub fn shutdown(&self) {
        let had_players = {
            let Ok(mut guard) = self.host.lock() else {
                return;
            };
            let had = guard
                .as_ref()
                .is_some_and(|h| h.players.lock().map(|p| !p.is_empty()).unwrap_or(false));
            *guard = None;
            had
        };
        if had_players {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
}

impl TableState {
    pub fn host_status(&self) -> CommandResult<Option<HostStatus>> {
        Ok(lock(&self.host)?.as_ref().map(Host::status))
    }

    /// Shows an element on every player's screen (`None` clears it).
    pub fn set_spotlight(&self, id: Option<String>) -> CommandResult<HostStatus> {
        let guard = lock(&self.host)?;
        let host = guard
            .as_ref()
            .ok_or_else(|| "not hosting a table".to_owned())?;
        host.spotlight.send_modify(|s| {
            s.seq += 1;
            s.element = id;
        });
        Ok(host.status())
    }

    /// Pairs a connected device with a player: an existing one (`player_id`)
    /// or a new one named `name`. From then on that device joins without a
    /// code and counts as that player for audiences and character ownership.
    pub fn bind_device(
        &self,
        app: &AppHandle,
        token: &str,
        player_id: Option<&str>,
        name: Option<&str>,
    ) -> CommandResult<HostStatus> {
        let guard = lock(&self.host)?;
        let host = guard
            .as_ref()
            .ok_or_else(|| "not hosting a table".to_owned())?;
        let (device, join_name) = {
            let players = host
                .players
                .lock()
                .map_err(|_| "player list poisoned".to_owned())?;
            let p = players
                .get(token)
                .ok_or_else(|| "that connection is gone".to_owned())?;
            let d = p.device.clone().ok_or_else(|| {
                "that device cannot be paired (it joined from a browser)".to_owned()
            })?;
            (d, p.name.clone())
        };
        let state = app.state::<AppState>();
        let record = players::bind_device(
            &state,
            player_id,
            name.unwrap_or(&join_name),
            players::PlayerDevice {
                fingerprint: device.fingerprint,
                public_key: device.public_key,
                label: device.label,
                added_at: String::new(),
            },
        )
        .map_err(|e| e.to_string())?;
        if let Ok(mut players) = host.players.lock()
            && let Some(p) = players.get_mut(token)
        {
            p.player_id = Some(record.id.clone());
            p.name = record.name.clone();
            p.gm = record.gm;
        }
        Ok(host.status())
    }
}

/// Shows an element on every player's screen (`None` clears the spotlight).
#[tauri::command]
pub fn table_spotlight(
    table: State<'_, TableState>,
    id: Option<String>,
) -> CommandResult<HostStatus> {
    table.set_spotlight(id)
}

#[tauri::command]
pub fn table_bind_device(
    app: AppHandle,
    table: State<'_, TableState>,
    token: String,
    player_id: Option<String>,
    name: Option<String>,
) -> CommandResult<HostStatus> {
    table.bind_device(&app, &token, player_id.as_deref(), name.as_deref())
}

/// The campaign's players and their paired devices.
#[tauri::command]
pub fn table_players(app: AppHandle) -> CommandResult<Vec<players::PlayerRecord>> {
    Ok(players::load(&app.state::<AppState>()))
}

#[tauri::command]
pub fn table_host_status(table: State<'_, TableState>) -> CommandResult<Option<HostStatus>> {
    table.host_status()
}

// ---- Discovery ------------------------------------------------------------

/// Starts browsing (idempotent) and returns what has been found so far.
#[tauri::command]
pub fn table_discover(table: State<'_, TableState>) -> CommandResult<Vec<FoundTable>> {
    let mut guard = lock(&table.browser)?;
    if guard.is_none() {
        *guard = Some(discovery::Browser::start()?);
    }
    Ok(guard.as_ref().map(|b| b.tables()).unwrap_or_default())
}

#[tauri::command]
pub fn table_discover_stop(table: State<'_, TableState>) -> CommandResult<()> {
    *lock(&table.browser)? = None;
    Ok(())
}

// ---- Joining --------------------------------------------------------------

#[tauri::command]
pub async fn table_join(
    table: State<'_, TableState>,
    address: String,
    name: String,
    code: Option<String>,
) -> CommandResult<SessionInfo> {
    let session = client::Session::join(&address, &name, code.as_deref()).await?;
    let info = session.summary();
    *lock(&table.client)? = Some(session);
    Ok(info)
}

#[tauri::command]
pub fn table_leave(table: State<'_, TableState>) -> CommandResult<()> {
    *lock(&table.client)? = None;
    Ok(())
}

/// The joined table, if any; lets the frontend re-attach after a reload.
#[tauri::command]
pub fn table_session(table: State<'_, TableState>) -> CommandResult<Option<SessionInfo>> {
    Ok(lock(&table.client)?.as_ref().map(client::Session::summary))
}

fn session(table: &TableState) -> CommandResult<client::Session> {
    lock(&table.client)?
        .clone()
        .ok_or_else(|| "not joined to a table".to_owned())
}

#[tauri::command]
pub async fn table_fetch_elements(
    table: State<'_, TableState>,
) -> CommandResult<Vec<ElementSummary>> {
    session(&table)?.elements().await
}

#[tauri::command]
pub async fn table_fetch_element(
    table: State<'_, TableState>,
    id: String,
) -> CommandResult<Option<Element>> {
    session(&table)?.element(&id).await
}

#[tauri::command]
pub async fn table_update_sheet(
    table: State<'_, TableState>,
    id: String,
    sheet: serde_json::Value,
) -> CommandResult<Element> {
    session(&table)?.update_sheet(&id, sheet).await
}

#[tauri::command]
pub async fn table_fetch_asset(
    table: State<'_, TableState>,
    path: String,
) -> CommandResult<tauri::ipc::Response> {
    let bytes = session(&table)?.asset(&path).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn table_wait_for_change(
    table: State<'_, TableState>,
    after: u64,
    event: u64,
) -> CommandResult<VersionResponse> {
    session(&table)?.wait_for_change(after, event).await
}

// ---- Working as a GM from another machine ---------------------------------

/// Runs one of the GM's storage or table commands on the hosting machine.
/// `command` and `args` are exactly what the frontend would hand `invoke`
/// locally; the answer is the command's result as JSON.
#[tauri::command]
pub async fn table_gm_call(
    table: State<'_, TableState>,
    command: String,
    args: Value,
) -> CommandResult<Value> {
    session(&table)?.gm_call(&command, args).await
}

/// Any asset of the hosted campaign, shared or not.
#[tauri::command]
pub async fn table_gm_asset(
    table: State<'_, TableState>,
    path: String,
) -> CommandResult<tauri::ipc::Response> {
    let bytes = session(&table)?.gm_asset(&path).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Imports a file from this machine's disk into the hosted campaign:
/// `kind` is `map` or `image` (with the element `id`) or `document`.
#[tauri::command]
pub async fn table_gm_import(
    table: State<'_, TableState>,
    kind: String,
    id: Option<String>,
    source: String,
) -> CommandResult<Value> {
    session(&table)?
        .gm_import(&kind, id.as_deref(), &source)
        .await
}
