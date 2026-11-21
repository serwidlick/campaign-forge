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

use crate::storage::{Element, MAX_DOCUMENT_BYTES};

use crate::identity::{DeviceKey, device_label};

use super::server::{Challenge, JoinResponse, TableChange, TableInfo};
use super::share::NoteInput;

/// Error text the frontend recognises as "the table closed".
pub const CLOSED_ERROR: &str = "TABLE_CLOSED";

/// How long a GM's file upload may take on a slow Wi-Fi.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// A joined table. Cheap to clone; the HTTP client is reference counted.
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type Reader = futures_util::stream::SplitStream<Socket>;
type Writer = futures_util::stream::SplitSink<Socket, Message>;

#[derive(Clone)]
pub struct Session {
    http: reqwest::Client,
    /// The live socket, split: `next_event` owns the read half while it
    /// waits, and the write half stays free for message commands, so a
    /// device can send while it is listening.
    live: Arc<Mutex<Option<Reader>>>,
    writer: Arc<Mutex<Option<Writer>>>,
    stop: watch::Sender<bool>,
    base: String,
    endpoints: Vec<std::net::SocketAddr>,
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

fn require_live_host(info: &TableInfo) -> Result<(), String> {
    if info.live_protocol.as_deref() == Some(super::server::LIVE_PROTOCOL) {
        return Ok(());
    }
    Err(
        "Update the GM’s host and your client to compatible WebSocket versions to join this table."
            .into(),
    )
}

impl Session {
    pub async fn join(
        address: &str,
        player_name: &str,
        code: Option<&str>,
        endpoints: Vec<std::net::SocketAddr>,
    ) -> Result<Session, String> {
        let base = normalise(address);
        let mut builder = reqwest::Client::builder();
        if !endpoints.is_empty() {
            let url = reqwest::Url::parse(&base).map_err(|e| e.to_string())?;
            let host = url.host_str().ok_or("missing table host")?;
            // Resolving here would let an untrusted TXT hostname redirect the join.
            builder = builder.no_proxy().resolve_to_addrs(host, &endpoints);
        }
        let http = builder
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(40))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;

        // Check the host before signing a challenge or creating a seat.
        let response = http
            .get(format!("{base}/api/table"))
            .send()
            .await
            .map_err(connection_error)?;
        if !response.status().is_success() {
            return Err(describe(response).await);
        }
        let host: TableInfo = response.json().await.map_err(|e| e.to_string())?;
        require_live_host(&host)?;

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
                "liveProtocol": super::server::LIVE_PROTOCOL,
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
        require_live_host(&joined.info)?;
        Ok(Session {
            http,
            live: Arc::default(),
            writer: Arc::default(),
            stop: watch::channel(false).0,
            base,
            endpoints,
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
        self.writer = Arc::default();
    }

    /// Sends one message command on the live socket. Fails while there is
    /// no socket (between reconnects); the page keeps the command and
    /// resends it once the next socket's snapshot is in.
    pub async fn send_live(&self, command: &Value) -> Result<(), String> {
        let text = command.to_string();
        if text.len() > 8 * 1024 {
            return Err("message too long".into());
        }
        let mut writer = self.writer.lock().await;
        let sink = writer.as_mut().ok_or("not connected to the table")?;
        tokio::time::timeout(
            Duration::from_secs(5),
            sink.send(Message::Text(text.into())),
        )
        .await
        .map_err(|_| "the table did not take the message in time")?
        .map_err(|e| e.to_string())
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

    /// Tells the host this device's user went idle, or came back.
    pub async fn report_presence(&self, away: bool) -> Result<(), String> {
        let resp = self
            .http
            .post(format!("{}/api/presence", self.base))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "away": away }))
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
        let (mut socket, response) = if self.endpoints.is_empty() {
            tokio_tungstenite::connect_async(request).await
        } else {
            let tcp = tokio::net::TcpStream::connect(&self.endpoints[..])
                .await
                .map_err(|e| e.to_string())?;
            tokio_tungstenite::client_async_tls(request, tcp).await
        }
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

