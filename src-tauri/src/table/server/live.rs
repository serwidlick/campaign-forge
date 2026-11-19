//! HTTPS table transport. Every WebSocket starts with a fresh authorized view.
use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum_server::tls_rustls::RustlsConfig;
/// The stream retains only the previous authorized view. Reconnection always
/// starts with a replacement snapshot, including after host or role changes.
#[derive(Default)]
struct PlayerView(HashMap<String, [u8; 32]>);

impl PlayerView {
    fn update(&mut self, entries: Vec<(ElementSummary, String)>, reset: bool) -> PlayerDelta {
        let mut next = HashMap::with_capacity(entries.len());
        let mut upserts = Vec::new();
        for (summary, version) in entries {
            // A link or map pin can change visibility without its own file changing.
            let mut digest = Sha256::new();
            digest.update(version.as_bytes());
            digest.update(serde_json::to_vec(&summary).expect("serializable summary"));
            let stamp = digest.finalize().into();
            let id = summary.meta.id.clone();
            if reset || self.0.get(&id) != Some(&stamp) {
                upserts.push(summary);
            }
            next.insert(id, stamp);
        }
        let removed = self
            .0
            .keys()
            .filter(|id| !next.contains_key(*id))
            .cloned()
            .collect();
        self.0 = next;
        PlayerDelta {
            reset,
            upserts,
            removed,
        }
    }
}

/// TLS is opt-in during the migration. Partial configuration fails closed.
pub(super) async fn load_tls() -> Result<Option<(String, RustlsConfig)>, String> {
    let host = std::env::var_os("CAMPAIGN_FORGE_TLS_HOST");
    let cert = std::env::var_os("CAMPAIGN_FORGE_TLS_CERT");
    let key = std::env::var_os("CAMPAIGN_FORGE_TLS_KEY");
    if host.is_none() && cert.is_none() && key.is_none() {
        return Ok(None);
    }
    let (Some(host), Some(cert), Some(key)) = (host, cert, key) else {
        return Err("secure hosting requires CAMPAIGN_FORGE_TLS_HOST, CAMPAIGN_FORGE_TLS_CERT and CAMPAIGN_FORGE_TLS_KEY".into());
    };
    let host = host
        .into_string()
        .map_err(|_| "invalid TLS hostname")?
        .to_ascii_lowercase();
    let valid = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    });
    if !valid || host.len() > 253 {
        return Err("CAMPAIGN_FORGE_TLS_HOST must be the certificate hostname".into());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = RustlsConfig::from_pem_file(cert, key)
        .await
        .map_err(|e| format!("could not load the table TLS certificate and key: {e}"))?;
    Ok(Some((host, config)))
}

#[derive(Default)]
pub(super) struct Tickets(HashMap<String, (String, Instant)>);

impl Tickets {
    fn issue(&mut self, token: &str, now: Instant) -> Option<String> {
        self.0.retain(|_, (_, expiry)| *expiry > now);
        if self.0.len() >= 1024 || self.0.values().filter(|(seat, _)| seat == token).count() >= 8 {
            return None;
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        self.0.insert(
            ticket.clone(),
            (token.to_owned(), now + Duration::from_secs(20)),
        );
        Some(ticket)
    }
    fn take(&mut self, ticket: &str, now: Instant) -> Option<String> {
        self.0
            .remove(ticket)
            .filter(|(_, expiry)| *expiry > now)
            .map(|(token, _)| token)
    }
}

pub(super) async fn issue_ticket<R: tauri::Runtime>(
    State(s): State<Served<R>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    authed(&s, &headers)?;
    let token = headers[header::AUTHORIZATION]
        .to_str()
        .unwrap_or("")
        .trim_start_matches("Bearer ")
        .trim();
    let ticket = s
        .tickets
        .lock()
        .map_err(|_| poisoned())?
        .issue(token, Instant::now())
        .ok_or_else(|| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "too many pending table connections".into(),
            )
        })?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "ticket": ticket })),
    )
        .into_response())
}

