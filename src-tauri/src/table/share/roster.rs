//! Who is at the table, as everyone at it may see. The only projection of
//! seats that leaves the host: a display name, a role, a status (active,
//! away, disconnected) and, while away, since when. Tokens, connection ids
//! and devices never appear in it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::super::players::PlayerRecord;

/// Longest display name the roster sends, in Unicode scalar values.
pub const ROSTER_NAME_LIMIT: usize = 40;

/// What the hosting GM is called when the campaign does not name them.
pub const DEFAULT_GM_NAME: &str = "Game Master";

/// What someone is called when their name has nothing printable in it.
const FALLBACK_NAME: &str = "Player";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    /// Stable for the person while they are at the table: `host`,
    /// `player:<player id>` or `guest:<opaque id>`.
    pub key: String,
    pub name: String,
    pub role: RosterRole,
    pub state: RosterState,
    /// While `Away`: when they went idle, in Unix milliseconds on the host's
    /// clock. Clients show how long ago that was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_since: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RosterRole {
    Host,
    Gm,
    Player,
    Guest,
}

/// How someone is at the table. New states go here and in the clients'
/// status registry (`src/lib/presence/statuses.js`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RosterState {
    /// Connected and has used their device in the last few minutes.
    Active,
    /// Connected, but idle: their device reported no input for a while.
    Away,
    /// Their connection dropped moments ago; they may yet come back.
    Disconnected,
}

/// The hosting GM, who has no seat: their name and whether they are idle.
#[derive(Clone, Copy, Debug, Default)]
pub struct RosterHost<'a> {
    pub name: Option<&'a str>,
    pub away_since: Option<u64>,
}

/// One seat as the roster needs it, copied out of the host's seat list so
/// the roster never holds that lock while reading the campaign.
#[derive(Clone, Debug)]
pub struct RosterSeat {
    /// Opaque per-seat id for guests; never the bearer token.
    pub roster_key: String,
    /// The name the seat joined with.
    pub name: String,
    pub player_id: Option<String>,
    pub fingerprint: Option<String>,
    /// Open live sockets for this seat.
    pub sockets: u32,
    /// When the seat first opened a socket; `None` until it has.
    pub first_connected: Option<Instant>,
    /// When the seat's last socket closed, if it has none open.
    pub last_closed: Option<Instant>,
    /// When the seat's device reported going idle (Unix ms), if it is idle.
    pub away_since: Option<u64>,
}

struct Person {
    entry: RosterEntry,
    first: Instant,
    /// Some open seat is in use.
    active: bool,
    /// Some seat is open (connected), active or not.
    connected: bool,
    /// The latest idle start among open seats: away since the last device
    /// went quiet.
    away_since: Option<u64>,
    latest_close: Option<Instant>,
}

/// The public roster, plus the instant the next disconnected entry expires
/// so the caller can rebuild then. Host first, then people in the order they
/// first connected, so icons do not reshuffle as people come and go.
///
/// A person is active if any of their open seats is in use, away if every
/// open seat is idle, and disconnected if none is open but one closed within
/// the grace period.
pub fn build_roster(
    seats: &[RosterSeat],
    registry: &[PlayerRecord],
    host: RosterHost<'_>,
    grace: Duration,
    now: Instant,
) -> (Vec<RosterEntry>, Option<Instant>) {
    // Every seat that has ever connected counts towards its person's order,
    // even one long closed, so a person on two devices keeps their place
    // when one of them drops. How the person shows is decided once all their
    // seats are in.
    let mut people: HashMap<String, Person> = HashMap::new();
    for seat in seats {
        let Some(first) = seat.first_connected else {
            continue;
        };
        let open = seat.sockets > 0;
        let (key, name, role) = match &seat.player_id {
            Some(id) => {
                // An unpaired device keeps its seat until it next asks for
                // something; it must not linger here meanwhile.
                let Some(record) = registry.iter().find(|r| {
                    &r.id == id
                        && seat
                            .fingerprint
                            .as_ref()
                            .is_some_and(|fp| r.devices.iter().any(|d| &d.fingerprint == fp))
                }) else {
                    continue;
                };
                let role = if record.gm {
                    RosterRole::Gm
                } else {
                    RosterRole::Player
                };
                (format!("player:{id}"), record.name.clone(), role)
            }
            None => (
                format!("guest:{}", seat.roster_key),
                seat.name.clone(),
                RosterRole::Guest,
            ),
        };
        let person = people.entry(key.clone()).or_insert_with(|| Person {
            entry: RosterEntry {
                key,
                name: display_name(&name),
                role,
                state: RosterState::Disconnected,
                away_since: None,
            },
            first,
            active: false,
            connected: false,
            away_since: None,
            latest_close: None,
        });
        person.first = person.first.min(first);
        if open {
            person.connected = true;
            match seat.away_since {
                None => person.active = true,
                Some(since) => person.away_since = person.away_since.max(Some(since)),
            }
        } else {
            person.latest_close = person.latest_close.max(seat.last_closed);
        }
    }

    let mut next_expiry: Option<Instant> = None;
    let mut present: Vec<Person> = people
        .into_values()
        .filter_map(|mut p| {
            if p.active {
                p.entry.state = RosterState::Active;
                return Some(p);
            }
            if p.connected {
                p.entry.state = RosterState::Away;
                p.entry.away_since = p.away_since;
                return Some(p);
            }
            let closed = p.latest_close?;
            if now.saturating_duration_since(closed) >= grace {
                return None;
            }
            let expiry = closed + grace;
            next_expiry = Some(next_expiry.map_or(expiry, |e| e.min(expiry)));
            Some(p)
        })
        .collect();
    present.sort_by(|a, b| {
        a.first
            .cmp(&b.first)
            .then_with(|| a.entry.key.cmp(&b.entry.key))
    });

    let host = RosterEntry {
        key: "host".to_owned(),
        name: host
            .name
            .and_then(clean_name)
            .unwrap_or_else(|| DEFAULT_GM_NAME.to_owned()),
        role: RosterRole::Host,
        state: if host.away_since.is_some() {
            RosterState::Away
        } else {
            RosterState::Active
        },
        away_since: host.away_since,
    };
    let roster = std::iter::once(host)
        .chain(present.into_iter().map(|p| p.entry))
        .collect();
    (roster, next_expiry)
}

