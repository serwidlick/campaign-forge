//! HTTPS table transport. Every WebSocket starts with a fresh authorized view.
use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum_server::tls_rustls::RustlsConfig;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicU64, Ordering};

use super::messages::{ChatAck, ChatView, Command, Outgoing, Refusal};

/// Largest frame a device may send: a maximum message after JSON escaping,
/// with room for its fields.
const MAX_INCOMING: usize = 8 * 1024;

/// Each live socket's id, for its typing lease. 0 is the hosting window.
static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);
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
    let token = bearer(&headers);
    authorize(&s, token, true)?;
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
        && request_origin(s.secure, &headers)
            .is_none_or(|expected| origin.as_bytes() != expected.as_bytes())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "unexpected table origin".into(),
        ));
    }
    let ws = ws
        .protocols([LIVE_PROTOCOL])
        .max_message_size(MAX_INCOMING)
        .max_frame_size(MAX_INCOMING);
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
    // Count this socket for as long as the loop runs. A seat removed since
    // its ticket was issued gets nothing.
    let Some(mut presence) = super::roster::PresenceGuard::register(&s, &token) else {
        return;
    };
    let state = s.app.state::<AppState>();
    // Reconcile missed external edits before taking the first snapshot.
    let app = s.app.clone();
    if !matches!(
        tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().refresh_table()).await,
        Ok(Ok(()))
    ) {
        return;
    }
    let mut versions = state.changes();
    let mut spots = s.spotlight.clone();
    let mut closed = s.closing.clone();
    let mut roster = s.roster.subscribe();
    let mut chat_revision = s.messages.subscribe();
    let socket_id = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
    // What this socket has been told about its person's conversations, and
    // answers to its sends still to go out.
    let mut chat_view = ChatView::default();
    let mut acks: Vec<ChatAck> = Vec::new();
    // The first frame always carries the roster.
    let mut roster_due = true;
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
        // The epoch is part of who this is: a re-pairing, even back to the
        // same player, starts the chats over with a fresh snapshot.
        let key = (who.gm, who.player_id.clone(), who.name.clone(), who.epoch);
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
        let send_roster = reset || roster_due;
        // A new identity (pairing) starts the conversations over: the next
        // frame carries the new person's whole set.
        if reset {
            chat_view.reset();
        }
        let chat = s
            .messages
            .frame_for(&who.roster_key, &mut chat_view, Instant::now());
        if reset
            || delta.is_some()
            || (who.gm && changed)
            || spotlight_changed
            || send_roster
            || !chat.is_empty()
            || !acks.is_empty()
        {
            let response = TableChange {
                version: current,
                gm: who.gm,
                player_id: who.player_id,
                delta,
                spotlight: visible_spot.as_ref().map(|(_, id)| id.clone()),
                spotlight_seq: spot.seq,
                // Only when files moved: an empty note would still make a GM
                // window run its change handlers.
                changes: (who.gm && (reset || changed)).then(|| {
                    if reset {
                        DiskChanges::everything()
                    } else {
                        state.changes_since(previous_version)
                    }
                }),
                closed: false,
                roster: send_roster.then(|| roster.borrow_and_update().clone()),
                server_time: send_roster.then(super::unix_ms),
                you: send_roster.then(|| who.roster_key.clone()),
                epoch: send_roster.then_some(who.epoch),
                chats: chat.chats,
                acks: (!acks.is_empty()).then(|| std::mem::take(&mut acks)),
                typing: chat.typing,
                message_rules: chat.rules,
            };
            let Ok(json) = serde_json::to_string(&response) else {
                break;
            };
            // A permission or content change raced projection. Rebuild from the
            // new revision before sending, replacing the unacknowledged view.
            // The conversations start over too (a snapshot), and the acks
            // wait for the next frame.
            if state.version() != current || spots.has_changed().unwrap_or(false) {
                identity = None;
                if let Some(pending) = response.acks {
                    acks = pending;
                }
                continue;
            }
            if !send(&mut socket, Message::Text(json.into())).await {
                break;
            }
            if send_roster {
                roster_due = false;
            }
        }
        previous_spot = visible_spot;
        identity = Some(key);
        previous_version = current;
        tokio::select! {
            result = versions.changed() => { if result.is_err() { break; } }
            result = spots.changed() => { if result.is_err() { break; } }
            result = roster.changed() => {
                if result.is_err() { break; }
                roster_due = true;
            }
            result = chat_revision.changed() => { if result.is_err() { break; } }
            _ = closed.changed() => {}
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Pong(_))) => {
                    if authorize(&s, &token, true).is_err() { break; }
                    last_pong = Instant::now();
                }
                Some(Ok(Message::Text(text))) => {
                    // Anything that is not a command ends the socket, as any
                    // stray message always has.
                    let Ok(command) = serde_json::from_str::<Command>(&text) else { break; };
                    if let Some(ack) = handle_command(&s, &token, socket_id, &mut chat_view, command) {
                        acks.push(ack);
                    }
                }
                _ => break,
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(45) {
                    // Silent since its last pong: gone since then.
                    presence.lost_at(last_pong);
                    break;
                }
                if !send(&mut socket, Message::Text("heartbeat".into())).await || !send(&mut socket, Message::Ping(Bytes::new())).await { break; }
            }
        }
    }
    // Whatever this socket was typing ends with it.
    s.messages.drop_socket(socket_id);
}

/// Runs one message command from a socket, under its seat's identity right
/// now. The seats lock is held across the hub call (seats, then hub), so a
/// pairing cannot slip in between the epoch check and the change it guards.
fn handle_command<R: tauri::Runtime>(
    s: &Served<R>,
    token: &str,
    socket: u64,
    view: &mut ChatView,
    command: Command,
) -> Option<ChatAck> {
    let seats = s.players.lock().unwrap_or_else(PoisonError::into_inner);
    // A seat removed meanwhile: the socket closes on its next check.
    let seat = seats.get(token)?;
    let key = share::roster::person_key(seat.player_id.as_deref(), &seat.roster_key);
    let stale = command.epoch() != seat.epoch;
    let now = Instant::now();
    match command {
        Command::Send {
            to,
            cid,
            client_id,
            text,
            ..
        } => Some(if stale {
            Refusal::IdentityChanged.ack(&client_id)
        } else {
            s.messages.send(
                socket,
                &key,
                Outgoing {
                    to: &to,
                    cid: cid.as_deref(),
                    client_id: &client_id,
                    text: &text,
                },
                now,
                super::unix_ms(),
            )
        }),
        Command::Typing { to, on, .. } => {
            // Stopping is always allowed: the lease belongs to the socket.
            if !on || !stale {
                s.messages.typing(socket, &key, &to, on && !stale, now);
            }
            None
        }
        Command::Seen { cid, seq, .. } => {
            if !stale {
                s.messages.seen(view, &key, &cid, seq, now);
            }
            None
        }
    }
}

#[cfg(test)]
mod tests;
