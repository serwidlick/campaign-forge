//! Publishes who is at the table. One task per hosted table owns every
//! snapshot and publication, so an older view can never overwrite a newer
//! one. Sockets subscribe to the latest value; the local GM window gets the
//! same value as a Tauri event.

use super::*;
use std::sync::PoisonError;
use tauri::Emitter;
use tokio::sync::Notify;

/// How long someone whose last socket closed stays on the roster as
/// disconnected.
pub(super) const ROSTER_GRACE: Duration = Duration::from_secs(60);

/// Tauri event carrying the roster to the hosting GM's window.
const ROSTER_EVENT: &str = "table://roster";

pub struct RosterHub {
    tx: watch::Sender<Vec<share::RosterEntry>>,
    wake: Notify,
    grace: Duration,
    /// Added to the clock; only tests move it, to step past the grace period
    /// without waiting for it.
    skew: std::sync::Mutex<Duration>,
    /// When the hosting GM went idle (Unix ms), as their own window reports.
    host_away_since: std::sync::Mutex<Option<u64>>,
}

impl RosterHub {
    pub(super) fn new(grace: Duration) -> Self {
        Self {
            tx: watch::channel(Vec::new()).0,
            wake: Notify::new(),
            grace,
            skew: std::sync::Mutex::default(),
            host_away_since: std::sync::Mutex::default(),
        }
    }

    /// The hosting GM's window says they went idle, or came back. Away keeps
    /// the time it started, so a repeated report does not reset it.
    pub fn set_host_away(&self, away: bool) {
        {
            let mut since = self
                .host_away_since
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *since = if away {
                since.or_else(|| Some(unix_ms()))
            } else {
                None
            };
        }
        self.wake();
    }

    /// The roster's clock: the real one, plus any test skew.
    fn now(&self) -> Instant {
        Instant::now() + *self.skew.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Moves the roster's clock forward and rebuilds.
    #[cfg(test)]
    pub(super) fn advance(&self, by: Duration) {
        *self.skew.lock().unwrap_or_else(PoisonError::into_inner) += by;
        self.wake();
    }

    /// Asks the roster task to rebuild. Never lost: a wake with nobody
    /// waiting is kept for the task's next wait.
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// The roster as last published.
    pub fn current(&self) -> Vec<share::RosterEntry> {
        self.tx.borrow().clone()
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<Vec<share::RosterEntry>> {
        self.tx.subscribe()
    }

    pub(super) fn grace(&self) -> Duration {
        self.grace
    }
}

/// Rebuilds on presence changes, campaign changes (players, GM flags and the
/// GM's name live in `campaign.json`), disconnected entries expiring, and stops
/// when the table closes. Element saves (autosave included) bump the same
/// change counter but cannot change the roster, so they cost no rebuild.
pub(super) async fn run<R: tauri::Runtime>(s: Served<R>) {
    let mut changes = s.app.state::<AppState>().changes();
    let mut seen = *changes.borrow_and_update();
    let mut closing = s.closing.clone();
    let mut expiry = None;
    let mut rebuild = true;
    loop {
        if *closing.borrow_and_update() {
            break;
        }
        if rebuild {
            expiry = publish(&s);
        }
        rebuild = true;
        let expired = async {
            match expiry {
                Some(at) => {
                    tokio::time::sleep(at.saturating_duration_since(s.roster.now())).await;
                }
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = s.roster.wake.notified() => {}
            result = changes.changed() => {
                if result.is_err() {
                    break;
                }
                let now = *changes.borrow_and_update();
                rebuild = s
                    .app
                    .state::<AppState>()
                    .changes_since(seen)
                    .campaign_changed;
                seen = now;
            }
            result = closing.changed() => {
                if result.is_err() {
                    break;
                }
            }
            () = expired => {}
        }
    }
}

/// Builds the roster from the seats and the campaign and publishes it if it
/// changed. Returns when the next disconnected entry expires.
///
/// The seats lock is held while the roster is built and handed to the
/// message hub, so no seat can change (a reconnect, a pairing) between the
/// snapshot and ending the conversations of anyone it no longer lists. The
/// order is seats, then hub, as everywhere.
///
/// The campaign (the player registry and the GM's name) is read first,
/// outside the seats lock: reading it waits on storage, which a settings
/// save holds while it writes, and joins and message commands must not
/// wait on that. A pairing saves the registry before it changes the seat
/// and then wakes this task, so a registry read a moment early is followed
/// at once by a build with the new one.
fn publish<R: tauri::Runtime>(s: &Served<R>) -> Option<Instant> {
    let state = s.app.state::<AppState>();
    let registry = players::load(&state);
    let gm_name = state.current_campaign().and_then(|meta| {
        meta.extra
            .get("gmName")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let seats_guard = s.players.lock().unwrap_or_else(PoisonError::into_inner);
    let seats: Vec<share::RosterSeat> = seats_guard.values().map(Player::roster_seat).collect();
    let host = share::RosterHost {
        name: gm_name.as_deref(),
        away_since: *s
            .roster
            .host_away_since
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
    };
    let (roster, expiry) =
        share::build_roster(&seats, &registry, host, s.roster.grace, s.roster.now());
    // Before anyone sees this roster, end the conversations of everyone it
    // no longer lists.
    s.messages.set_present(&roster);
    drop(seats_guard);
    let changed = s.roster.tx.send_if_modified(|current| {
        if *current == roster {
            return false;
        }
        current.clone_from(&roster);
        true
    });
    if changed {
        let _ = s.app.emit(ROSTER_EVENT, &roster);
    }
    expiry
}

/// Counts one live socket for a seat for as long as it is held. Dropping it,
/// on any exit path, counts the socket closed.
pub(super) struct PresenceGuard<R: tauri::Runtime> {
    s: Served<R>,
    token: String,
    /// Set when the socket is found dead: the last time it was heard from.
    lost_at: Option<Instant>,
}

impl<R: tauri::Runtime> PresenceGuard<R> {
    /// `None` when the seat is gone: removed after its ticket was issued, by
    /// a guest taking over its name or the GM unpairing its device.
    pub(super) fn register(s: &Served<R>, token: &str) -> Option<Self> {
        {
            let mut seats = s.players.lock().unwrap_or_else(PoisonError::into_inner);
            let seat = seats.get_mut(token)?;
            seat.presence.sockets += 1;
            seat.presence
                .first_connected
                .get_or_insert_with(Instant::now);
            seat.online = true;
        }
        s.roster.wake();
        Some(Self {
            s: s.clone(),
            token: token.to_owned(),
            lost_at: None,
        })
    }

    /// The socket went silent at `at` (its last pong) and is only now
    /// found dead. Its grace, and with it the hold on its name, counts from
    /// then, not from when the host noticed: otherwise a phone that was
    /// simply switched off would keep its name for two minutes.
    pub(super) fn lost_at(&mut self, at: Instant) {
        self.lost_at = Some(at);
    }
}

impl<R: tauri::Runtime> Drop for PresenceGuard<R> {
    fn drop(&mut self) {
        {
            // A poisoned lock still holds the seats; never lose a decrement.
            let mut seats = self
                .s
                .players
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(seat) = seats.get_mut(&self.token) {
                seat.presence.sockets = seat.presence.sockets.saturating_sub(1);
                if seat.presence.sockets == 0 {
                    let closed = self.lost_at.unwrap_or_else(Instant::now);
                    // Another socket of theirs may have closed later.
                    seat.presence.last_closed =
                        Some(seat.presence.last_closed.map_or(closed, |c| c.max(closed)));
                    seat.online = false;
                }
            }
        }
        self.s.roster.wake();
    }
}