/// A name fit to show everyone: control characters dropped, whitespace runs
/// collapsed, and long names cut short. Only for display: the seat keeps the
/// name it joined with, which is what authorizes its notes.
pub fn display_name(name: &str) -> String {
    clean_name(name).unwrap_or_else(|| FALLBACK_NAME.to_owned())
}

/// `display_name`, or `None` when nothing printable is left.
fn clean_name(name: &str) -> Option<String> {
    let printable: String = name.chars().filter(|c| !c.is_control()).collect();
    let collapsed = printable.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= ROSTER_NAME_LIMIT {
        return Some(collapsed);
    }
    let mut cut: String = collapsed.chars().take(ROSTER_NAME_LIMIT - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    Some(cut)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::players::PlayerDevice;

    const GRACE: Duration = Duration::from_secs(60);

    fn guest(key: &str, name: &str, sockets: u32, first: Instant) -> RosterSeat {
        RosterSeat {
            roster_key: key.to_owned(),
            name: name.to_owned(),
            player_id: None,
            fingerprint: None,
            sockets,
            first_connected: Some(first),
            last_closed: None,
            away_since: None,
        }
    }

    fn paired(id: &str, fingerprint: &str, sockets: u32, first: Instant) -> RosterSeat {
        RosterSeat {
            roster_key: format!("seat-{fingerprint}"),
            name: "typed at join".to_owned(),
            player_id: Some(id.to_owned()),
            fingerprint: Some(fingerprint.to_owned()),
            sockets,
            first_connected: Some(first),
            last_closed: None,
            away_since: None,
        }
    }

    fn record(id: &str, name: &str, devices: &[&str], gm: bool) -> PlayerRecord {
        PlayerRecord {
            id: id.to_owned(),
            name: name.to_owned(),
            devices: devices
                .iter()
                .map(|fp| PlayerDevice {
                    fingerprint: (*fp).to_owned(),
                    public_key: "key".to_owned(),
                    label: "label".to_owned(),
                    added_at: String::new(),
                })
                .collect(),
            last_seen: None,
            gm,
        }
    }

    fn names(roster: &[RosterEntry]) -> Vec<&str> {
        roster.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn the_host_comes_first_under_the_campaign_gm_name() {
        let now = Instant::now();
        let (roster, expiry) = build_roster(&[], &[], RosterHost::default(), GRACE, now);
        assert_eq!(names(&roster), [DEFAULT_GM_NAME]);
        assert_eq!(roster[0].key, "host");
        assert_eq!(roster[0].role, RosterRole::Host);
        assert_eq!(roster[0].state, RosterState::Active);
        assert!(expiry.is_none());
        let seats = [guest("g1", "Tam", 1, now)];
        let (roster, _) = build_roster(
            &seats,
            &[],
            RosterHost {
                name: Some("  Ava "),
                away_since: None,
            },
            GRACE,
            now,
        );
        assert_eq!(names(&roster), ["Ava", "Tam"]);
        let blank = RosterHost {
            name: Some("\u{7}  "),
            away_since: None,
        };
        let (roster, _) = build_roster(&seats, &[], blank, GRACE, now);
        assert_eq!(roster[0].name, DEFAULT_GM_NAME);
    }

    #[test]
    fn a_paired_player_on_two_devices_is_one_person() {
        let now = Instant::now();
        let registry = [record("p1", "Mira", &["laptop", "phone"], false)];
        let seats = [
            paired("p1", "laptop", 0, now),
            paired("p1", "phone", 2, now + Duration::from_secs(1)),
        ];
        let (roster, _) = build_roster(&seats, &registry, RosterHost::default(), GRACE, now);
        assert_eq!(roster.len(), 2);
        assert_eq!(roster[1].key, "player:p1");
        assert_eq!(roster[1].name, "Mira");
        assert_eq!(roster[1].role, RosterRole::Player);
        assert_eq!(roster[1].state, RosterState::Active);
    }

    #[test]
    fn gm_standing_follows_the_registry() {
        let now = Instant::now();
        let registry = [record("p1", "Ava", &["laptop"], true)];
        let (roster, _) = build_roster(
            &[paired("p1", "laptop", 1, now)],
            &registry,
            RosterHost::default(),
            GRACE,
            now,
        );
        assert_eq!(roster[1].role, RosterRole::Gm);
    }

    #[test]
    fn unpaired_devices_and_unconnected_seats_are_left_out() {
        let now = Instant::now();
        let registry = [record("p1", "Mira", &["phone"], false)];
        let mut never_connected = guest("g1", "Tam", 0, now);
        never_connected.first_connected = None;
        let seats = [
            // The record no longer lists this device.
            paired("p1", "old-laptop", 1, now),
            // The record is gone.
            paired("p2", "tablet", 1, now),
            never_connected,
        ];
        let (roster, _) = build_roster(&seats, &registry, RosterHost::default(), GRACE, now);
        assert_eq!(names(&roster), [DEFAULT_GM_NAME]);
    }

    #[test]
    fn a_closed_seat_is_disconnected_during_the_grace_period_then_gone() {
        let start = Instant::now();
        let mut seat = guest("g1", "Tam", 0, start);
        let closed = start + Duration::from_secs(5);
        seat.last_closed = Some(closed);
        let (roster, expiry) = build_roster(
            std::slice::from_ref(&seat),
            &[],
            RosterHost::default(),
            GRACE,
            closed,
        );
        assert_eq!(roster[1].state, RosterState::Disconnected);
        assert_eq!(expiry, Some(closed + GRACE));
        let (roster, expiry) =
            build_roster(&[seat], &[], RosterHost::default(), GRACE, closed + GRACE);
        assert_eq!(roster.len(), 1);
        assert!(expiry.is_none());
    }

    #[test]
    fn a_person_is_here_while_any_seat_is_open() {
        let now = Instant::now();
        let registry = [record("p1", "Mira", &["laptop", "phone"], false)];
        let mut closed = paired("p1", "laptop", 0, now);
        closed.last_closed = Some(now);
        let seats = [closed, paired("p1", "phone", 1, now)];
        let (roster, expiry) = build_roster(&seats, &registry, RosterHost::default(), GRACE, now);
        assert_eq!(roster[1].state, RosterState::Active);
        assert!(expiry.is_none());
    }

    #[test]
    fn order_follows_first_connection_not_arrival_in_the_list() {
        let now = Instant::now();
        let seats = [
            guest("g2", "Second", 1, now + Duration::from_secs(2)),
            guest("g1", "First", 1, now),
            guest("g3", "Third", 1, now + Duration::from_secs(4)),
        ];
        let (roster, _) = build_roster(&seats, &[], RosterHost::default(), GRACE, now);
        assert_eq!(
            names(&roster),
            [DEFAULT_GM_NAME, "First", "Second", "Third"]
        );
    }

    #[test]
    fn guest_keys_are_the_opaque_roster_key() {
        let now = Instant::now();
        let (roster, _) = build_roster(
            &[guest("4b0c-opaque", "Tam", 1, now)],
            &[],
            RosterHost::default(),
            GRACE,
            now,
        );
        assert_eq!(roster[1].key, "guest:4b0c-opaque");
        assert_eq!(roster[1].role, RosterRole::Guest);
    }

    #[test]
    fn names_are_cleaned_for_display_only() {
        assert_eq!(display_name("  Mary \t Jane "), "Mary Jane");
        assert_eq!(display_name("Ta\u{0}m\u{1b}"), "Tam");
        assert_eq!(display_name("\u{7}"), FALLBACK_NAME);
        let long = "x".repeat(ROSTER_NAME_LIMIT + 5);
        let shown = display_name(&long);
        assert_eq!(shown.chars().count(), ROSTER_NAME_LIMIT);
        assert!(shown.ends_with('…'));
        let accented = display_name(&"é".repeat(ROSTER_NAME_LIMIT));
        assert_eq!(accented.chars().count(), ROSTER_NAME_LIMIT);
    }

    #[test]
    fn a_person_keeps_their_place_when_one_of_their_devices_expires() {
        let start = Instant::now();
        let registry = [record("p1", "Mira", &["laptop", "phone"], false)];
        let mut laptop = paired("p1", "laptop", 0, start);
        laptop.last_closed = Some(start + Duration::from_secs(1));
        let seats = [
            laptop,
            guest("g1", "Jules", 1, start + Duration::from_secs(2)),
            paired("p1", "phone", 1, start + Duration::from_secs(3)),
        ];
        // Long after the laptop's grace period, Mira is still first.
        let later = start + GRACE * 3;
        let (roster, _) = build_roster(&seats, &registry, RosterHost::default(), GRACE, later);
        assert_eq!(names(&roster), [DEFAULT_GM_NAME, "Mira", "Jules"]);
    }

    #[test]
    fn the_wire_shape_carries_nothing_private() {
        let keys_of = |entry: &RosterEntry| {
            let value = serde_json::to_value(entry).unwrap();
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort_unstable();
            (value, keys)
        };
        let active = RosterEntry {
            key: "guest:k".into(),
            name: "Tam".into(),
            role: RosterRole::Guest,
            state: RosterState::Active,
            away_since: None,
        };
        let (value, keys) = keys_of(&active);
        assert_eq!(keys, ["key", "name", "role", "state"]);
        assert_eq!(value["role"], "guest");
        assert_eq!(value["state"], "active");
        let away = RosterEntry {
            state: RosterState::Away,
            away_since: Some(1_700_000_000_000),
            ..active.clone()
        };
        let (value, keys) = keys_of(&away);
        assert_eq!(keys, ["awaySince", "key", "name", "role", "state"]);
        assert_eq!(value["state"], "away");
        let gone = RosterEntry {
            state: RosterState::Disconnected,
            ..active
        };
        assert_eq!(keys_of(&gone).0["state"], "disconnected");
    }

    #[test]
    fn an_idle_device_is_away_since_it_went_quiet() {
        let now = Instant::now();
        let mut seat = guest("g1", "Tam", 1, now);
        seat.away_since = Some(5_000);
        let (roster, expiry) = build_roster(
            std::slice::from_ref(&seat),
            &[],
            RosterHost::default(),
            GRACE,
            now,
        );
        assert_eq!(roster[1].state, RosterState::Away);
        assert_eq!(roster[1].away_since, Some(5_000));
        // Away is not on a timer: it lasts until the device is used again.
        assert!(expiry.is_none());
    }

    #[test]
    fn one_device_in_use_keeps_a_person_active() {
        let now = Instant::now();
        let registry = [record("p1", "Mira", &["laptop", "phone"], false)];
        let mut laptop = paired("p1", "laptop", 1, now);
        laptop.away_since = Some(5_000);
        let seats = [laptop.clone(), paired("p1", "phone", 1, now)];
        let (roster, _) = build_roster(&seats, &registry, RosterHost::default(), GRACE, now);
        assert_eq!(roster[1].state, RosterState::Active);
        assert_eq!(roster[1].away_since, None);
        // Both idle: away since the later of the two went quiet.
        let mut phone = paired("p1", "phone", 1, now);
        phone.away_since = Some(9_000);
        let (roster, _) = build_roster(
            &[laptop, phone],
            &registry,
            RosterHost::default(),
            GRACE,
            now,
        );
        assert_eq!(roster[1].state, RosterState::Away);
        assert_eq!(roster[1].away_since, Some(9_000));
    }

    #[test]
    fn a_dropped_connection_beats_idle() {
        let now = Instant::now();
        let mut seat = guest("g1", "Tam", 0, now);
        seat.away_since = Some(5_000);
        seat.last_closed = Some(now);
        let (roster, _) = build_roster(&[seat], &[], RosterHost::default(), GRACE, now);
        assert_eq!(roster[1].state, RosterState::Disconnected);
        assert_eq!(roster[1].away_since, None);
    }

    #[test]
    fn the_host_can_be_away_too() {
        let now = Instant::now();
        let host = RosterHost {
            name: Some("Ava"),
            away_since: Some(7_000),
        };
        let (roster, _) = build_roster(&[], &[], host, GRACE, now);
        assert_eq!(roster[0].state, RosterState::Away);
        assert_eq!(roster[0].away_since, Some(7_000));
    }
}
