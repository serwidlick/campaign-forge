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

async fn receive(socket: &mut ClientSocket) -> VersionResponse {
    let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(frame.to_text().unwrap()).unwrap()
}

async fn connect(
    origin: &str,
    http: &reqwest::Client,
    connector: Option<Connector>,
    token: &str,
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
            json!({"ticket": ticket["ticket"], "player": true})
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
    let (_stop, closing) = watch::channel(false);
    let (spot, spotlight) = watch::channel(Spotlight {
        seq: 1,
        element: Some(visible.meta.id.clone()),
    });
    let served = Arc::new(ServerState {
        origins: browser_origins(
            secure.then_some(origin.as_str()),
            listener.local_addr().unwrap().port(),
            &[],
        ),
        app: app.handle().clone(),
        code: "123456".into(),
        players: Arc::default(),
        nonces: Arc::default(),
        failures: Arc::default(),
        tickets: Arc::default(),
        handshakes: Arc::new(tokio::sync::Semaphore::new(4)),
        closing,
        spotlight,
    });
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
    let joined: JoinResponse = http
        .post(format!("{origin}/api/join"))
        .json(&json!({"name":"Mira","code":"123456"}))
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
    let mut socket = connect(&origin, &http, connector.clone(), &joined.token).await;
    let first = receive(&mut socket).await;
    assert_eq!(first.spotlight.as_ref(), Some(&visible.meta.id));
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
    let mut socket = connect(&origin, &http, connector.clone(), &joined.token).await;
    let next = receive(&mut socket).await.delta.unwrap();
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
    task.abort();
}