    pub async fn next_event(&self) -> Result<TableChange, String> {
        let mut stop = self.stop.subscribe();
        if *stop.borrow() {
            return Err(CLOSED_ERROR.into());
        }
        let mut guard = self.live.lock().await;
        tokio::select! {
            _ = stop.changed() => Err(CLOSED_ERROR.into()),
            result = async {
                // Taking the socket also drops it on any error or cancelled read.
                let mut reader = match guard.take() {
                    Some(r) => r,
                    None => {
                        let socket = tokio::time::timeout(Duration::from_secs(15), self.connect_live()).await.map_err(|_| "table connection timed out")??;
                        let (writer, reader) = socket.split();
                        *self.writer.lock().await = Some(writer);
                        reader
                    }
                };
                loop {
                    match tokio::time::timeout(Duration::from_secs(55), reader.next()).await
                        .map_err(|_| "table connection timed out")?.transpose().map_err(|e| e.to_string())? {
                        Some(Message::Text(text)) if text == "heartbeat" => {}
                        Some(Message::Text(text)) => {
                            let change = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                            *guard = Some(reader);
                            return Ok(change);
                        }
                        // The pong is queued by the read; flushing the write
                        // half sends it.
                        Some(Message::Ping(_)) => {
                            if let Some(writer) = self.writer.lock().await.as_mut() {
                                writer.flush().await.map_err(|e| e.to_string())?;
                            }
                        }
                        _ => return Err("table disconnected".into()),
                    }
                }
            } => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A table whose live socket answers each command with a frame naming
    /// it, so a send can be seen to arrive while `next_event` is waiting.
    async fn echo_table() -> (String, tokio::task::JoinHandle<()>) {
        use axum::extract::ws::{Message as WsMessage, WebSocketUpgrade};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = axum::Router::new()
            .route(
                "/api/live/ticket",
                axum::routing::post(|| async { axum::Json(serde_json::json!({"ticket": "t"})) }),
            )
            .route(
                "/api/live",
                axum::routing::get(|ws: WebSocketUpgrade| async move {
                    ws.protocols([super::super::server::LIVE_PROTOCOL])
                        .on_upgrade(|mut socket| async move {
                            // The hello, then each command echoed back.
                            let _ = socket.recv().await;
                            while let Some(Ok(WsMessage::Text(text))) = socket.recv().await {
                                let command: Value = serde_json::from_str(&text).unwrap();
                                let frame = serde_json::json!({
                                    "version": 1,
                                    "acks": [{"clientId": command["clientId"]}],
                                });
                                let _ =
                                    socket.send(WsMessage::Text(frame.to_string().into())).await;
                            }
                        })
                }),
            );
        let task = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        (address, task)
    }

    fn session(address: &str) -> Session {
        Session {
            http: reqwest::Client::new(),
            live: Arc::default(),
            writer: Arc::default(),
            stop: watch::channel(false).0,
            base: format!("http://{address}"),
            endpoints: Vec::new(),
            token: "token".into(),
            info: TableInfo {
                live_protocol: None,
                name: "Echo".into(),
                system: None,
                calendar: None,
                version: 1,
                players: Vec::new(),
            },
            address: address.into(),
            player_name: "Mira".into(),
            player_id: None,
            recognized: false,
            gm: false,
        }
    }

    #[tokio::test]
    async fn a_device_can_send_while_it_is_listening() {
        let (address, task) = echo_table().await;
        let session = session(&address);
        // Not connected yet: nothing to send on.
        assert!(
            session
                .send_live(&serde_json::json!({"t": "x"}))
                .await
                .is_err()
        );
        let listening = tokio::spawn({
            let session = session.clone();
            async move { session.next_event().await }
        });
        // Once the reader has connected (and is waiting on a quiet table),
        // a command goes out and its answer is what the reader gets.
        let sent = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if session
                    .send_live(&serde_json::json!({"t": "send", "clientId": "m1"}))
                    .await
                    .is_ok()
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(sent.is_ok(), "the command never went out");
        let change = tokio::time::timeout(Duration::from_secs(10), listening)
            .await
            .expect("the reader got an answer")
            .unwrap()
            .unwrap();
        assert_eq!(change.acks.unwrap()[0].client_id, "m1");
        task.abort();
    }

    #[tokio::test]
    async fn an_older_host_returns_upgrade_guidance_before_joining() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = axum::Router::new().route(
            "/api/table",
            axum::routing::get(|| async {
                axum::Json(serde_json::json!({"name":"Old table","version":1}))
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let result = Session::join(&address, "Mira", Some("123456"), Vec::new()).await;
        assert!(matches!(result, Err(message) if message.contains("Update the GM")));
        // An unresolvable certificate name still reaches the discovered endpoint.
        let endpoint: std::net::SocketAddr = address.parse().unwrap();
        let alias = format!("http://table.invalid:{}", endpoint.port());
        let discovered = Session::join(&alias, "Mira", None, vec![endpoint]).await;
        assert!(matches!(discovered, Err(message) if message.contains("Update the GM")));
        task.abort();
    }
}
