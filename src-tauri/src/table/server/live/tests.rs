use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message as Frame, client::IntoClientRequest};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

#[test]
fn tickets_expire_and_can_only_be_consumed_once() {
    let now = Instant::now();
    let mut tickets = Tickets::default();
    let first = tickets.issue("seat", now).unwrap();
    let second_tab = tickets.issue("seat", now).unwrap();
    assert_eq!(tickets.take(&second_tab, now).as_deref(), Some("seat"));
    assert_eq!(tickets.take(&first, now).as_deref(), Some("seat"));
    assert!(tickets.take(&first, now).is_none());
    let expired = tickets.issue("seat", now).unwrap();
    assert!(
        tickets
            .take(&expired, now + Duration::from_secs(20))
            .is_none()
    );
}

type ClientSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn receive(socket: &mut ClientSocket) -> TableChange {
    let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(frame.to_text().unwrap()).unwrap()
}

/// Reads roster-only frames until the roster satisfies `done`, within one
/// overall deadline.
async fn roster_until(
    socket: &mut ClientSocket,
    mut roster: Vec<share::RosterEntry>,
    done: impl Fn(&[share::RosterEntry]) -> bool,
) -> Vec<share::RosterEntry> {
    let converge = async move {
        while !done(&roster) {
            let frame = receive(socket).await;
            assert!(frame.delta.is_none(), "expected a roster-only frame");
            assert!(
                frame.changes.is_none(),
                "a roster frame carries no file changes"
            );
            roster = frame
                .roster
                .expect("a frame with no other news carries the roster");
        }
        roster
    };
    tokio::time::timeout(Duration::from_secs(10), converge)
        .await
        .expect("the roster converged in time")
}

fn here(roster: &[share::RosterEntry], name: &str) -> bool {
    roster
        .iter()
        .any(|e| e.name == name && e.state == share::roster::RosterState::Active)
}

