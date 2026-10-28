//! Small shared types.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A 20-byte EVM address.
pub type Address = [u8; 20];
/// A 32-byte hash.
pub type H256 = [u8; 32];

/// Hash functions supplied by the host. The contract uses NEAR host functions;
/// tests use the `sha2` and `sha3` crates.
pub trait Hasher {
    fn keccak256(&self, data: &[u8]) -> H256;
    fn sha256(&self, data: &[u8]) -> H256;
}

/// Lower-case hex without a `0x` prefix.
pub fn hex_of(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// `0x`-prefixed lower-case hex.
pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Parse hex with or without `0x` into exactly `N` bytes.
pub fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let v = hex::decode(s.trim_start_matches("0x")).ok()?;
    v.try_into().ok()
}

/// A 32-byte big-endian word holding `v` (Solidity `uint256`).
pub fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// A 32-byte word holding a left-padded address.
pub fn word_addr(a: &Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

/// Serde helpers so amounts travel as decimal strings in JSON (u128 does not fit in JS numbers).
pub mod u128_str {
    use super::*;
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let s = <String as Deserialize>::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// An EVM address that serializes as `0x`-hex.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct EvmAddr(pub Address);

impl Serialize for EvmAddr {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex0x(&self.0))
    }
}

impl<'de> Deserialize<'de> for EvmAddr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as Deserialize>::deserialize(d)?;
        parse_hex::<20>(&s)
            .map(EvmAddr)
            .ok_or_else(|| serde::de::Error::custom("bad address"))
    }
}

/// A 32-byte hash that serializes as `0x`-hex.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct Hash32(pub H256);

impl Serialize for Hash32 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex0x(&self.0))
    }
}

impl<'de> Deserialize<'de> for Hash32 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as Deserialize>::deserialize(d)?;
        parse_hex::<32>(&s)
            .map(Hash32)
            .ok_or_else(|| serde::de::Error::custom("bad hash"))
    }
}
