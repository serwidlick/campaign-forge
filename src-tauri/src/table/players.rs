//! The campaign's players and their paired devices, kept in `campaign.json`
//! under `players` so they travel with the folder:
//!
//! ```text
//! players:
//!   - id: 7d1c…            stable; audiences and sheet owners point at it
//!     name: Mira
//!     devices:
//!       - fingerprint: ab12-cd34-ef56-7890-1234
//!         publicKey: <base64 Ed25519>
//!         label: MIRA-LAPTOP
//!         addedAt: 2026-11-04T20:00:00Z
//!     lastSeen: 2026-11-04T20:05:00Z
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::{AppState, StorageError};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerDevice {
    pub fingerprint: String,
    pub public_key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub devices: Vec<PlayerDevice>,
    #[serde(default)]
    pub last_seen: Option<String>,
}

/// The registry of the open campaign; empty when none is open.
pub fn load(state: &AppState) -> Vec<PlayerRecord> {
    state
        .current_campaign()
        .and_then(|meta| meta.extra.get("players").cloned())
        .and_then(|v| serde_json::from_value::<Vec<PlayerRecord>>(v).ok())
        .unwrap_or_default()
}

/// Writes the registry back into `campaign.json`, leaving other settings be.
pub fn save(state: &AppState, players: &[PlayerRecord]) -> Result<(), StorageError> {
    let meta = state
        .current_campaign()
        .ok_or(StorageError::NoCampaignOpen)?;
    let mut extra = meta.extra;
    extra.insert(
        "players".to_owned(),
        serde_json::to_value(players).unwrap_or(Value::Array(vec![])),
    );
    state.update_campaign(None, None, Some(extra))?;
    Ok(())
}

pub fn find_by_device<'a>(
    players: &'a [PlayerRecord],
    fingerprint: &str,
) -> Option<&'a PlayerRecord> {
    players
        .iter()
        .find(|p| p.devices.iter().any(|d| d.fingerprint == fingerprint))
}

pub fn find_by_id<'a>(players: &'a [PlayerRecord], id: &str) -> Option<&'a PlayerRecord> {
    players.iter().find(|p| p.id == id)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Pairs a device with a player: an existing one by id, or a new player with
/// the given name. A device already paired elsewhere moves to this player.
pub fn bind_device(
    state: &AppState,
    player_id: Option<&str>,
    name: &str,
    device: PlayerDevice,
) -> Result<PlayerRecord, StorageError> {
    let mut players = load(state);
    for p in players.iter_mut() {
        p.devices.retain(|d| d.fingerprint != device.fingerprint);
    }
    let device = PlayerDevice {
        added_at: now(),
        ..device
    };
    let record = match player_id.and_then(|id| players.iter_mut().find(|p| p.id == id)) {
        Some(existing) => {
            existing.devices.push(device);
            existing.last_seen = Some(now());
            existing.clone()
        }
        None => {
            let name = name.trim();
            if name.is_empty() {
                return Err(StorageError::InvalidInput("a player needs a name".into()));
            }
            let record = PlayerRecord {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_owned(),
                devices: vec![device],
                last_seen: Some(now()),
            };
            players.push(record.clone());
            record
        }
    };
    save(state, &players)?;
    Ok(record)
}

/// Records that a known player was at the table just now.
pub fn touch(state: &AppState, player_id: &str) -> Result<(), StorageError> {
    let mut players = load(state);
    if let Some(p) = players.iter_mut().find(|p| p.id == player_id) {
        p.last_seen = Some(now());
        save(state, &players)?;
    }
    Ok(())
}
