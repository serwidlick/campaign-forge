//! The player's side: talks to a GM's table server. All networking stays in
//! Rust so the webview never needs network permissions of its own.

use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, watch};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

use crate::storage::{Element, ElementSummary, MAX_DOCUMENT_BYTES};

use crate::identity::{DeviceKey, device_label};

use super::server::{Challenge, JoinResponse, TableInfo, VersionResponse};
use super::share::NoteInput;

/// Error text the frontend recognises as "the table closed".
pub const CLOSED_ERROR: &str = "TABLE_CLOSED";

/// How long a GM's file upload may take on a slow Wi-Fi.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// A joined table. Cheap to clone; the HTTP client is reference counted.
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone)]
pub struct Session {
    http: reqwest::Client,
    live: Arc<Mutex<Option<Socket>>>,
    stop: watch::Sender<bool>,
    base: String,
    token: String,
    pub info: TableInfo,
    pub address: String,
    pub player_name: String,
    pub player_id: Option<String>,
    pub recognized: bool,
    pub gm: bool,
}

/// What the frontend keeps about the joined table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub address: String,
    pub player_name: String,
    pub player_id: Option<String>,
    pub recognized: bool,
    /// This device belongs to a GM: show the GM view, fed from the table.
    pub gm: bool,
    pub info: TableInfo,
}

fn normalise(address: &str) -> String {
    let trimmed = address.trim().trim_end_matches('/');
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        return trimmed.to_owned();
    }
    format!("http://{trimmed}")
}

async fn describe(resp: reqwest::Response) -> String {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return "TABLE_UNAUTHORIZED".to_owned();
    }
    if status == reqwest::StatusCode::GONE {
        return CLOSED_ERROR.to_owned();
    }
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    body.get("error")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("the table answered {status}"))
}

fn connection_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "the table did not answer in time".to_owned()
    } else if e.is_connect() {
        "could not reach the table (same Wi-Fi? firewall on the GM's machine?)".to_owned()
    } else {
        e.to_string()
    }
}

impl Session {
    pub async fn join(
        address: &str,
        player_name: &str,
        code: Option<&str>,
    ) -> Result<Session, String> {
        let base = normalise(address);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Long enough for the version long-poll, which answers within 25 s.
            .timeout(Duration::from_secs(40))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;

        // Prove this device: sign the nonce the table hands out.
        let challenge: Challenge = {
            let resp = http
                .get(format!("{base}/api/challenge"))
                .send()
                .await
                .map_err(connection_error)?;
            if !resp.status().is_success() {
                return Err(describe(resp).await);
            }
            resp.json().await.map_err(|e| e.to_string())?
        };
        let key = DeviceKey::load_or_create()?;
        let device = serde_json::json!({
            "publicKey": key.public_key_b64(),
            "label": device_label(),
            "nonce": challenge.nonce,
            "signature": key.sign_b64(challenge.nonce.as_bytes()),
        });

        let resp = http
            .post(format!("{base}/api/join"))
            .json(&serde_json::json!({
                "name": player_name,
                "code": code,
                "device": device,
            }))
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        let joined: JoinResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(Session {
            http,
            live: Arc::default(),
            stop: watch::channel(false).0,
            base,
            token: joined.token,
            info: joined.info,
            address: address.trim().to_owned(),
            player_name: joined.name,
            player_id: joined.player_id,
            recognized: joined.recognized,
            gm: joined.gm,
        })
    }

    pub fn disconnect(&self) {
        self.stop.send_replace(true);
    }

    /// A reloaded webview needs a snapshot even when Rust still owns its old reader.
    pub fn restart_reader(&mut self) {
        self.disconnect();
        self.stop = watch::channel(false).0;
        self.live = Arc::default();
    }

    pub fn summary(&self) -> SessionInfo {
        SessionInfo {
            address: self.address.clone(),
            player_name: self.player_name.clone(),
            player_id: self.player_id.clone(),
            recognized: self.recognized,
            gm: self.gm,
            info: self.info.clone(),
        }
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .get(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
    }

    pub async fn elements(&self) -> Result<Vec<ElementSummary>, String> {
        let resp = self
            .get("/api/elements")
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn element(&self, id: &str) -> Result<Option<Element>, String> {
        let resp = self
            .get(&format!("/api/elements/{id}"))
            .send()
            .await
            .map_err(connection_error)?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map(Some).map_err(|e| e.to_string())
    }

    pub async fn asset(&self, path: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .get(&format!("/api/assets/{path}"))
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| e.to_string())
    }

    /// Saves the sheet of the character the GM assigned to this player.
    pub async fn update_sheet(
        &self,
        id: &str,
        sheet: serde_json::Value,
        base_version: &str,
    ) -> Result<Element, String> {
        let resp = self
            .http
            .put(format!("{}/api/elements/{id}/sheet", self.base))
            .bearer_auth(&self.token)
            .header("x-base-version", base_version)
            .json(&sheet)
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    // ---- Notes ------------------------------------------------------------

    /// Sends a JSON body and reads the element the table answers with.
    async fn send_element(
        &self,
        req: reqwest::RequestBuilder,
        input: &NoteInput,
    ) -> Result<Element, String> {
        let resp = req
            .bearer_auth(&self.token)
            .json(input)
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    /// Writes a new note into the GM's campaign folder, by this player.
    pub async fn create_note(&self, input: &NoteInput) -> Result<Element, String> {
        self.send_element(self.http.post(format!("{}/api/notes", self.base)), input)
            .await
    }

    /// Changes a note this player wrote.
    pub async fn update_note(&self, id: &str, input: &NoteInput) -> Result<Element, String> {
        self.send_element(
            self.http.put(format!("{}/api/notes/{id}", self.base)),
            input,
        )
        .await
    }

    /// Deletes a note this player wrote.
    pub async fn delete_note(&self, id: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(format!("{}/api/notes/{id}", self.base))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        Ok(())
    }

    // ---- A GM's device ----------------------------------------------------

    /// Runs a storage or table command on the hosting machine and returns
    /// its result as JSON. Only answered when the GM made this player a GM.
    pub async fn gm_call(&self, command: &str, args: Value) -> Result<Value, String> {
        let resp = self
            .http
            .post(format!("{}/api/gm/call", self.base))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "command": command, "args": args }))
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    /// Any asset of the hosted campaign.
    pub async fn gm_asset(&self, path: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .get(&format!("/api/gm/assets/{path}"))
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| e.to_string())
    }

