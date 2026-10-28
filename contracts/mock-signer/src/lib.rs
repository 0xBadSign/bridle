//! Sandbox-only stand-in for the NEAR MPC signer (`v1.signer`) and its foreign-chain attestations.
//!
//! It speaks the same JSON as the real contract for the three calls the vault makes (`sign`,
//! `verify_foreign_transaction` and the two public-key views), so the vault runs unchanged against
//! it in `make demo`. Differences from the real network, all deliberate:
//! - one fixed secret key signs for every caller (the real MPC derives a key per predecessor and
//!   path), and a second fixed key plays the ForeignTx attestation key (domain 3);
//! - "Base" is a registry the demo script fills with `mock_land`; an attestation exists only for a
//!   landed, successful transaction, exactly like the real MPC, which never attests failed or
//!   unknown transactions (the vault callback then sees a failed promise = not attested);
//! - the secret keys are public constants. Never deploy this contract outside a local sandbox.

use bridle_core::foreign::{expected_payload_hash, ExpectedLog, Hints};
use bridle_core::types::{hex_of, parse_hex, Hash32, Hasher, H256};
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};

/// Fixed test secret keys. Public on purpose: this is a sandbox mock.
const SIGN_SECRET: [u8; 32] = [0x42; 32];
const FOREIGN_SECRET: [u8; 32] = [0x24; 32];
const FOREIGN_DOMAIN: u32 = 3;

struct NearHasher;
impl Hasher for NearHasher {
    fn keccak256(&self, d: &[u8]) -> H256 {
        env::keccak256_array(d)
    }
    fn sha256(&self, d: &[u8]) -> H256 {
        env::sha256_array(d)
    }
}

#[near(serializers=[json])]
pub enum PayloadV2 {
    Ecdsa(String),
}

#[near(serializers=[json])]
pub struct SignRequest {
    pub payload_v2: PayloadV2,
    pub path: String,
    pub domain_id: u32,
}

#[near(serializers=[json])]
pub enum Extractor {
    BlockHash,
    Log { log_index: u64 },
}

#[near(serializers=[json])]
pub struct BaseRequest {
    pub tx_id: String,
    pub extractors: Vec<Extractor>,
    pub finality: String,
}

#[near(serializers=[json])]
pub enum ForeignRequest {
    Base(BaseRequest),
}

#[near(serializers=[json])]
pub struct VerifyRequest {
    pub request: ForeignRequest,
    pub domain_id: u32,
    pub payload_version: u32,
    pub expected_payload_hash: Option<String>,
}

/// A log the demo script registers for a landed transaction.
#[near(serializers=[json, borsh])]
#[derive(Clone)]
pub struct LogIn {
    pub log_index: u64,
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
}

#[near(serializers=[json, borsh])]
#[derive(Clone)]
pub struct Landed {
    pub block_hash: String,
    pub block_number: u64,
    pub tx_index: u64,
    pub success: bool,
    pub logs: Vec<LogIn>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    /// The account that initialised the mock: the only one that may land transactions.
    owner: AccountId,
    /// When set, `sign` panics (simulates an MPC timeout).
    fail_sign: bool,
    landed: LookupMap<String, Landed>,
}

fn norm(s: &str) -> String {
    s.trim_start_matches("0x").to_lowercase()
}

fn key_of(secret: &[u8; 32]) -> SigningKey {
    SigningKey::from_bytes(secret.into()).unwrap_or_else(|_| env::panic_str("bad secret"))
}

fn pk_string(secret: &[u8; 32]) -> String {
    let point = key_of(secret).verifying_key().to_encoded_point(false);
    // 65 bytes: 0x04 || x || y. The real signer prints x || y only.
    let xy = &point.as_bytes()[1..];
    format!("secp256k1:{}", near_sdk::bs58::encode(xy).into_string())
}

/// Sign a 32-byte prehash with deterministic RFC6979 and low-s, in the real signer's JSON shape.
pub fn sign_json(secret: &[u8; 32], hash: &[u8; 32]) -> Value {
    let (sig, rid) = key_of(secret)
        .sign_prehash_recoverable(hash)
        .unwrap_or_else(|_| env::panic_str("sign failed"));
    let (sig, rid): (Signature, RecoveryId) = match sig.normalize_s() {
        Some(n) => (n, RecoveryId::new(!rid.is_y_odd(), rid.is_x_reduced())),
        None => (sig, rid),
    };
    let r = sig.r().to_bytes();
    let s = sig.s().to_bytes();
    let mut big_r = vec![0x02 | (rid.is_y_odd() as u8)];
    big_r.extend_from_slice(&r);
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": hex_of(&big_r) },
        "s": { "scalar": hex_of(&s) },
        "recovery_id": rid.to_byte(),
    })
}

fn require_deposit() {
    if env::attached_deposit() < NearToken::from_yoctonear(1) {
        env::panic_str("attach at least 1 yoctoNEAR");
    }
}

#[near]
impl MockSigner {
    #[init]
    pub fn new() -> Self {
        Self {
            owner: env::predecessor_account_id(),
            fail_sign: false,
            landed: LookupMap::new(b"l"),
        }
    }

    /// Owner only: make every `sign` call panic until switched off (an MPC timeout stand-in).
    pub fn set_fail_sign(&mut self, on: bool) {
        self.owner_only();
        self.fail_sign = on;
    }

