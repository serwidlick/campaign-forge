//! The player's side: talks to a GM's table server. All networking stays in
//! Rust so the webview never needs network permissions of its own.

use std::time::Duration;

use serde::Serialize;

use crate::storage::{Element, ElementSummary};

use super::server::{JoinResponse, TableInfo, VersionResponse};

/// A joined table. Cheap to clone; the HTTP client is reference counted.
#[derive(Clone)]
pub struct Session {
    http: reqwest::Client,
    base: String,
    token: String,
    pub info: TableInfo,
    pub address: String,
    pub player_name: String,
}

/// What the frontend keeps about the joined table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub address: String,
    pub player_name: String,
    pub info: TableInfo,
}

fn normalise(address: &str) -> String {
    let trimmed = address
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/');
    format!("http://{trimmed}")
}

async fn describe(resp: reqwest::Response) -> String {
    let status = resp.status();
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
    pub async fn join(address: &str, player_name: &str, code: &str) -> Result<Session, String> {
        let base = normalise(address);
        let http = reqwest::Client::builder()
            // Long enough for the version long-poll, which answers within 25 s.
            .timeout(Duration::from_secs(40))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = http
            .post(format!("{base}/api/join"))
            .json(&serde_json::json!({ "name": player_name, "code": code }))
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        let joined: JoinResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(Session {
            http,
            base,
            token: joined.token,
            info: joined.info,
            address: address.trim().to_owned(),
            player_name: player_name.to_owned(),
        })
    }

    pub fn summary(&self) -> SessionInfo {
        SessionInfo {
            address: self.address.clone(),
            player_name: self.player_name.clone(),
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

    /// Returns once the GM's campaign has changed past `after`, or after the
    /// server's long-poll window with the current version.
    pub async fn wait_for_change(&self, after: u64) -> Result<u64, String> {
        let resp = self
            .get(&format!("/api/version?after={after}"))
            .send()
            .await
            .map_err(connection_error)?;
        if !resp.status().is_success() {
            return Err(describe(resp).await);
        }
        let v: VersionResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(v.version)
    }
}