async fn connect(
    origin: &str,
    http: &reqwest::Client,
    connector: Option<Connector>,
    token: &str,
    player: bool,
) -> ClientSocket {
    let ticket: Value = http
        .post(format!("{origin}/api/live/ticket"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut request = format!("{}/api/live", origin.replacen("http", "ws", 1))
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("sec-websocket-protocol", LIVE_PROTOCOL.parse().unwrap());
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    let (mut socket, _) =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector)
            .await
            .unwrap();
    socket
        .send(Frame::Text(
            json!({"ticket": ticket["ticket"], "player": player})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    socket
}

#[tokio::test]
async fn trusted_table_reconnects_after_an_offline_unshare() {
    exercise_table(true).await;
}

#[tokio::test]
async fn plain_lan_table_reconnects_after_an_offline_unshare() {
    exercise_table(false).await;
}

async fn exercise_table(secure: bool) {
    let (tls, connector, http) = if secure {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let tls = RustlsConfig::from_pem(
            cert.cert.pem().into_bytes(),
            cert.signing_key.serialize_pem().into_bytes(),
        )
        .await
        .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert.cert.der().clone()).unwrap();
        let client_tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let connector = Connector::Rustls(Arc::new(client_tls));
        let http = reqwest::Client::builder()
            .no_proxy()
            .add_root_certificate(reqwest::Certificate::from_der(cert.cert.der()).unwrap())
            .build()
            .unwrap();
        (Some(tls), Some(connector), http)
    } else {
        (
            None,
            None,
            reqwest::Client::builder().no_proxy().build().unwrap(),
        )
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let scheme = if secure { "https" } else { "http" };
    let origin = format!("{scheme}://{address}");
    let app = tauri::test::mock_app();
    app.manage(AppState::default());
    let campaign = app.state::<AppState>();
    let folder = tempfile::tempdir().unwrap();
    campaign
        .create_campaign(
            folder.path().to_str().unwrap().to_owned(),
            "test".into(),
            None,
        )
        .unwrap();
    let visible = campaign
        .create_element(
            "character",
            "Scout",
            Some(serde_json::from_value(json!({"shared":true,"sheet":{"owner":"Mira"}})).unwrap()),
        )
        .unwrap();
    let hidden = campaign.create_element("location", "Secret", None).unwrap();
    let (stop, closing) = watch::channel(false);
    let (spot, spotlight) = watch::channel(Spotlight {
        seq: 1,
        element: Some(visible.meta.id.clone()),
    });
    let served = Arc::new(ServerState {
        secure,
        app: app.handle().clone(),
        code: "123456".into(),
        players: Arc::default(),
        nonces: Arc::default(),
        failures: Arc::default(),
        tickets: Arc::default(),
        handshakes: Arc::new(tokio::sync::Semaphore::new(4)),
        closing,
        spotlight,
        roster: Arc::new(RosterHub::new(Duration::from_secs(60))),
        messages: Arc::new(MessageHub::default()),
    });
    tokio::spawn(roster::run(served.clone()));
    let router = Router::new()
        .route("/api/join", post(join))
        .route("/api/live/ticket", post(issue_ticket))
        .route("/api/live", get(upgrade))
        .route("/api/elements/{id}/sheet", put(update_sheet))
        .with_state(served.clone());
    let service = router.into_make_service_with_connect_info::<SocketAddr>();
    let task = match tls {
        Some(config) => tokio::spawn(
            axum_server::from_tcp_rustls(listener, config)
                .unwrap()
                .serve(service),
        ),
        None => tokio::spawn(axum_server::from_tcp(listener).unwrap().serve(service)),
    };
    let mut foreign = format!("{}/api/live", origin.replacen("http", "ws", 1))
        .into_client_request()
        .unwrap();
    foreign
        .headers_mut()
        .insert("sec-websocket-protocol", LIVE_PROTOCOL.parse().unwrap());
    foreign
        .headers_mut()
        .insert("origin", "http://another-table.local".parse().unwrap());
    let denied =
        tokio_tungstenite::connect_async_tls_with_config(foreign, None, false, connector.clone())
            .await;
    assert!(
        matches!(denied, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
    );
    let incompatible = http
        .post(format!("{origin}/api/join"))
        .json(&json!({"name":"Mira","code":"123456"}))
        .send()
        .await
        .unwrap();
    assert_eq!(incompatible.status(), StatusCode::BAD_REQUEST);
    assert!(
        incompatible
            .text()
            .await
            .unwrap()
            .contains("Update your Campaign Forge client")
    );
    assert!(served.players.lock().unwrap().is_empty());
    let joined: JoinResponse = http
        .post(format!("{origin}/api/join"))
        .json(&json!({"name":"Mira","code":"123456", "liveProtocol":LIVE_PROTOCOL}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(joined.info.live_protocol.as_deref(), Some(LIVE_PROTOCOL));
    let record = players::bind_device(
        &campaign,
        None,
        "Mira",
        players::PlayerDevice {
            fingerprint: "test-device".into(),
            public_key: "test-key".into(),
            label: "test".into(),
            added_at: String::new(),
        },
    )
    .unwrap();
    {
        let mut players = served.players.lock().unwrap();
        let seat = players.get_mut(&joined.token).unwrap();
        seat.player_id = Some(record.id);
        seat.device = Some(ConnectedDevice {
            fingerprint: "test-device".into(),
            public_key: "test-key".into(),
            label: "test".into(),
        });
        assert_ne!(seat.connection_id, joined.token);
    }
    let mut socket = connect(&origin, &http, connector.clone(), &joined.token, true).await;
    let first = receive(&mut socket).await;
    assert_eq!(first.spotlight.as_ref(), Some(&visible.meta.id));
    roster_until(&mut socket, first.roster.clone().unwrap(), |r| {
        here(r, "Mira")
    })
    .await;
    let snapshot = first.delta.unwrap();
    assert!(snapshot.reset);
    assert_eq!(snapshot.upserts.len(), 1);
    assert_eq!(snapshot.upserts[0].meta.id, visible.meta.id);
    spot.send_replace(Spotlight {
        seq: 2,
        element: Some(hidden.meta.id.clone()),
    });
    let clear = receive(&mut socket).await;
    assert!(clear.spotlight.is_none());
    assert!(
        !serde_json::to_string(&clear)
            .unwrap()
            .contains(&hidden.meta.id)
    );
    socket.close(None).await.unwrap();
    let sheet_url = format!("{origin}/api/elements/{}/sheet", visible.meta.id);
    let save = || {
        http.put(&sheet_url)
            .bearer_auth(&joined.token)
            .json(&json!({"level":2}))
    };
    assert_eq!(
        save().send().await.unwrap().status(),
        StatusCode::PRECONDITION_REQUIRED
    );
    assert!(
        save()
            .header("x-base-version", &visible.version)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(
        save()
            .header("x-base-version", &visible.version)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let mut handout = campaign.read_element(&visible.meta.id).unwrap();
    handout.meta.extra.insert("shared".into(), json!(false));
    campaign
        .save_element(crate::storage::SaveElementInput {
            id: handout.meta.id,
            name: handout.meta.name,
            tags: handout.meta.tags,
            body: handout.body,
            extra: Some(handout.meta.extra),
            base_version: Some(handout.version),
        })
        .unwrap();
    let mut socket = connect(&origin, &http, connector.clone(), &joined.token, true).await;
    let reconnected = receive(&mut socket).await;
    roster_until(&mut socket, reconnected.roster.clone().unwrap(), |r| {
        here(r, "Mira")
    })
    .await;
    let next = reconnected.delta.unwrap();
    assert!(next.reset && next.upserts.is_empty());
    let shared = campaign
        .create_element(
            "location",
            "Harbor",
            Some(serde_json::from_value(json!({"shared":true})).unwrap()),
        )
        .unwrap();
    let update = receive(&mut socket).await.delta.unwrap();
    assert!(!update.reset);
    assert_eq!(update.upserts[0].meta.id, shared.meta.id);
    // Forget the paired device while its socket is still subscribed.
    players::save(&campaign, &[]).unwrap();
    spot.send_replace(Spotlight {
        seq: 3,
        element: Some(shared.meta.id),
    });
    let end = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap();
    assert!(!matches!(end, Some(Ok(Frame::Text(_)))));
    assert_eq!(
        http.post(format!("{origin}/api/live/ticket"))
            .bearer_auth(&joined.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let other: JoinResponse = http
        .post(format!("{origin}/api/join"))
        .json(&json!({"name":"Jules","code":"123456","liveProtocol":LIVE_PROTOCOL}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut active = connect(&origin, &http, connector, &other.token, true).await;
    let seated = receive(&mut active).await;
    assert!(seated.delta.unwrap().reset);
    roster_until(&mut active, seated.roster.unwrap(), |r| {
        here(r, "Jules") && r.len() == 2
    })
    .await;
    stop.send_replace(true);
    assert!(receive(&mut active).await.closed);
    task.abort();
}

/// A plain LAN table with a short roster grace period, for roster tests.
struct Table {
    origin: String,
    http: reqwest::Client,
    served: Served<tauri::test::MockRuntime>,
    app: tauri::App<tauri::test::MockRuntime>,
    stop: watch::Sender<bool>,
    /// Held so live sockets keep their spotlight channel open.
    _spotlight: watch::Sender<Spotlight>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    _folder: tempfile::TempDir,
}

/// Long enough that no test can see a seat expire by accident; tests step
/// past it with `RosterHub::advance` instead.
const TEST_GRACE: Duration = Duration::from_secs(60);

async fn plain_table() -> Table {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let origin = format!("http://127.0.0.1:{port}");
    let app = tauri::test::mock_app();
    app.manage(AppState::default());
    let folder = tempfile::tempdir().unwrap();
    app.state::<AppState>()
        .create_campaign(
            folder.path().to_str().unwrap().to_owned(),
            "test".into(),
            None,
        )
        .unwrap();
    let (stop, closing) = watch::channel(false);
    let (spotlight_tx, spotlight) = watch::channel(Spotlight::default());
    let served = Arc::new(ServerState {
        secure: false,
        app: app.handle().clone(),
        code: "123456".into(),
        players: Arc::default(),
        nonces: Arc::default(),
        failures: Arc::default(),
        tickets: Arc::default(),
        handshakes: Arc::new(tokio::sync::Semaphore::new(8)),
        closing,
        spotlight,
        roster: Arc::new(RosterHub::new(TEST_GRACE)),
        messages: Arc::new(MessageHub::default()),
    });
    tokio::spawn(roster::run(served.clone()));
    let router = Router::new()
        .route("/api/join", post(join))
        .route("/api/live/ticket", post(issue_ticket))
        .route("/api/live", get(upgrade))
        .route("/api/presence", post(report_presence))
        .with_state(served.clone());
    let service = router.into_make_service_with_connect_info::<SocketAddr>();
    let task = tokio::spawn(axum_server::from_tcp(listener).unwrap().serve(service));
    Table {
        origin,
        http: reqwest::Client::builder().no_proxy().build().unwrap(),
        served,
        app,
        stop,
        _spotlight: spotlight_tx,
        task,
        _folder: folder,
    }
}

impl Table {
    async fn join(&self, name: &str) -> reqwest::Response {
        self.http
            .post(format!("{}/api/join", self.origin))
            .json(&json!({"name": name, "code": "123456", "liveProtocol": LIVE_PROTOCOL}))
            .send()
            .await
            .unwrap()
    }

    async fn seat(&self, name: &str) -> JoinResponse {
        self.join(name)
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    /// Connects and reads frames until this table's roster satisfies `done`.
    async fn watch(
        &self,
        token: &str,
        player: bool,
        done: impl Fn(&[share::RosterEntry]) -> bool,
    ) -> (ClientSocket, TableChange) {
        let mut socket = connect(&self.origin, &self.http, None, token, player).await;
        let first = receive(&mut socket).await;
        roster_until(&mut socket, first.roster.clone().unwrap(), done).await;
        (socket, first)
    }

    /// Pairs a joined seat with a new player record, as the GM would.
    fn pair(&self, token: &str, name: &str, gm: bool) -> String {
        let campaign = self.app.state::<AppState>();
        let fingerprint = format!("device-{name}");
        let mut record = players::bind_device(
            &campaign,
            None,
            name,
            players::PlayerDevice {
                fingerprint: fingerprint.clone(),
                public_key: "key".into(),
                label: "label".into(),
                added_at: String::new(),
            },
        )
        .unwrap();
        if gm {
            let mut registry = players::load(&campaign);
            for r in &mut registry {
                if r.id == record.id {
                    r.gm = true;
                }
            }
            players::save(&campaign, &registry).unwrap();
            record.gm = true;
        }
        {
            let mut seats = self.served.players.lock().unwrap();
            let seat = seats.get_mut(token).unwrap();
            seat.player_id = Some(record.id.clone());
            seat.name.clone_from(&record.name);
            seat.gm = record.gm;
            seat.device = Some(ConnectedDevice {
                fingerprint,
                public_key: "key".into(),
                label: "label".into(),
            });
            seat.epoch += 1;
        }
        // As `Host::bind_device` does: the seat changed after the registry.
        self.served.roster.wake();
        self.served.messages.wake();
        record.id
    }

    async fn close(self) {
        self.stop.send_replace(true);
        self.task.abort();
    }
}

fn state_of(roster: &[share::RosterEntry], name: &str) -> Option<share::roster::RosterState> {
    roster.iter().find(|e| e.name == name).map(|e| e.state)
}

#[tokio::test]
async fn the_roster_follows_people_coming_and_going() {
    let table = plain_table().await;
    let ava = table.seat("Ava").await;
    let (mut a, first) = table
        .watch(&ava.token, true, |r| here(r, "Ava") && r.len() == 2)
        .await;
    let roster = first.roster.unwrap();
    assert_eq!(roster[0].key, "host");
    assert_eq!(roster[0].name, share::roster::DEFAULT_GM_NAME);

    let bo = table.seat("Bo").await;
    let mut b = connect(&table.origin, &table.http, None, &bo.token, true).await;
    let roster = roster_until(&mut a, roster, |r| here(r, "Bo")).await;
    assert_eq!(roster.len(), 3);
    assert!(roster[2].key.starts_with("guest:"));
    // Nothing private reaches the roster.
    let wire = serde_json::to_string(&roster).unwrap();
    for secret in [&bo.token, &ava.token] {
        assert!(!wire.contains(secret.as_str()));
    }
    for seat in table.served.players.lock().unwrap().values() {
        assert!(!wire.contains(&seat.connection_id));
    }

    // Bo's socket drops: away, then gone once the grace period ends.
    b.close(None).await.unwrap();
    let roster = roster_until(&mut a, roster, |r| {
        state_of(r, "Bo") == Some(share::roster::RosterState::Disconnected)
    })
    .await;
    // Past the grace period (stepped, not waited for), Bo is gone.
    table.served.roster.advance(TEST_GRACE);
    let roster = roster_until(&mut a, roster, |r| state_of(r, "Bo").is_none()).await;
    assert_eq!(roster.len(), 2);

    // The GM names themselves in the campaign settings.
    let campaign = table.app.state::<AppState>();
    let mut extra = campaign.current_campaign().unwrap().extra;
    extra.insert("gmName".into(), json!("Dungeon Dan"));
    campaign.update_campaign(None, None, Some(extra)).unwrap();
    roster_until(&mut a, roster, |r| r[0].name == "Dungeon Dan").await;
    table.close().await;
}

#[tokio::test]
async fn a_gm_socket_gets_roster_frames_without_file_changes() {
    let table = plain_table().await;
    let gm = table.seat("Ava").await;
    table.pair(&gm.token, "Ava", true);
    let (mut socket, first) = table
        .watch(&gm.token, false, |r| {
            r.iter()
                .any(|e| e.name == "Ava" && e.role == share::roster::RosterRole::Gm)
        })
        .await;
    assert!(first.gm);
    assert!(
        first.changes.is_some(),
        "a GM's first frame reloads everything"
    );
    let bo = table.seat("Bo").await;
    let _b = connect(&table.origin, &table.http, None, &bo.token, true).await;
    // `roster_until` asserts every frame on the way has no delta or changes.
    roster_until(&mut socket, first.roster.unwrap(), |r| here(r, "Bo")).await;

    // A GM socket reconnecting starts with the roster again.
    socket.close(None).await.unwrap();
    let (_socket, again) = table
        .watch(&gm.token, false, |r| here(r, "Bo") && here(r, "Ava"))
        .await;
    assert!(again.roster.is_some());
    table.close().await;
}

#[tokio::test]
async fn pairing_a_guest_changes_their_roster_entry() {
    let table = plain_table().await;
    let watcher_seat = table.seat("Watcher").await;
    let (mut watcher, first) = table
        .watch(&watcher_seat.token, true, |r| here(r, "Watcher"))
        .await;
    let cy = table.seat("Cy").await;
    let _c = connect(&table.origin, &table.http, None, &cy.token, true).await;
    let roster = roster_until(&mut watcher, first.roster.unwrap(), |r| {
        r.iter()
            .any(|e| e.name == "Cy" && e.role == share::roster::RosterRole::Guest)
    })
    .await;
    let id = table.pair(&cy.token, "Cy", false);
    let key = format!("player:{id}");
    roster_until(&mut watcher, roster, |r| {
        r.iter()
            .any(|e| e.key == key && e.role == share::roster::RosterRole::Player && e.name == "Cy")
            && !r
                .iter()
                .any(|e| e.role == share::roster::RosterRole::Guest && e.name == "Cy")
    })
    .await;
    table.close().await;
}

#[tokio::test]
async fn each_socket_is_told_which_roster_entry_is_its_own() {
    let table = plain_table().await;
    let cy = table.seat("Cy").await;
    let mut socket = connect(&table.origin, &table.http, None, &cy.token, true).await;
    let first = receive(&mut socket).await;
    let guest = first.you.clone().expect("the first frame says who you are");
    assert!(guest.starts_with("guest:"), "{guest}");
    // The key is the one the roster uses for this seat.
    roster_until(&mut socket, first.roster.unwrap(), |r| {
        r.iter().any(|e| e.key == guest && e.name == "Cy")
    })
    .await;
    // Paired mid-socket: the next roster frame names the new entry.
    let id = table.pair(&cy.token, "Cy", false);
    let paired = format!("player:{id}");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = receive(&mut socket).await;
            if frame.roster.is_some() {
                assert!(
                    frame.you.is_some(),
                    "a roster frame always says who you are"
                );
            } else {
                assert!(frame.you.is_none(), "only roster frames say who you are");
            }
            if frame.you.as_deref() == Some(paired.as_str()) {
                break;
            }
        }
    })
    .await
    .expect("told the paired key");
    table.close().await;
}

#[tokio::test]
async fn a_seat_removed_after_its_ticket_gets_no_presence() {
    let table = plain_table().await;
    let dee = table.seat("Dee").await;
    let ticket: Value = table
        .http
        .post(format!("{}/api/live/ticket", table.origin))
        .bearer_auth(&dee.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    table.served.players.lock().unwrap().remove(&dee.token);
    let mut request = format!("{}/api/live", table.origin.replacen("http", "ws", 1))
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("sec-websocket-protocol", LIVE_PROTOCOL.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(Frame::Text(
            json!({"ticket": ticket["ticket"], "player": true})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let end = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap();
    assert!(!matches!(end, Some(Ok(Frame::Text(_)))));
    assert!(table.served.players.lock().unwrap().is_empty());
    table.close().await;
}

#[tokio::test]
async fn simultaneous_joins_under_one_name_admit_exactly_one() {
    let table = plain_table().await;
    let (first, second) = tokio::join!(table.join("Eli"), table.join("ELI"));
    let mut statuses = [first.status(), second.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    assert_eq!(table.served.players.lock().unwrap().len(), 1);
    table.close().await;
}

#[tokio::test]
async fn presence_counts_every_socket_and_survives_a_poisoned_lock() {
    use super::super::roster::PresenceGuard;
    let table = plain_table().await;
    let fay = table.seat("Fay").await;
    let presence = |t: &Table| {
        t.served
            .players
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)[&fay.token]
            .presence
            .clone()
    };
    let one = PresenceGuard::register(&table.served, &fay.token).unwrap();
    let two = PresenceGuard::register(&table.served, &fay.token).unwrap();
    assert_eq!(presence(&table).sockets, 2);
    drop(one);
    assert_eq!(presence(&table).sockets, 1);
    assert!(presence(&table).last_closed.is_none());
    let seats = table.served.players.clone();
    let _ = std::thread::spawn(move || {
        let _held = seats.lock().unwrap();
        panic!("poison the seat list");
    })
    .join();
    drop(two);
    let after = presence(&table);
    assert_eq!(after.sockets, 0);
    assert!(after.last_closed.is_some());
    // The seat list stays poisoned; recover it so the table can close.
    table.served.players.clear_poison();
    table.close().await;
}

#[tokio::test]
async fn a_socket_found_dead_counts_as_closed_at_its_last_pong() {
    use super::super::roster::PresenceGuard;
    let table = plain_table().await;
    let gil = table.seat("Gil").await;
    let last_closed = |t: &Table| {
        t.served.players.lock().unwrap()[&gil.token]
            .presence
            .last_closed
    };
    let silent_since = Instant::now() - Duration::from_secs(50);
    let mut dead = PresenceGuard::register(&table.served, &gil.token).unwrap();
    dead.lost_at(silent_since);
    drop(dead);
    assert_eq!(last_closed(&table), Some(silent_since));
    // A later, ordinary close is not moved back by an older silent one.
    drop(PresenceGuard::register(&table.served, &gil.token).unwrap());
    let closed_now = last_closed(&table);
    assert!(closed_now > Some(silent_since));
    let mut stale = PresenceGuard::register(&table.served, &gil.token).unwrap();
    stale.lost_at(silent_since);
    drop(stale);
    assert_eq!(last_closed(&table), closed_now);
    table.close().await;
}

#[tokio::test]
async fn idle_reports_make_people_away_and_back() {
    use share::roster::RosterState;
    let table = plain_table().await;
    let ava = table.seat("Ava").await;
    let (mut a, first) = table.watch(&ava.token, true, |r| here(r, "Ava")).await;
    let roster = first.roster.unwrap();
    assert!(
        first.server_time.is_some(),
        "a roster frame carries the host clock"
    );
    let report = |away: bool| {
        table
            .http
            .post(format!("{}/api/presence", table.origin))
            .bearer_auth(&ava.token)
            .json(&json!({ "away": away }))
            .send()
    };
    assert_eq!(report(true).await.unwrap().status(), StatusCode::NO_CONTENT);
    let roster = roster_until(&mut a, roster, |r| {
        state_of(r, "Ava") == Some(RosterState::Away)
    })
    .await;
    let since = roster.iter().find(|e| e.name == "Ava").unwrap().away_since;
    assert!(since.is_some());
    // Saying so again keeps the original time.
    report(true).await.unwrap();
    assert_eq!(
        report(false).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let roster = roster_until(&mut a, roster, |r| here(r, "Ava")).await;
    assert!(roster.iter().all(|e| e.away_since.is_none()));
    // Without a seat there is nothing to report.
    let stranger = table
        .http
        .post(format!("{}/api/presence", table.origin))
        .bearer_auth("not-a-seat")
        .json(&json!({ "away": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(stranger.status(), StatusCode::UNAUTHORIZED);

    // The hosting GM's own window reports through the hub.
    table.served.roster.set_host_away(true);
    let roster = roster_until(&mut a, roster, |r| r[0].state == RosterState::Away).await;
    assert!(roster[0].away_since.is_some());
    table.served.roster.set_host_away(false);
    roster_until(&mut a, roster, |r| r[0].state == RosterState::Active).await;
    table.close().await;
}

#[test]
fn origin_and_csp_follow_the_address_used_by_the_browser() {
    for (secure, host, expected) in [
        (false, "GM-Laptop.lan:80", "http://gm-laptop.lan"),
        (true, "[::1]:47531", "https://[::1]:47531"),
        (false, "10.0.0.10:47530", "http://10.0.0.10:47530"),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        assert_eq!(request_origin(secure, &headers).as_deref(), Some(expected));
        assert!(
            socket_csp(page_csp(), secure, &headers).contains(&expected.replacen("http", "ws", 1))
        );
    }
    for host in ["bad;host", "user@host", "host/path", "host:65536"] {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        assert!(request_origin(false, &headers).is_none());
    }
}

// ---- Messages over the socket ------------------------------------------------

async fn command(socket: &mut ClientSocket, value: Value) {
    socket
        .send(Frame::Text(value.to_string().into()))
        .await
        .unwrap();
}

/// Reads frames until one satisfies `done`, within one deadline.
async fn frame_until(
    socket: &mut ClientSocket,
    done: impl Fn(&TableChange) -> bool,
) -> TableChange {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = receive(socket).await;
            if done(&frame) {
                return frame;
            }
        }
    })
    .await
    .expect("the expected frame never came")
}

/// Reads and discards whatever arrives until the socket goes quiet.
async fn drain(socket: &mut ClientSocket) {
    while tokio::time::timeout(Duration::from_millis(300), socket.next())
        .await
        .is_ok()
    {}
}

/// No frame at all arrives for a while.
async fn silent(socket: &mut ClientSocket) {
    let next = tokio::time::timeout(Duration::from_millis(600), socket.next()).await;
    assert!(next.is_err(), "expected no frame, got {next:?}");
}

/// A seat's socket, with its key and epoch from the first frame.
async fn open(table: &Table, token: &str) -> (ClientSocket, String, u64) {
    let mut socket = connect(&table.origin, &table.http, None, token, true).await;
    let first = receive(&mut socket).await;
    assert!(
        first.chats.as_ref().unwrap().snapshot,
        "the first frame is a snapshot"
    );
    (socket, first.you.unwrap(), first.epoch.unwrap())
}

/// Waits until the published roster has everyone in `all` here, then lets
/// each socket read the frames that brought it there.
async fn settle(table: &Table, all: &[&str], sockets: &mut [&mut ClientSocket]) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !all.iter().all(|n| here(&table.served.roster.current(), n)) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("everyone arrived");
    for socket in sockets {
        drain(socket).await;
    }
}

#[tokio::test]
async fn messages_travel_the_socket_to_the_two_people_only() {
    let table = plain_table().await;
    let (ava, bo, cy) = (
        table.seat("Ava").await,
        table.seat("Bo").await,
        table.seat("Cy").await,
    );
    let all = ["Ava", "Bo", "Cy"];
    let (mut a, _, a_epoch) = open(&table, &ava.token).await;
    let (mut b, b_key, _) = open(&table, &bo.token).await;
    let (mut c, _, _) = open(&table, &cy.token).await;
    settle(&table, &all, &mut [&mut a, &mut b, &mut c]).await;

    command(
        &mut b,
        json!({"t": "typing", "epoch": 0, "to": "nobody", "on": true}),
    )
    .await;
    command(
        &mut a,
        json!({"t": "typing", "epoch": a_epoch, "to": b_key, "on": true}),
    )
    .await;
    let typing = frame_until(&mut b, |f| f.typing.is_some()).await;
    assert_eq!(typing.typing.unwrap().len(), 1);
    command(
        &mut a,
        json!({"t": "typing", "epoch": a_epoch, "to": b_key, "on": false}),
    )
    .await;
    command(
        &mut a,
        json!({"t": "send", "epoch": a_epoch, "to": b_key, "clientId": "m1", "text": "  hello Bo  "}),
    )
    .await;
    let ack = frame_until(&mut a, |f| f.acks.is_some()).await;
    let ack = &ack.acks.unwrap()[0];
    assert_eq!(ack.client_id, "m1");
    assert!(ack.error.is_none(), "{ack:?}");
    let got = frame_until(&mut b, |f| {
        f.chats
            .as_ref()
            .is_some_and(|c| c.conversations.iter().any(|c| !c.messages.is_empty()))
    })
    .await;
    let conversation = &got.chats.unwrap().conversations[0];
    assert_eq!(conversation.messages[0].text, "hello Bo");
    assert_eq!(conversation.messages[0].client_id, None);
    assert_eq!(conversation.unread, 1);
    // Cy hears nothing of it: not a message, not typing, not an empty frame.
    silent(&mut c).await;
    table.close().await;
}

#[tokio::test]
async fn a_re_paired_device_cannot_send_as_who_it_was() {
    let table = plain_table().await;
    let (ava, bo) = (table.seat("Ava").await, table.seat("Bo").await);
    let all = ["Ava", "Bo"];
    let (mut a, _, a_epoch) = open(&table, &ava.token).await;
    let (mut _b, b_key, _) = open(&table, &bo.token).await;
    settle(&table, &all, &mut [&mut a, &mut _b]).await;
    table.pair(&ava.token, "Ava", false);
    command(
        &mut a,
        json!({"t": "send", "epoch": a_epoch, "to": b_key, "clientId": "old", "text": "hi"}),
    )
    .await;
    // The refusal, and the new identity with its new epoch and a fresh
    // snapshot, may come in one frame or two.
    let (mut refused, mut renewed) = (false, false);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !(refused && renewed) {
            let f = receive(&mut a).await;
            if let Some(acks) = &f.acks {
                assert_eq!(acks[0].error.as_deref(), Some("identity changed"));
                refused = true;
            }
            // The first frame under the new epoch starts the chats over;
            // later roster frames repeat the epoch without them.
            if !renewed && f.epoch.is_some_and(|e| e > a_epoch) {
                assert!(f.chats.as_ref().unwrap().snapshot);
                assert!(f.you.as_deref().unwrap().starts_with("player:"));
                renewed = true;
            }
        }
    })
    .await
    .expect("refused and renewed");
    table.close().await;
}

#[tokio::test]
async fn leaving_the_table_ends_the_conversation() {
    let table = plain_table().await;
    let (ava, bo) = (table.seat("Ava").await, table.seat("Bo").await);
    let all = ["Ava", "Bo"];
    let (mut a, _, a_epoch) = open(&table, &ava.token).await;
    let (mut b, b_key, _) = open(&table, &bo.token).await;
    settle(&table, &all, &mut [&mut a, &mut b]).await;
    command(
        &mut a,
        json!({"t": "send", "epoch": a_epoch, "to": b_key, "clientId": "m1", "text": "stay?"}),
    )
    .await;
    let ack = frame_until(&mut a, |f| f.acks.is_some()).await;
    let cid = ack.acks.unwrap()[0].cid.clone().unwrap();
    drop(b);
    // Past Bo's grace, the roster drops him and the conversation ends.
    tokio::time::sleep(Duration::from_millis(200)).await;
    table
        .served
        .roster
        .advance(TEST_GRACE + Duration::from_secs(1));
    let ended = frame_until(&mut a, |f| {
        f.chats
            .as_ref()
            .is_some_and(|c| c.conversations.iter().any(|c| c.ended && c.cid == cid))
    })
    .await;
    assert!(!ended.chats.unwrap().snapshot);
    // A late resend into it is refused.
    command(
        &mut a,
        json!({"t": "send", "epoch": a_epoch, "to": b_key, "cid": cid, "clientId": "m2", "text": "hello?"}),
    )
    .await;
    let ack = frame_until(&mut a, |f| f.acks.is_some()).await;
    assert!(ack.acks.unwrap()[0].error.is_some());
    table.close().await;
}

#[tokio::test]
async fn a_stray_frame_still_ends_the_socket() {
    let table = plain_table().await;
    let ava = table.seat("Ava").await;
    let (mut a, _, _) = open(&table, &ava.token).await;
    settle(&table, &["Ava"], &mut [&mut a]).await;
    command(&mut a, json!({"t": "shout", "text": "hi"})).await;
    let end = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match a.next().await {
                None | Some(Err(_)) | Some(Ok(Frame::Close(_))) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(end.is_ok(), "the socket stayed open");
    table.close().await;
}
