//! Landing proofs: the request the vault sends to `verify_foreign_transaction` and the payload
//! hash it expects back.
//!
//! The MPC signs `sha256(borsh(ForeignTxSignPayload::V1 { request, values }))`. The vault computes
//! that hash itself from the transaction hash it signed, the log it expects, and keeper-supplied
//! position hints (block hash, block number, tx index, log index). A wrong hint can only produce
//! a mismatch, i.e. no attestation: hints affect liveness, never what counts as landed.
//! Encoding verified against live attestations (probe 14, tests T2-T5).

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::evm::{Call, Chain, TOPIC_APPROVAL, TOPIC_SUPPLY, TOPIC_TRANSFER, TOPIC_WITHDRAW};
use crate::types::{hex0x, hex_of, word_addr, word_u128, Address, Hash32, Hasher, H256};

/// Borsh discriminants of the MPC contract's types.
const PAYLOAD_V1: u8 = 0;
const CHAIN_BASE: u8 = 6;
const EXTRACTOR_BLOCK_HASH: u8 = 0;
const EXTRACTOR_LOG: u8 = 1;
const FINALITY_SAFE: u8 = 1;
const VALUE_EVM: u8 = 1;
const EVM_VALUE_BLOCK_HASH: u8 = 0;
const EVM_VALUE_LOG: u8 = 1;

/// Where a transaction and its log sit on Base. Supplied by anyone (usually the keeper).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Hints {
    pub block_hash: Hash32,
    pub block_number: u64,
    pub tx_index: u64,
    /// Block-level log index of the expected log (ignored for log-less checks).
    pub log_index: u64,
}

/// A log the vault expects a transaction to emit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedLog {
    pub address: Address,
    pub topics: Vec<H256>,
    pub data: Vec<u8>,
}

/// The log that proves a vault call succeeded, or `None` when only inclusion can be proved
/// (a 0-value cancel emits no log; the MPC only attests successful transactions, test T2).
pub fn expected_log(chain: &Chain, call: &Call) -> Option<ExpectedLog> {
    let d = &chain.vault.0;
    match call {
        Call::Approve { amount } => Some(ExpectedLog {
            address: chain.usdc.0,
            topics: vec![TOPIC_APPROVAL, word_addr(d), word_addr(&chain.pool.0)],
            data: word_u128(*amount).to_vec(),
        }),
        Call::Supply { amount } => Some(ExpectedLog {
            address: chain.pool.0,
            topics: vec![
                TOPIC_SUPPLY,
                word_addr(&chain.usdc.0),
                word_addr(d),
                [0u8; 32],
            ],
            data: [word_addr(d), word_u128(*amount)].concat(),
        }),
        Call::Withdraw { amount } => Some(ExpectedLog {
            address: chain.pool.0,
            topics: vec![
                TOPIC_WITHDRAW,
                word_addr(&chain.usdc.0),
                word_addr(d),
                word_addr(d),
            ],
            data: word_u128(*amount).to_vec(),
        }),
        Call::Transfer { to, amount } => Some(ExpectedLog {
            address: chain.usdc.0,
            topics: vec![TOPIC_TRANSFER, word_addr(d), word_addr(&to.0)],
            data: word_u128(*amount).to_vec(),
        }),
        Call::Cancel => None,
    }
}

/// An inbound USDC transfer to the vault from `from` (used by `credit_deposit`).
pub fn inbound_transfer_log(chain: &Chain, from: &Address, amount: u128) -> ExpectedLog {
    ExpectedLog {
        address: chain.usdc.0,
        topics: vec![TOPIC_TRANSFER, word_addr(from), word_addr(&chain.vault.0)],
        data: word_u128(amount).to_vec(),
    }
}

fn u32le(n: usize) -> [u8; 4] {
    (n as u32).to_le_bytes()
}

fn request_bytes(tx_id: &H256, log_index: Option<u64>) -> Vec<u8> {
    let mut b = vec![CHAIN_BASE];
    b.extend(tx_id);
    match log_index {
        Some(i) => {
            b.extend(u32le(2));
            b.push(EXTRACTOR_BLOCK_HASH);
            b.push(EXTRACTOR_LOG);
            b.extend(i.to_le_bytes());
        }
        None => {
            b.extend(u32le(1));
            b.push(EXTRACTOR_BLOCK_HASH);
        }
    }
    b.push(FINALITY_SAFE);
    b
}

fn log_bytes(tx_id: &H256, hints: &Hints, log: &ExpectedLog) -> Vec<u8> {
    let mut b = vec![0u8]; // `removed: false`
    b.extend(hints.log_index.to_le_bytes());
    b.extend(hints.tx_index.to_le_bytes());
    b.extend(tx_id);
    b.extend(hints.block_hash.0);
    b.extend(hints.block_number.to_le_bytes());
    b.extend(log.address);
    let data = hex0x(&log.data);
    b.extend(u32le(data.len()));
    b.extend(data.as_bytes());
    b.extend(u32le(log.topics.len()));
    for t in &log.topics {
        b.extend(t);
    }
    b
}

/// The payload hash the MPC signs for this request, if the chain matches the expectation.
pub fn expected_payload_hash<H: Hasher>(
    h: &H,
    tx_id: &H256,
    hints: &Hints,
    log: Option<&ExpectedLog>,
) -> H256 {
    let mut p = vec![PAYLOAD_V1];
    p.extend(request_bytes(tx_id, log.map(|_| hints.log_index)));
    match log {
        Some(l) => {
            p.extend(u32le(2));
            p.extend([VALUE_EVM, EVM_VALUE_BLOCK_HASH]);
            p.extend(hints.block_hash.0);
            p.extend([VALUE_EVM, EVM_VALUE_LOG]);
            p.extend(log_bytes(tx_id, hints, l));
        }
        None => {
            p.extend(u32le(1));
            p.extend([VALUE_EVM, EVM_VALUE_BLOCK_HASH]);
            p.extend(hints.block_hash.0);
        }
    }
    h.sha256(&p)
}

/// JSON arguments for `v1.signer.verify_foreign_transaction`.
pub fn verify_args_json(
    tx_id: &H256,
    log_index: Option<u64>,
    expected: &H256,
    domain_id: u32,
) -> String {
    let extractors = match log_index {
        Some(i) => format!(r#"["BlockHash",{{"Log":{{"log_index":{i}}}}}]"#),
        None => r#"["BlockHash"]"#.to_string(),
    };
    format!(
        r#"{{"request":{{"request":{{"Base":{{"tx_id":"{}","extractors":{},"finality":"Safe"}}}},"domain_id":{},"payload_version":1,"expected_payload_hash":"{}"}}}}"#,
        hex_of(tx_id),
        extractors,
        domain_id,
        hex_of(expected)
    )
}

/// JSON arguments for `v1.signer.sign` over a 32-byte payload.
pub fn sign_args_json(payload: &H256, path: &str, domain_id: u32) -> String {
    format!(
        r#"{{"request":{{"payload_v2":{{"Ecdsa":"{}"}},"path":"{}","domain_id":{}}}}}"#,
        hex_of(payload),
        path,
        domain_id
    )
}