    /// Reads a file on this machine and imports it into the hosted
    /// campaign: `kind` is `map` or `image` (for element `id`) or `document`.
    pub async fn gm_import(
        &self,
        kind: &str,
        id: Option<&str>,
        source: &str,
    ) -> Result<Value, String> {
        let path = Path::new(source).to_path_buf();
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_owned();
        let read = tauri::async_runtime::spawn_blocking(move || {
            let meta =
                std::fs::metadata(&path).map_err(|e| format!("could not read the file: {e}"))?;
            if meta.len() > MAX_DOCUMENT_BYTES {
                return Err(format!(
                    "file is too large ({} MB; limit is {} MB)",
                    meta.len() / (1024 * 1024),
                    MAX_DOCUMENT_BYTES / (1024 * 1024)
                ));
            }
            std::fs::read(&path).map_err(|e| format!("could not read the file: {e}"))
        });
        let bytes = read
            .await
            .map_err(|e| format!("reading was interrupted: {e}"))??;
        let mut query: Vec<(&str, &str)> = vec![("name", &name)];
        if let Some(id) = id {
            query.push(("id", id));
        }
        let resp = self
            .http
            .post(format!("{}/api/gm/upload/{kind}", self.base))
            .bearer_auth(&self.token)
            .query(&query)
            .timeout(UPLOAD_TIMEOUT)
            .body(bytes)
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }

    async fn connect_live(&self) -> Result<Socket, String> {
        let socket_url = match self.base.split_once("://") {
            Some(("http", address)) => format!("ws://{address}/api/live"),
            Some(("https", address)) => format!("wss://{address}/api/live"),
            _ => return Err("unsupported table URL".into()),
        };
        let response = self
            .http
            .post(format!("{}/api/live/ticket", self.base))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(connection_error)?;
        if !response.status().is_success() {
            return Err(describe(response).await);
        }
        #[derive(serde::Deserialize)]
        struct Ticket {
            ticket: String,
        }
        let ticket: Ticket = response.json().await.map_err(|e| e.to_string())?;
        let mut request = socket_url
            .into_client_request()
            .map_err(|e| e.to_string())?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            super::server::LIVE_PROTOCOL
                .parse()
                .expect("static protocol"),
        );
        let (mut socket, response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| e.to_string())?;
        if response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            != Some(super::server::LIVE_PROTOCOL)
        {
            return Err("unsupported table protocol".into());
        }
        let hello = serde_json::json!({ "ticket": ticket.ticket, "player": cfg!(any(target_os="android", target_os="ios")) });
        socket
            .send(Message::Text(hello.to_string().into()))
            .await
            .map_err(|e| e.to_string())?;
        Ok(socket)
    }

    async fn live_change(&self) -> Result<VersionResponse, String> {
        let mut stop = self.stop.subscribe();
        if *stop.borrow() {
            return Err(CLOSED_ERROR.into());
        }
        let mut guard = self.live.lock().await;
        tokio::select! {
            _ = stop.changed() => Err(CLOSED_ERROR.into()),
            result = async {
                // Taking the socket also drops it on any error or cancelled read.
                let mut socket = match guard.take() {
                    Some(s) => s,
                    None => tokio::time::timeout(Duration::from_secs(15), self.connect_live()).await.map_err(|_| "table connection timed out")??,
                };
                loop {
                    match tokio::time::timeout(Duration::from_secs(55), socket.next()).await
                        .map_err(|_| "table connection timed out")?.transpose().map_err(|e| e.to_string())? {
                        Some(Message::Text(text)) if text == "heartbeat" => {}
                        Some(Message::Text(text)) => {
                            let change = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                            *guard = Some(socket);
                            return Ok(change);
                        }
                        Some(Message::Ping(_)) => socket.flush().await.map_err(|e| e.to_string())?,
                        _ => return Err("table disconnected".into()),
                    }
                }
            } => result,
        }
    }

    pub async fn wait_for_change(&self, after: u64, event: u64) -> Result<VersionResponse, String> {
        if let Some(protocol) = &self.info.live_protocol {
            if protocol != super::server::LIVE_PROTOCOL {
                return Err("unsupported table protocol".into());
            }
            return self.live_change().await;
        }
        let resp = self
            .get(&format!("/api/version?after={after}&event={event}"))
            .send()
            .await
            .map_err(connection_error)?;
        if resp.status() == reqwest::StatusCode::GONE {
            return Ok(VersionResponse {
                version: after,
                closed: true,
                ..VersionResponse::default()
            });
        }
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        resp.json().await.map_err(|e| e.to_string())
    }
}
