//! The only Base transactions the vault can ever produce.
//!
//! Construct-only signing (invariant 1): every payload the vault sends to the MPC signer is
//! `keccak256` of an EIP-1559 transaction built here from a [`Call`]. No entry point accepts
//! calldata, a hash, a chain id, a selector or a destination.

use borsh::{BorshDeserialize, BorshSerialize};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;
use serde::{Deserialize, Serialize};

use crate::types::{word_addr, word_u128, Address, Hasher, H256};

pub const SEL_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
pub const SEL_SUPPLY: [u8; 4] = [0x61, 0x7b, 0xa0, 0x37];
pub const SEL_WITHDRAW: [u8; 4] = [0x69, 0x32, 0x8d, 0xec];
pub const SEL_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// `keccak256("Transfer(address,address,uint256)")`.
pub const TOPIC_TRANSFER: H256 =
    hex32("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
/// `keccak256("Approval(address,address,uint256)")`.
pub const TOPIC_APPROVAL: H256 =
    hex32("8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925");
/// Aave v3 `Supply(address,address,address,uint256,uint16)`.
pub const TOPIC_SUPPLY: H256 =
    hex32("2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61");
/// Aave v3 `Withdraw(address,address,address,uint256)`.
pub const TOPIC_WITHDRAW: H256 =
    hex32("3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7");

const fn hex32(s: &str) -> H256 {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("bad hex"),
    }
}

/// Fixed facts about the deployment. Changing any of them needs a new code hash (upgrade).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Chain {
    pub chain_id: u64,
    /// The vault's own MPC-derived Base address (`D`).
    pub vault: crate::types::EvmAddr,
    pub usdc: crate::types::EvmAddr,
    pub pool: crate::types::EvmAddr,
    /// Aave aUSDC. Withdrawals pay out from it, so it is never a deposit sender.
    pub atoken: crate::types::EvmAddr,
}

/// What a single Base transaction does. Amounts are USDC base units (6 decimals).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(tag = "call", rename_all = "snake_case")]
pub enum Call {
    /// `USDC.approve(pool, amount)`: always the exact amount of the supply that follows.
    Approve {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    /// `Pool.supply(USDC, amount, D, 0)`.
    Supply {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    /// `Pool.withdraw(USDC, amount, D)`: to the vault's own address only.
    Withdraw {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    /// `USDC.transfer(treasury, amount)`.
    Transfer {
        to: crate::types::EvmAddr,
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    /// A 0-value transfer to `D` itself, used to replace a stuck transaction at its nonce.
    Cancel,
}

/// Fee fields and nonce. Bounded by policy before a transaction is built.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct TxParams {
    pub nonce: u64,
    pub gas_limit: u64,
    #[serde(with = "crate::types::u128_str")]
    pub max_fee_per_gas: u128,
    #[serde(with = "crate::types::u128_str")]
    pub max_priority_fee_per_gas: u128,
}

/// Measured gas use on Base Sepolia (probe 14, tests T6/T7) with a margin.
pub fn gas_limit(call: &Call) -> u64 {
    match call {
        Call::Approve { .. } => 70_000,
        Call::Supply { .. } => 280_000,
        Call::Withdraw { .. } => 240_000,
        Call::Transfer { .. } => 80_000,
        Call::Cancel => 21_000,
    }
}

/// Destination contract of a call.
pub fn target(chain: &Chain, call: &Call) -> Address {
    match call {
        Call::Approve { .. } | Call::Transfer { .. } => chain.usdc.0,
        Call::Supply { .. } | Call::Withdraw { .. } => chain.pool.0,
        Call::Cancel => chain.vault.0,
    }
}

/// ABI calldata of a call.
pub fn calldata(chain: &Chain, call: &Call) -> Vec<u8> {
    let mut d = Vec::with_capacity(4 + 32 * 4);
    match call {
        Call::Approve { amount } => {
            d.extend(SEL_APPROVE);
            d.extend(word_addr(&chain.pool.0));
            d.extend(word_u128(*amount));
        }
        Call::Supply { amount } => {
            d.extend(SEL_SUPPLY);
            d.extend(word_addr(&chain.usdc.0));
            d.extend(word_u128(*amount));
            d.extend(word_addr(&chain.vault.0));
            d.extend([0u8; 32]);
        }
        Call::Withdraw { amount } => {
            d.extend(SEL_WITHDRAW);
            d.extend(word_addr(&chain.usdc.0));
            d.extend(word_u128(*amount));
            d.extend(word_addr(&chain.vault.0));
        }
        Call::Transfer { to, amount } => {
            d.extend(SEL_TRANSFER);
            d.extend(word_addr(&to.0));
            d.extend(word_u128(*amount));
        }
        Call::Cancel => {}
    }
    d
}

/// The unsigned EIP-1559 transaction for a call.
pub fn build(chain: &Chain, call: &Call, p: &TxParams) -> EVMTransaction {
    EVMTransaction {
        chain_id: chain.chain_id,
        nonce: p.nonce,
        to: Some(target(chain, call)),
        value: 0,
        input: calldata(chain, call),
        gas_limit: p.gas_limit as u128,
        max_fee_per_gas: p.max_fee_per_gas,
        max_priority_fee_per_gas: p.max_priority_fee_per_gas,
        access_list: vec![],
    }
}

/// The 32-byte payload the MPC signs: `keccak256(0x02 || rlp(fields))`.
pub fn signing_payload<H: Hasher>(h: &H, tx: &EVMTransaction) -> H256 {
    h.keccak256(&tx.build_for_signing())
}

/// An MPC secp256k1 signature as returned by `v1.signer` (`big_r` compressed, `s`, recovery id).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct MpcSignature {
    /// 33-byte compressed R, hex.
    pub big_r: String,
    /// 32-byte s, hex.
    pub s: String,
    pub recovery_id: u8,
}

impl MpcSignature {
    /// `r || s` (64 bytes) for `ecrecover`, if well formed.
    pub fn rs(&self) -> Option<[u8; 64]> {
        let r = hex::decode(self.big_r.trim_start_matches("0x")).ok()?;
        let s = hex::decode(self.s.trim_start_matches("0x")).ok()?;
        if r.len() != 33 || s.len() != 32 {
            return None;
        }
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&r[1..]);
        out[32..].copy_from_slice(&s);
        Some(out)
    }
}

/// The signed raw transaction and its hash, if the signature is well formed.
pub fn assemble<H: Hasher>(
    h: &H,
    tx: &EVMTransaction,
    sig: &MpcSignature,
) -> Option<(Vec<u8>, H256)> {
    let rs = sig.rs()?;
    if sig.recovery_id > 1 {
        return None;
    }
    let s = Signature {
        v: sig.recovery_id as u64,
        r: rs[..32].to_vec(),
        s: rs[32..].to_vec(),
    };
    let raw = tx.build_with_signature(&s);
    let hash = h.keccak256(&raw);
    Some((raw, hash))
}