pub(super) async fn upgrade<R: tauri::Runtime>(
    State(s): State<Served<R>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if let Some(origin) = headers.get(header::ORIGIN)
        && request_origin(&s.origins, &headers)
            .is_none_or(|expected| origin.as_bytes() != expected.as_bytes())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "unexpected table origin".into(),
        ));
    }
    let ws = ws
        .protocols([LIVE_PROTOCOL])
        .max_message_size(4096)
        .max_frame_size(4096);
    if ws.selected_protocol().is_none() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unsupported table protocol".into(),
        ));
    }
    let permit = s
        .handshakes
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "table busy".into()))?;
    Ok(ws.on_upgrade(move |mut socket| async move {
        let Ok(Some(Ok(Message::Text(text)))) =
            tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
        else {
            return;
        };
        #[derive(Deserialize)]
        struct Hello {
            ticket: String,
            #[serde(default)]
            player: bool,
        }
        let Ok(hello) = serde_json::from_str::<Hello>(&text) else {
            return;
        };
        let token = s
            .tickets
            .lock()
            .ok()
            .and_then(|mut t| t.take(&hello.ticket, Instant::now()));
        drop(permit);
        if let Some(token) = token {
            live(s, socket, token, hello.player).await;
        }
    }))
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn live<R: tauri::Runtime>(
    s: Served<R>,
    mut socket: WebSocket,
    token: String,
    player_view: bool,
) {
    let state = s.app.state::<AppState>();
    let mut versions = state.changes();
    let mut spots = s.spotlight.clone();
    let mut closed = s.closing.clone();
    let mut view = PlayerView::default();
    let mut identity = None;
    let mut previous_version = 0;
    let mut previous_spot = None;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.tick().await;
    let mut last_pong = Instant::now();
    loop {
        if *closed.borrow() || closed.has_changed().is_err() {
            let _ = send(
                &mut socket,
                Message::Text(r#"{"closed":true,"version":0,"spotlightSeq":0,"gm":false}"#.into()),
            )
            .await;
            break;
        }
        let current = *versions.borrow_and_update();
        let mut who = match authorize(&s, &token, false) {
            Ok(who) => who,
            Err(_) => break,
        };
        if player_view {
            who.gm = false;
        }
        let spot = spots.borrow_and_update().clone();
        let key = (who.gm, who.player_id.clone(), who.name.clone());
        let reset = identity.as_ref() != Some(&key);
        let changed = current != previous_version;
        let mut delta = None;
        if !who.gm && (reset || changed) {
            let Ok(entries) = share::shared_versions(&state, Some(&who.viewer())) else {
                break;
            };
            let update = view.update(entries, reset);
            if reset || !update.upserts.is_empty() || !update.removed.is_empty() {
                delta = Some(update);
            }
        }
        let spotlight = spot.element.filter(|id| who.gm || view.0.contains_key(id));
        let visible_spot = spotlight.map(|id| (spot.seq, id));
        let spotlight_changed = previous_spot != visible_spot;
        if reset || delta.is_some() || (who.gm && changed) || spotlight_changed {
            let response = VersionResponse {
                version: current,
                gm: who.gm,
                player_id: who.player_id,
                delta,
                spotlight: visible_spot.as_ref().map(|(_, id)| id.clone()),
                spotlight_seq: spot.seq,
                changes: who.gm.then(|| {
                    if reset {
                        DiskChanges::everything()
                    } else {
                        state.changes_since(previous_version)
                    }
                }),
                closed: false,
            };
            let Ok(json) = serde_json::to_string(&response) else {
                break;
            };
            // A permission or content change raced projection. Rebuild from the
            // new revision before sending, replacing the unacknowledged view.
            if state.version() != current || spots.has_changed().unwrap_or(false) {
                identity = None;
                continue;
            }
            if !send(&mut socket, Message::Text(json.into())).await {
                break;
            }
        }
        previous_spot = visible_spot;
        identity = Some(key);
        previous_version = current;
        tokio::select! {
            result = versions.changed() => { if result.is_err() { break; } }
            result = spots.changed() => { if result.is_err() { break; } }
            _ = closed.changed() => {}
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Pong(_))) => {
                    if authorize(&s, &token, true).is_err() { break; }
                    last_pong = Instant::now();
                }
                _ => break,
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(45) || !send(&mut socket, Message::Text("heartbeat".into())).await || !send(&mut socket, Message::Ping(Bytes::new())).await { break; }
            }
        }
    }
}

#[cfg(test)]
mod tests;
