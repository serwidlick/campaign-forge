//! The user's Anthropic API key, kept in the operating system's credential
//! store (Windows Credential Manager, macOS Keychain, Secret Service on
//! Linux). It never touches the campaign folder or the settings file.
//!
//! The mobile app has no assistant, so there is no key to keep: the same
//! commands exist so the frontend's wrappers resolve, but report no key.

#[cfg(desktop)]
use keyring::{Entry, Error as KeyringError};

#[cfg(desktop)]
const SERVICE: &str = "dev.campaignforge.app";
#[cfg(desktop)]
const ACCOUNT: &str = "anthropic-api-key";

#[cfg(desktop)]
fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("credential store unavailable: {e}"))
}

#[cfg(mobile)]
#[tauri::command]
pub fn get_api_key() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(mobile)]
#[tauri::command]
pub fn set_api_key(_key: String) -> Result<(), String> {
    Err("The assistant is not available in the mobile app".into())
}

#[cfg(mobile)]
#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    Ok(())
}

/// Returns the stored key, or `None` when no key has been saved yet.
#[cfg(desktop)]
#[tauri::command]
pub fn get_api_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the API key: {e}")),
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    entry()?
        .set_password(key)
        .map_err(|e| format!("could not save the API key: {e}"))
}

#[cfg(desktop)]
#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the API key: {e}")),
    }
}
