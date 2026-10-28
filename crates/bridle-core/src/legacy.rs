//! Older persisted layouts of [`Vault`] and their conversion, used by the contract's `migrate`.
//!
//! Version 2 (live on both testnet vaults since 2026-10-28) had no earned trust: its `Policy`
//! lacks the four `trust_*` fields and its `Vault` lacks `trust`. Version 1 is no longer
//! supported; no version-1 state exists (both vaults migrated to version 2 on 2026-10-28).

use borsh::{BorshDeserialize, BorshSerialize};

use crate::exposure::Exposure;
use crate::machine::{
    Config, EpochState, Ledger, Op, Parked, ParkedKind, ParkedStatus, PendingCredit, Rejection,
    Trust, Vault, STATE_VERSION,
};
use crate::policy::{Lane, Policy};
use crate::types::{EvmAddr, Hash32};

#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct PolicyV2 {
    pub supply_cap: u128,
    pub agent_max_per_action: u128,
    pub agent_quota_per_epoch: u32,
    pub agent_min_interval_ms: u64,
    pub fast_outflow_per_epoch: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub short_window_ms: u64,
    pub long_window_ms: u64,
    pub settle_deadline_ms: u64,
    pub epoch_ms: u64,
    pub max_pause_ms: u64,
    pub max_vetoes_per_epoch: u32,
    pub treasury: EvmAddr,
}

/// Trust settings given to a version-2 policy. They are neutral: the floor equals the ceiling, so
/// the agent's cap does not change at the migration. The DAO lowers the floor afterwards (FAST).
impl From<PolicyV2> for Policy {
    fn from(p: PolicyV2) -> Self {
        Policy {
            supply_cap: p.supply_cap,
            agent_max_per_action: p.agent_max_per_action,
            agent_quota_per_epoch: p.agent_quota_per_epoch,
            agent_min_interval_ms: p.agent_min_interval_ms,
            fast_outflow_per_epoch: p.fast_outflow_per_epoch,
            max_fee_per_gas: p.max_fee_per_gas,
            max_priority_fee_per_gas: p.max_priority_fee_per_gas,
            short_window_ms: p.short_window_ms,
            long_window_ms: p.long_window_ms,
            settle_deadline_ms: p.settle_deadline_ms,
            epoch_ms: p.epoch_ms,
            max_pause_ms: p.max_pause_ms,
            max_vetoes_per_epoch: p.max_vetoes_per_epoch,
            treasury: p.treasury,
            trust_floor_per_action: p.agent_max_per_action,
            trust_step_per_action: (p.agent_max_per_action / 10).max(1),
            trust_landings_per_step: 3,
            trust_epochs_per_step: 1,
        }
    }
}

#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub enum ParkedKindV2 {
    Policy { policy: PolicyV2 },
    Outflow { amount: u128 },
    AddGuardian { public_key: String },
    Upgrade { code_hash: Hash32 },
}

#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct ParkedV2 {
    pub id: u64,
    pub kind: ParkedKindV2,
    pub lane: Lane,
    pub created_ms: u64,
    pub unlock_ms: u64,
    pub expires_ms: u64,
    pub status: ParkedStatus,
    pub exposure_before: Exposure,
    pub exposure_after: Exposure,
}

/// A policy change still waiting at the migration is expired, not carried over: its trust fields
/// would be guessed, and applying a guess later could loosen the floor. The DAO proposes it again.
impl From<ParkedV2> for Parked {
    fn from(p: ParkedV2) -> Self {
        let (kind, status) = match p.kind {
            ParkedKindV2::Policy { policy } => {
                let status = if p.status == ParkedStatus::Waiting {
                    ParkedStatus::Expired
                } else {
                    p.status
                };
                (
                    ParkedKind::Policy {
                        policy: policy.into(),
                    },
                    status,
                )
            }
            ParkedKindV2::Outflow { amount } => (ParkedKind::Outflow { amount }, p.status),
            ParkedKindV2::AddGuardian { public_key } => {
                (ParkedKind::AddGuardian { public_key }, p.status)
            }
            ParkedKindV2::Upgrade { code_hash } => (ParkedKind::Upgrade { code_hash }, p.status),
        };
        Parked {
            id: p.id,
            kind,
            lane: p.lane,
            created_ms: p.created_ms,
            unlock_ms: p.unlock_ms,
            expires_ms: p.expires_ms,
            status,
            exposure_before: p.exposure_before,
            exposure_after: p.exposure_after,
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct VaultV2 {
    pub config: Config,
    pub policy: PolicyV2,
    pub agent_key: Option<String>,
    pub guardians: Vec<String>,
    pub next_nonce: u64,
    pub next_op: u64,
    pub next_req: u64,
    pub next_parked: u64,
    pub ops: Vec<Op>,
    pub active: Option<u64>,
    pub ledger: Ledger,
    pub epoch: EpochState,
    pub paused_until_ms: u64,
    pub pause_cooldown_until_ms: u64,
    pub parked: Vec<ParkedV2>,
    pub credits: Vec<(Hash32, u64, u64)>,
    pub pending_credits: Vec<PendingCredit>,
    pub rejections: Vec<Rejection>,
    pub rejection_count: u64,
    pub upgrade_ready: Option<Hash32>,
    pub credit_floor_block: u64,
    pub version: u32,
}

impl From<VaultV2> for Vault {
    fn from(v: VaultV2) -> Self {
        let epoch_index = v.epoch.index;
        Vault {
            config: v.config,
            policy: v.policy.into(),
            agent_key: v.agent_key,
            guardians: v.guardians,
            next_nonce: v.next_nonce,
            next_op: v.next_op,
            next_req: v.next_req,
            next_parked: v.next_parked,
            ops: v.ops,
            active: v.active,
            ledger: v.ledger,
            epoch: v.epoch,
            paused_until_ms: v.paused_until_ms,
            pause_cooldown_until_ms: v.pause_cooldown_until_ms,
            parked: v.parked.into_iter().map(Parked::from).collect(),
            credits: v.credits,
            pending_credits: v.pending_credits,
            rejections: v.rejections,
            rejection_count: v.rejection_count,
            upgrade_ready: v.upgrade_ready,
            credit_floor_block: v.credit_floor_block,
            // Trust starts at the floor; the first step needs a full epoch of proved landings.
            trust: Trust {
                last_change_epoch: epoch_index,
                ..Trust::default()
            },
            version: STATE_VERSION,
        }
    }
}
