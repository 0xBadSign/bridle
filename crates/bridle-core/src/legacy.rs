//! Older persisted layouts of [`Vault`] and their conversion, used by the contract's `migrate`.
//!
//! Version 1 (first testnet deployment, 2026-10-28) had one verify and one credit in flight at a
//! time, a slot-wide verify cooldown, and consumed deposit proofs without block numbers. Version 2
//! fixes review findings 2a-2c (see `docs/PROGRESS.md`).

use borsh::{BorshDeserialize, BorshSerialize};

use crate::evm::Call;
use crate::machine::{
    Action, Config, Draft, EpochState, Ledger, Op, OpStatus, Origin, Parked, Rejection, Slot,
    SlotStatus, Vault, Verifying, Which, STATE_VERSION,
};
use crate::policy::Policy;
use crate::types::Hash32;

#[derive(BorshSerialize, BorshDeserialize)]
pub struct VerifyingV1 {
    pub req: u64,
    pub which: Which,
    pub tx: Hash32,
    pub expected: Hash32,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct SlotV1 {
    pub call: Call,
    pub status: SlotStatus,
    pub main: Option<Draft>,
    pub cancel: Option<Draft>,
    pub probe: Option<Draft>,
    pub reserved_at_ms: u64,
    pub sign_unknown: bool,
    pub signing: Option<(u64, Which)>,
    pub verifying: Option<VerifyingV1>,
    pub cooldown_until_ms: u64,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct OpV1 {
    pub id: u64,
    pub action: Action,
    pub origin: Origin,
    pub created_ms: u64,
    pub slots: Vec<SlotV1>,
    pub cursor: u32,
    pub status: OpStatus,
    pub amount: u128,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct PendingCreditV1 {
    pub req: u64,
    pub tx: Hash32,
    pub log_index: u64,
    pub amount: u128,
    pub expected: Hash32,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct VaultV1 {
    pub config: Config,
    pub policy: Policy,
    pub agent_key: Option<String>,
    pub guardians: Vec<String>,
    pub next_nonce: u64,
    pub next_op: u64,
    pub next_req: u64,
    pub next_parked: u64,
    pub ops: Vec<OpV1>,
    pub active: Option<u64>,
    pub ledger: Ledger,
    pub epoch: EpochState,
    pub paused_until_ms: u64,
    pub pause_cooldown_until_ms: u64,
    pub parked: Vec<Parked>,
    pub credits: Vec<(Hash32, u64)>,
    pub pending_credit: Option<PendingCreditV1>,
    pub rejections: Vec<Rejection>,
    pub rejection_count: u64,
    pub upgrade_ready: Option<Hash32>,
}

/// Name recorded as the caller of a verify that was in flight during the migration.
pub const LEGACY_CALLER: &str = "legacy-v1";

impl From<SlotV1> for Slot {
    fn from(s: SlotV1) -> Self {
        Slot {
            call: s.call,
            status: s.status,
            main: s.main,
            cancel: s.cancel,
            probe: s.probe,
            reserved_at_ms: s.reserved_at_ms,
            sign_unknown: s.sign_unknown,
            signing: s.signing,
            // An in-flight verify keeps its request id so its callback still resolves.
            verifying: s
                .verifying
                .map(|v| Verifying {
                    req: v.req,
                    which: v.which,
                    tx: v.tx,
                    expected: v.expected,
                    caller: LEGACY_CALLER.to_string(),
                })
                .into_iter()
                .collect(),
            cooldowns: vec![],
        }
    }
}

impl From<OpV1> for Op {
    fn from(o: OpV1) -> Self {
        Op {
            id: o.id,
            action: o.action,
            origin: o.origin,
            created_ms: o.created_ms,
            slots: o.slots.into_iter().map(Slot::from).collect(),
            cursor: o.cursor,
            status: o.status,
            amount: o.amount,
        }
    }
}

impl From<VaultV1> for Vault {
    fn from(v: VaultV1) -> Self {
        Vault {
            config: v.config,
            policy: v.policy,
            agent_key: v.agent_key,
            guardians: v.guardians,
            next_nonce: v.next_nonce,
            next_op: v.next_op,
            next_req: v.next_req,
            next_parked: v.next_parked,
            ops: v.ops.into_iter().map(Op::from).collect(),
            active: v.active,
            ledger: v.ledger,
            epoch: v.epoch,
            paused_until_ms: v.paused_until_ms,
            pause_cooldown_until_ms: v.pause_cooldown_until_ms,
            parked: v.parked,
            // Old proofs carry no block number; with a floor of 0 they still block their own replay.
            credits: v.credits.into_iter().map(|(t, i)| (t, i, 0)).collect(),
            // A credit proof in flight is dropped: anyone can submit it again.
            pending_credits: vec![],
            rejections: v.rejections,
            rejection_count: v.rejection_count,
            upgrade_ready: v.upgrade_ready,
            credit_floor_block: 0,
            version: STATE_VERSION,
        }
    }
}
