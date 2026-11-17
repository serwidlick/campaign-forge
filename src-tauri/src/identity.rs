//! This device's identity: an Ed25519 key pair made on first use and kept in
//! the operating system's credential store (on a phone, where there is no
//! such store, in the app's private data directory). Joining a table proves
//! the device by signing a one-time challenge; the GM pairs the device with
//! a player once and never needs a code from it again. Nothing here touches
//! the network or any server.

use base64::prelude::*;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Where the key's seed is kept: the OS credential store on desktop.
#[cfg(desktop)]
mod store {
    use keyring::{Entry, Error as KeyringError};

    const SERVICE: &str = "dev.campaignforge.app";
    const ACCOUNT: &str = "device-key";

    fn entry() -> Result<Entry, String> {
        Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("credential store unavailable: {e}"))
    }

    pub fn read() -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(stored) => Ok(Some(stored)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read the device key: {e}")),
        }
    }

    pub fn write(value: &str) -> Result<(), String> {
        entry()?
            .set_password(value)
            .map_err(|e| format!("could not store the device key: {e}"))
    }
}

/// Where the key's seed is kept on a phone: a file in the app's private
/// data directory, which the OS keeps from other apps. The directory is
/// handed in at startup, before any table is joined.
#[cfg(mobile)]
mod store {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    static DIR: OnceLock<PathBuf> = OnceLock::new();

    pub fn configure(dir: PathBuf) {
        let _ = DIR.set(dir);
    }

    fn file() -> Result<PathBuf, String> {
        DIR.get()
            .map(|dir| dir.join("device-key"))
            .ok_or_else(|| "the device key store is not set up yet".to_owned())
    }

    pub fn read() -> Result<Option<String>, String> {
        match std::fs::read_to_string(file()?) {
            Ok(stored) => Ok(Some(stored)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("could not read the device key: {e}")),
        }
    }

    pub fn write(value: &str) -> Result<(), String> {
        let path = file()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create the app's data directory: {e}"))?;
        }
        std::fs::write(&path, value).map_err(|e| format!("could not store the device key: {e}"))
    }
}

/// Mobile: tells the key store where the app's private data directory is.
#[cfg(mobile)]
pub fn use_file_store(dir: std::path::PathBuf) {
    store::configure(dir);
}

pub struct DeviceKey {
    signing: SigningKey,
}

impl DeviceKey {
    /// The device's key, created and stored on first call.
    pub fn load_or_create() -> Result<DeviceKey, String> {
        match store::read()? {
            Some(stored) => {
                let bytes = BASE64_STANDARD
                    .decode(stored.trim())
                    .map_err(|_| "stored device key is not valid base64".to_owned())?;
                let seed: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| "stored device key has the wrong length".to_owned())?;
                Ok(DeviceKey {
                    signing: SigningKey::from_bytes(&seed),
                })
            }
            None => {
                let signing = SigningKey::generate(&mut OsRng);
                store::write(&BASE64_STANDARD.encode(signing.to_bytes()))?;
                Ok(DeviceKey { signing })
            }
        }
    }

    pub fn public_key_b64(&self) -> String {
        BASE64_STANDARD.encode(self.signing.verifying_key().to_bytes())
    }

    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.signing.verifying_key())
    }

    pub fn sign_b64(&self, message: &[u8]) -> String {
        BASE64_STANDARD.encode(self.signing.sign(message).to_bytes())
    }
}

/// Short, human-checkable id for a public key: the first 80 bits of its
/// SHA-256, as five groups of four hex digits.
pub fn fingerprint_of(key: &VerifyingKey) -> String {
    let digest = Sha256::digest(key.to_bytes());
    let hex: String = digest[..10].iter().map(|b| format!("{b:02x}")).collect();
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

/// Checks a signature over `message` and returns the key's fingerprint.
pub fn verify(public_key_b64: &str, message: &[u8], signature_b64: &str) -> Option<String> {
    let key_bytes: [u8; 32] = BASE64_STANDARD
        .decode(public_key_b64.trim())
        .ok()?
        .try_into()
        .ok()?;
    let key = VerifyingKey::from_bytes(&key_bytes).ok()?;
    let sig_bytes: [u8; 64] = BASE64_STANDARD
        .decode(signature_b64.trim())
        .ok()?
        .try_into()
        .ok()?;
    let signature = Signature::from_bytes(&sig_bytes);
    key.verify(message, &signature).ok()?;
    Some(fingerprint_of(&key))
}

/// A friendly name for this machine, used as the device label.
pub fn device_label() -> String {
    #[cfg(target_os = "android")]
    if let Some(model) = android_model() {
        return model;
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This device".to_owned())
}

/// The phone's model name ("Pixel 9 Pro"), from Android's system properties.
#[cfg(target_os = "android")]
fn android_model() -> Option<String> {
    use std::ffi::{CStr, CString};

    let name = CString::new("ro.product.model").ok()?;
    let mut value = [0u8; libc::PROP_VALUE_MAX as usize];
    // SAFETY: `name` is a valid NUL-terminated string and `value` is a
    // buffer of PROP_VALUE_MAX bytes, the size the function writes within.
    let len = unsafe {
        libc::__system_property_get(name.as_ptr(), value.as_mut_ptr() as *mut libc::c_char)
    };
    if len <= 0 {
        return None;
    }
    let model = CStr::from_bytes_until_nul(&value)
        .ok()?
        .to_str()
        .ok()?
        .trim();
    (!model.is_empty()).then(|| model.to_owned())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub fingerprint: String,
    pub label: String,
}

/// What this device is called at a table, for the join screen.
#[tauri::command]
pub fn device_identity() -> Result<DeviceIdentity, String> {
    let key = DeviceKey::load_or_create()?;
    Ok(DeviceIdentity {
        fingerprint: key.fingerprint(),
        label: device_label(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_verify_and_fingerprints_match() {
        let key = DeviceKey {
            signing: SigningKey::generate(&mut OsRng),
        };
        let sig = key.sign_b64(b"nonce-123");
        assert_eq!(
            verify(&key.public_key_b64(), b"nonce-123", &sig),
            Some(key.fingerprint())
        );
        assert_eq!(verify(&key.public_key_b64(), b"other", &sig), None);
        assert_eq!(key.fingerprint().len(), 24);
    }
}
