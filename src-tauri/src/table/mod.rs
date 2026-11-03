//! Playing at a table over the local network.
//!
//! The GM hosts: a small HTTP server ([`server`]) hands out the shared parts
//! of the open campaign, announced with mDNS ([`discovery`]). Players join
//! from their own copy of the app ([`client`]) with the six-digit code the GM
//! reads out. [`share`] decides what "shared" means, for the server and for
//! the GM's own preview alike.

mod client;
mod discovery;
mod server;
pub mod share;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;

use crate::storage::{AppState, Element, ElementSummary};

pub use client::SessionInfo;
pub use discovery::FoundTable;
pub use server::Player;

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
    players: server::Players,
    stop: watch::Sender<bool>,
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
    pub players: Vec<Player>,
    /// Set when the table is up but could not be announced on the network.
    pub announce_error: Option<String>,
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
            players,
            announce_error: self.announce_error.clone(),
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
        players: running.players,
        stop: running.stop,
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

#[tauri::command]
pub fn table_host_status(table: State<'_, TableState>) -> CommandResult<Option<HostStatus>> {
    Ok(lock(&table.host)?.as_ref().map(Host::status))
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
    code: String,
) -> CommandResult<SessionInfo> {
    let session = client::Session::join(&address, &name, &code).await?;
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
pub async fn table_fetch_asset(
    table: State<'_, TableState>,
    path: String,
) -> CommandResult<tauri::ipc::Response> {
    let bytes = session(&table)?.asset(&path).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn table_wait_for_change(table: State<'_, TableState>, after: u64) -> CommandResult<u64> {
    session(&table)?.wait_for_change(after).await
}
