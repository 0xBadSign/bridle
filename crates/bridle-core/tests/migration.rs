//! The version-2 to version-3 migration, run on the real state of both testnet vaults.
//!
//! The fixtures are the raw `STATE` values of `vault.bridle-hq.testnet` and
//! `arena.bridle-hq.testnet` read with RPC `view_state` on 2026-10-29 (blocks 275209256 and
//! 275209257), hex-encoded. The contract's `migrate` decodes the same bytes the same way.

use borsh::{BorshDeserialize, BorshSerialize};
use bridle_core::legacy::VaultV2;
use bridle_core::machine::{ParkedKind, ParkedStatus, Vault, STATE_VERSION};
use bridle_core::policy;

/// The contract's version-2 layout: `AccountId` is a borsh string, `NearToken` a u128.
#[derive(BorshDeserialize)]
struct ContractV2 {
    owner: String,
    signer: String,
    vault_pk: Vec<u8>,
    foreign_pk: Vec<u8>,
    key_allowance: u128,
    vault: VaultV2,
}

fn load(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    hex::decode(text.trim()).unwrap()
}

fn migrate(name: &str) -> (ContractV2Summary, Vault) {
    let raw = load(name);
    let c = ContractV2::try_from_slice(&raw).expect("version-2 layout decodes the live state");
    let summary = ContractV2Summary {
        owner: c.owner,
        signer: c.signer,
        pk_lens: (c.vault_pk.len(), c.foreign_pk.len()),
        key_allowance: c.key_allowance,
        agent_max: c.vault.policy.agent_max_per_action,
        supply_cap: c.vault.policy.supply_cap,
        idle: c.vault.ledger.idle,
        principal: c.vault.ledger.principal,
        next_nonce: c.vault.next_nonce,
        ops: c.vault.ops.len(),
        parked: c.vault.parked.len(),
        rejections: c.vault.rejection_count,
        version: c.vault.version,
    };
    (summary, c.vault.into())
}

struct ContractV2Summary {
    owner: String,
    signer: String,
    pk_lens: (usize, usize),
    key_allowance: u128,
    agent_max: u128,
    supply_cap: u128,
    idle: u128,
    principal: u128,
    next_nonce: u64,
    ops: usize,
    parked: usize,
    rejections: u64,
    version: u32,
}

fn check(name: &str) {
    let (old, v) = migrate(name);
    assert_eq!(old.version, 2, "{name} is a version-2 state");
    assert_eq!(old.owner, "bridle-hq.sputnik-v2.testnet");
    assert_eq!(old.signer, "v1.signer-prod.testnet");
    assert_eq!(old.pk_lens, (64, 64));
    assert!(old.key_allowance > 0);
    // Everything that was there is still there.
    assert_eq!(v.version, STATE_VERSION);
    assert_eq!(v.policy.agent_max_per_action, old.agent_max);
    assert_eq!(v.policy.supply_cap, old.supply_cap);
    assert_eq!(v.ledger.idle, old.idle);
    assert_eq!(v.ledger.principal, old.principal);
    assert_eq!(v.next_nonce, old.next_nonce);
    assert_eq!(v.ops.len(), old.ops);
    assert_eq!(v.parked.len(), old.parked);
    assert_eq!(v.rejection_count, old.rejections);
    // Earned trust starts neutral: the agent's cap does not change at the migration.
    assert!(policy::validate(&v.policy, &v.config.floors).is_ok());
    assert_eq!(v.agent_cap(), old.agent_max);
    assert_eq!(v.trust.level, 0);
    assert_eq!(v.trust.last_change_epoch, v.epoch.index);
    // No policy change is left waiting with guessed trust fields.
    assert!(!v
        .parked
        .iter()
        .any(|p| matches!(p.kind, ParkedKind::Policy { .. }) && p.status == ParkedStatus::Waiting));
    // The new layout round-trips.
    let bytes = borsh::to_vec(&v).unwrap();
    assert_eq!(Vault::try_from_slice(&bytes).unwrap(), v);
}

#[test]
fn live_main_vault_state_migrates() {
    check("state_v2_vault.hex");
}

#[test]
fn live_arena_vault_state_migrates() {
    check("state_v2_arena.hex");
}

#[test]
fn a_version_3_state_is_not_mistaken_for_version_2() {
    // `migrate` tries the current layout first; a v2 state must not decode as v3 and vice versa.
    let raw = load("state_v2_vault.hex");
    let c = ContractV2::try_from_slice(&raw).unwrap();
    let v3: Vault = c.vault.into();
    let mut bytes = vec![];
    "bridle-hq.sputnik-v2.testnet"
        .to_string()
        .serialize(&mut bytes)
        .unwrap();
    "v1.signer-prod.testnet"
        .to_string()
        .serialize(&mut bytes)
        .unwrap();
    c.vault_pk.serialize(&mut bytes).unwrap();
    c.foreign_pk.serialize(&mut bytes).unwrap();
    c.key_allowance.serialize(&mut bytes).unwrap();
    v3.serialize(&mut bytes).unwrap();
    assert!(
        ContractV2::try_from_slice(&bytes).is_err(),
        "v3 bytes do not parse as v2"
    );
    assert!(ContractV3::try_from_slice(&bytes).is_ok());
    for name in ["state_v2_vault.hex", "state_v2_arena.hex"] {
        assert!(
            ContractV3::try_from_slice(&load(name)).is_err(),
            "{name}: v2 bytes do not parse as v3"
        );
    }
}

#[derive(BorshDeserialize)]
#[allow(dead_code)]
struct ContractV3 {
    owner: String,
    signer: String,
    vault_pk: Vec<u8>,
    foreign_pk: Vec<u8>,
    key_allowance: u128,
    vault: Vault,
}
