//! This device's identity: an Ed25519 key pair made on first use and kept in
//! the operating system's credential store. Joining a table proves the
//! device by signing a one-time challenge; the GM pairs the device with a
//! player once and never needs a code from it again. Nothing here touches
//! the network or any server.

use base64::prelude::*;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use keyring::{Entry, Error as KeyringError};
use rand_core::OsRng;
use serde::Serialize;
use sha2::{Digest, Sha256};

const SERVICE: &str = "dev.campaignforge.app";
const ACCOUNT: &str = "device-key";

pub struct DeviceKey {
    signing: SigningKey,
}

impl DeviceKey {
    /// The device's key, created and stored on first call.
    pub fn load_or_create() -> Result<DeviceKey, String> {
        let entry = Entry::new(SERVICE, ACCOUNT)
            .map_err(|e| format!("credential store unavailable: {e}"))?;
        match entry.get_password() {
            Ok(stored) => {
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
            Err(KeyringError::NoEntry) => {
                let signing = SigningKey::generate(&mut OsRng);
                entry
                    .set_password(&BASE64_STANDARD.encode(signing.to_bytes()))
                    .map_err(|e| format!("could not store the device key: {e}"))?;
                Ok(DeviceKey { signing })
            }
            Err(e) => Err(format!("could not read the device key: {e}")),
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
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This device".to_owned())
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