    /// Owner only: register a transaction "mined" on Base, with the logs its receipt contains.
    #[allow(clippy::too_many_arguments)]
    pub fn mock_land(
        &mut self,
        tx_id: String,
        block_hash: String,
        block_number: u64,
        tx_index: u64,
        success: bool,
        logs: Vec<LogIn>,
    ) {
        self.owner_only();
        self.landed.insert(
            norm(&tx_id),
            Landed {
                block_hash,
                block_number,
                tx_index,
                success,
                logs,
            },
        );
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Value {
        require_deposit();
        if self.fail_sign {
            env::panic_str("mock MPC: signing unavailable");
        }
        let PayloadV2::Ecdsa(hex_payload) = request.payload_v2;
        let payload: H256 =
            parse_hex(&hex_payload).unwrap_or_else(|| env::panic_str("payload must be 32 bytes"));
        sign_json(&SIGN_SECRET, &payload)
    }

    /// Attest that a Base transaction succeeded. Panics (like the real MPC erroring out) when the
    /// transaction is unknown, failed, or does not match `expected_payload_hash`.
    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: VerifyRequest) -> Value {
        require_deposit();
        let ForeignRequest::Base(base) = request.request;
        let tx: H256 =
            parse_hex(&base.tx_id).unwrap_or_else(|| env::panic_str("tx_id must be 32 bytes"));
        let landed = self
            .landed
            .get(&norm(&base.tx_id))
            .cloned()
            .unwrap_or_else(|| env::panic_str("mock MPC: transaction not found on Base"));
        if !landed.success {
            env::panic_str("mock MPC: transaction failed on Base, nothing to attest");
        }
        let log_index = base.extractors.iter().find_map(|e| match e {
            Extractor::Log { log_index } => Some(*log_index),
            Extractor::BlockHash => None,
        });
        let block_hash: H256 = parse_hex(&landed.block_hash)
            .unwrap_or_else(|| env::panic_str("registered block hash is not 32 bytes"));
        let hints = Hints {
            block_hash: Hash32(block_hash),
            block_number: landed.block_number,
            tx_index: landed.tx_index,
            log_index: log_index.unwrap_or(0),
        };
        let log = log_index.map(|i| {
            let l = landed
                .logs
                .iter()
                .find(|l| l.log_index == i)
                .unwrap_or_else(|| env::panic_str("mock MPC: no such log in the receipt"));
            ExpectedLog {
                address: parse_hex(&l.address).unwrap_or_else(|| env::panic_str("bad log address")),
                topics: l
                    .topics
                    .iter()
                    .map(|t| parse_hex(t).unwrap_or_else(|| env::panic_str("bad log topic")))
                    .collect(),
                data: hex::decode(l.data.trim_start_matches("0x"))
                    .unwrap_or_else(|_| env::panic_str("bad log data")),
            }
        });
        let hash = expected_payload_hash(&NearHasher, &tx, &hints, log.as_ref());
        if let Some(want) = request.expected_payload_hash {
            let want: H256 = parse_hex(&want)
                .unwrap_or_else(|| env::panic_str("expected_payload_hash must be 32 bytes"));
            if want != hash {
                env::panic_str("mock MPC: payload hash differs from what the chain shows");
            }
        }
        json!({
            "payload_hash": hex_of(&hash),
            "signature": sign_json(&FOREIGN_SECRET, &hash),
        })
    }

    /// Root public key of a domain: 3 is the ForeignTx key, anything else the signing key.
    pub fn public_key(&self, domain_id: u32) -> String {
        if domain_id == FOREIGN_DOMAIN {
            pk_string(&FOREIGN_SECRET)
        } else {
            pk_string(&SIGN_SECRET)
        }
    }

    /// The real signer derives a key per (predecessor, path); the mock returns its one key.
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u32,
    ) -> String {
        let _ = (path, predecessor);
        self.public_key(domain_id)
    }
}

impl MockSigner {
    fn owner_only(&self) {
        if env::predecessor_account_id() != self.owner {
            env::panic_str("only the account that initialised the mock may do this");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::VerifyingKey;

    #[test]
    fn signatures_recover_to_the_published_key_with_low_s() {
        for hash in [[1u8; 32], [0xffu8; 32], [7u8; 32]] {
            let v = sign_json(&SIGN_SECRET, &hash);
            let r = hex::decode(v["big_r"]["affine_point"].as_str().unwrap()).unwrap();
            let s = hex::decode(v["s"]["scalar"].as_str().unwrap()).unwrap();
            assert_eq!(r.len(), 33);
            let sig = Signature::from_scalars(
                <[u8; 32]>::try_from(&r[1..]).unwrap(),
                <[u8; 32]>::try_from(&s[..]).unwrap(),
            )
            .unwrap();
            assert!(sig.normalize_s().is_none(), "s must already be low");
            let rid = RecoveryId::from_byte(v["recovery_id"].as_u64().unwrap() as u8).unwrap();
            let vk = VerifyingKey::recover_from_prehash(&hash, &sig, rid).unwrap();
            assert_eq!(vk, *key_of(&SIGN_SECRET).verifying_key());
            assert_eq!(r[0] & 1, rid.is_y_odd() as u8);
        }
    }

    #[test]
    fn key_views_differ_per_domain() {
        assert_ne!(pk_string(&SIGN_SECRET), pk_string(&FOREIGN_SECRET));
        assert!(pk_string(&SIGN_SECRET).starts_with("secp256k1:"));
    }
}
