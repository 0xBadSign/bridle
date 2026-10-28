//! The vault's state machine (design doc 18, section 4).
//!
//! Each public method takes the current time and the caller's role, checks the mandate, updates
//! state, and returns the effects the contract must execute (sign requests, verify requests, key
//! changes, events). Errors are [`Reject`] values; the contract records them in the public
//! rejection ledger instead of panicking.
//!
//! Rules this module enforces:
//! - one active operation at a time (global lock); nonces are reserved before signing and never
//!   rolled back;
//! - a slot counts as landed only after an MPC attestation of a transaction the vault itself signed
//!   (or, as a trusted fallback, a DAO `resolve`);
//! - reservations (principal, idle balance, outflow) are released only on proof;
//! - a sign timeout leaves the slot `SignUnknown`; anyone may retry or adopt a signature;
//! - failed verifies set a cooldown; nothing counts failures; "frozen" only means the active
//!   operation passed its settle deadline.

use borsh::{BorshDeserialize, BorshSerialize};
use omni_transaction::evm::EVMTransaction;
use serde::{Deserialize, Serialize};

use crate::evm::{self, Call, Chain, TxParams};
use crate::exposure::{exposure, Exposure};
use crate::foreign::{self, Hints};
use crate::policy::{self, Floors, Lane, Policy};
use crate::types::{Address, EvmAddr, Hash32, Hasher};

/// Time a failed verify blocks another verify of the same slot.
pub const VERIFY_COOLDOWN_MS: u64 = 60_000;
/// Bounded collections (storage-staking DoS, red-team N11).
pub const MAX_GUARDIANS: usize = 5;
pub const MAX_PARKED_OPEN: usize = 16;
pub const MAX_OPS_KEPT: usize = 64;
pub const MAX_REJECTIONS_KEPT: usize = 64;
pub const MAX_CREDITS_KEPT: usize = 512;

// ---------------------------------------------------------------------------------------------
// Types

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Caller {
    /// The owning Sputnik DAO (checked by predecessor in the contract).
    Dao,
    /// The agent's function-call key.
    Agent,
    /// A guardian's function-call key, by public key.
    Guardian(String),
    /// Anyone.
    Public,
}

/// What the vault can be asked to do with funds. There is no destination field anywhere.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    Supply {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    Withdraw {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    SendToTreasury {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    /// Withdraw all ledger principal back to the vault's own address.
    Unwind,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Which {
    /// The slot's own transaction.
    Main,
    /// A 0-value self-transfer at the same nonce with bumped fees.
    Cancel,
    /// A 0-value self-transfer at the next nonce; its landing proves the slot's nonce was consumed.
    Probe,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct SignedTx {
    pub hash: Hash32,
    /// `0x`-hex raw transaction, ready for `eth_sendRawTransaction` by anyone.
    pub raw: String,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Draft {
    pub call: Call,
    pub params: TxParams,
    pub payload: Hash32,
    pub signed: Vec<SignedTx>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotStatus {
    /// Not yet reserved (no nonce).
    Unreserved,
    /// Nonce reserved; signing / broadcasting / proving in progress.
    Open,
    /// Proved landed by an attestation of the given transaction.
    Landed { which: Which, tx: Hash32 },
    /// The nonce was consumed without a provable success (reverted), proved by a probe, or
    /// declared by the DAO. A later landing proof still reconciles upward.
    Reverted { by_dao: bool },
    /// The DAO declared the main transaction landed without an attestation (trusted fallback).
    TrustedLanded,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Slot {
    pub call: Call,
    pub status: SlotStatus,
    pub main: Option<Draft>,
    pub cancel: Option<Draft>,
    pub probe: Option<Draft>,
    pub reserved_at_ms: u64,
    /// A sign request timed out; a signature may still exist (red-team F3).
    pub sign_unknown: bool,
    pub signing: Option<(u64, Which)>,
    pub verifying: Option<Verifying>,
    pub cooldown_until_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Verifying {
    pub req: u64,
    pub which: Which,
    pub tx: Hash32,
    pub expected: Hash32,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Agent,
    Dao,
    Guardian,
    Parked,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum OpStatus {
    Active,
    Done,
    /// Ended without moving funds (a step reverted or was cancelled); reservations released.
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Op {
    pub id: u64,
    pub action: Action,
    pub origin: Origin,
    pub created_ms: u64,
    pub slots: Vec<Slot>,
    pub cursor: u32,
    pub status: OpStatus,
    /// Amount the operation reserved (resolved from `Unwind` at creation).
    #[serde(with = "crate::types::u128_str")]
    pub amount: u128,
}

/// USDC accounting of the vault's Base address, moved only by proofs (or DAO `resolve`).
#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct Ledger {
    /// Idle USDC at `D` that is not reserved.
    #[serde(with = "crate::types::u128_str")]
    pub idle: u128,
    /// Principal proved supplied to Aave.
    #[serde(with = "crate::types::u128_str")]
    pub principal: u128,
    /// In-flight supply (counts against the cap).
    #[serde(with = "crate::types::u128_str")]
    pub supplying: u128,
    /// In-flight withdraw (reserved out of principal).
    #[serde(with = "crate::types::u128_str")]
    pub withdrawing: u128,
    /// In-flight outflow to the treasury.
    #[serde(with = "crate::types::u128_str")]
    pub sending: u128,
    /// Total proved inbound deposits and outbound transfers (for the dashboard).
    #[serde(with = "crate::types::u128_str")]
    pub total_credited: u128,
    #[serde(with = "crate::types::u128_str")]
    pub total_sent: u128,
}

#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub struct EpochState {
    pub index: u64,
    pub agent_actions: u32,
    pub last_agent_ms: u64,
    #[serde(with = "crate::types::u128_str")]
    pub fast_outflow_used: u128,
    pub vetoes: Vec<(String, u32)>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParkedKind {
    Policy {
        policy: Policy,
    },
    Outflow {
        #[serde(with = "crate::types::u128_str")]
        amount: u128,
    },
    AddGuardian {
        public_key: String,
    },
    Upgrade {
        code_hash: Hash32,
    },
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum ParkedStatus {
    Waiting,
    Executed,
    Vetoed,
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Parked {
    pub id: u64,
    pub kind: ParkedKind,
    pub lane: Lane,
    pub created_ms: u64,
    pub unlock_ms: u64,
    pub expires_ms: u64,
    pub status: ParkedStatus,
    pub exposure_before: Exposure,
    pub exposure_after: Exposure,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct PendingCredit {
    pub req: u64,
    pub tx: Hash32,
    pub log_index: u64,
    #[serde(with = "crate::types::u128_str")]
    pub amount: u128,
    pub expected: Hash32,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Rejection {
    pub at_ms: u64,
    pub caller: Caller,
    pub method: String,
    pub reason: Reject,
}

/// Why a call was refused. Recorded on-chain; never a panic.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(tag = "reason", content = "detail", rename_all = "snake_case")]
pub enum Reject {
    NotAllowed,
    Paused,
    Busy,
    ZeroAmount,
    AboveAgentMax,
    QuotaExhausted,
    TooSoon,
    CapExceeded,
    InsufficientIdle,
    InsufficientPrincipal,
    NoSuchOp,
    NoSuchParked,
    WrongState(String),
    Cooldown,
    UnknownTx,
    NotYetUnlocked,
    ParkedExpired,
    VetoLimit,
    PauseTooLong,
    PauseCooldown,
    PolicyInvalid(String),
    NotTighter,
    TooManyGuardians,
    UnknownGuardian,
    TooManyParked,
    AlreadyConsumed,
    BadCreditSender,
    CodeHashMismatch,
    BeforeDeadline,
}

/// Something the contract must do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "effect", rename_all = "snake_case")]
pub enum Effect {
    Sign {
        op: u64,
        slot: u32,
        which: Which,
        req: u64,
        payload: Hash32,
    },
    Verify {
        op: u64,
        slot: u32,
        which: Which,
        req: u64,
        tx: Hash32,
        log_index: Option<u64>,
        expected: Hash32,
    },
    VerifyCredit {
        req: u64,
        tx: Hash32,
        log_index: u64,
        expected: Hash32,
    },
    AddGuardianKey {
        public_key: String,
    },
    DeleteKey {
        public_key: String,
    },
    SetAgentKey {
        old: Option<String>,
        new: String,
    },
    Event {
        name: String,
        data: String,
    },
}

pub type Out = Result<Vec<Effect>, Reject>;

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Config {
    pub chain: Chain,
    pub floors: Floors,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
pub struct Vault {
    pub config: Config,
    pub policy: Policy,
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
    pub parked: Vec<Parked>,
    pub credits: Vec<(Hash32, u64)>,
    pub pending_credit: Option<PendingCredit>,
    pub rejections: Vec<Rejection>,
    pub rejection_count: u64,
    pub upgrade_ready: Option<Hash32>,
}

// ---------------------------------------------------------------------------------------------
// Construction and helpers

impl Vault {
    pub fn new(config: Config, policy: Policy, start_nonce: u64) -> Result<Self, Reject> {
        policy::validate(&policy, &config.floors)
            .map_err(|e| Reject::PolicyInvalid(format!("{e:?}")))?;
        Ok(Vault {
            config,
            policy,
            agent_key: None,
            guardians: vec![],
            next_nonce: start_nonce,
            next_op: 0,
            next_req: 0,
            next_parked: 0,
            ops: vec![],
            active: None,
            ledger: Ledger::default(),
            epoch: EpochState::default(),
            paused_until_ms: 0,
            pause_cooldown_until_ms: 0,
            parked: vec![],
            credits: vec![],
            pending_credit: None,
            rejections: vec![],
            rejection_count: 0,
            upgrade_ready: None,
        })
    }

    /// Record a refusal in the bounded public ledger.
    pub fn record_rejection(&mut self, now: u64, caller: Caller, method: &str, reason: Reject) {
        self.rejection_count += 1;
        if self.rejections.len() >= MAX_REJECTIONS_KEPT {
            self.rejections.remove(0);
        }
        self.rejections.push(Rejection {
            at_ms: now,
            caller,
            method: method.to_string(),
            reason,
        });
    }

    fn req(&mut self) -> u64 {
        self.next_req += 1;
        self.next_req
    }

    fn roll_epoch(&mut self, now: u64) {
        let idx = now / self.policy.epoch_ms.max(1);
        if idx != self.epoch.index {
            self.epoch = EpochState {
                index: idx,
                last_agent_ms: self.epoch.last_agent_ms,
                ..Default::default()
            };
        }
    }

    pub fn paused(&self, now: u64) -> bool {
        now < self.paused_until_ms
    }

    pub fn op(&self, id: u64) -> Option<&Op> {
        self.ops.iter().find(|o| o.id == id)
    }

    fn op_mut(&mut self, id: u64) -> Option<&mut Op> {
        self.ops.iter_mut().find(|o| o.id == id)
    }

    /// True when the active operation's current slot passed its settle deadline unproved.
    pub fn frozen(&self, now: u64) -> bool {
        let Some(id) = self.active else { return false };
        let Some(op) = self.op(id) else { return false };
        let Some(slot) = op.slots.get(op.cursor as usize) else {
            return false;
        };
        slot.status == SlotStatus::Open
            && now > slot.reserved_at_ms + self.policy.settle_deadline_ms
    }

    pub fn exposure(&self) -> Exposure {
        exposure(&self.policy)
    }

    /// The unsigned transaction behind a slot's draft, for assembling signatures in the contract.
    pub fn tx_for(&self, op: u64, slot: u32, which: Which) -> Option<EVMTransaction> {
        let d = self.draft(op, slot, which)?;
        Some(evm::build(&self.config.chain, &d.call, &d.params))
    }

    pub fn draft(&self, op: u64, slot: u32, which: Which) -> Option<&Draft> {
        let s = self.op(op)?.slots.get(slot as usize)?;
        match which {
            Which::Main => s.main.as_ref(),
            Which::Cancel => s.cancel.as_ref(),
            Which::Probe => s.probe.as_ref(),
        }
    }

    fn prune_ops(&mut self) {
        while self.ops.len() > MAX_OPS_KEPT {
            if let Some(pos) = self.ops.iter().position(|o| o.status != OpStatus::Active) {
                self.ops.remove(pos);
            } else {
                break;
            }
        }
    }
}

fn event(name: &str, data: String) -> Effect {
    Effect::Event {
        name: name.to_string(),
        data,
    }
}

fn new_slot(call: Call) -> Slot {
    Slot {
        call,
        status: SlotStatus::Unreserved,
        main: None,
        cancel: None,
        probe: None,
        reserved_at_ms: 0,
        sign_unknown: false,
        signing: None,
        verifying: None,
        cooldown_until_ms: 0,
    }
}

// ---------------------------------------------------------------------------------------------
// Starting operations

impl Vault {
    /// The agent's only entry point. Only `Supply` and `Withdraw`, within caps, quota and interval.
    pub fn agent_act<H: Hasher>(&mut self, h: &H, now: u64, action: Action) -> Out {
        self.roll_epoch(now);
        if self.paused(now) {
            return Err(Reject::Paused);
        }
        let amount = match action {
            Action::Supply { amount } | Action::Withdraw { amount } => amount,
            _ => return Err(Reject::NotAllowed),
        };
        if amount > self.policy.agent_max_per_action {
            return Err(Reject::AboveAgentMax);
        }
        if self.epoch.agent_actions >= self.policy.agent_quota_per_epoch {
            return Err(Reject::QuotaExhausted);
        }
        if self.epoch.last_agent_ms > 0
            && now < self.epoch.last_agent_ms + self.policy.agent_min_interval_ms
        {
            return Err(Reject::TooSoon);
        }
        let fx = self.start(h, now, action, Origin::Agent)?;
        self.epoch.agent_actions += 1;
        self.epoch.last_agent_ms = now;
        Ok(fx)
    }

    /// A FAST order from the DAO. Outflow above the per-epoch fast limit is parked instead.
    pub fn dao_act<H: Hasher>(&mut self, h: &H, now: u64, action: Action) -> Out {
        self.roll_epoch(now);
        match action {
            Action::Supply { .. } if self.paused(now) => return Err(Reject::Paused),
            Action::SendToTreasury { amount } => {
                if self.paused(now) {
                    return Err(Reject::Paused);
                }
                let left = self
                    .policy
                    .fast_outflow_per_epoch
                    .saturating_sub(self.epoch.fast_outflow_used);
                if amount > left {
                    return self.park(now, ParkedKind::Outflow { amount }, Lane::Long);
                }
                let fx = self.start(h, now, action, Origin::Dao)?;
                self.epoch.fast_outflow_used += amount;
                return Ok(fx);
            }
            _ => {}
        }
        self.start(h, now, action, Origin::Dao)
    }

    /// Guardian exit: pull principal back to the vault's own address. Nothing leaves `D`.
    pub fn guardian_unwind<H: Hasher>(&mut self, h: &H, now: u64, g: &str) -> Out {
        self.require_guardian(g)?;
        self.start(h, now, Action::Unwind, Origin::Guardian)
    }

    /// Reserve funds, create the operation and request the first signature.
    fn start<H: Hasher>(&mut self, h: &H, now: u64, action: Action, origin: Origin) -> Out {
        if self.active.is_some() {
            return Err(Reject::Busy);
        }
        let l = &self.ledger;
        let (amount, calls) = match action {
            Action::Supply { amount } => {
                if amount == 0 {
                    return Err(Reject::ZeroAmount);
                }
                if amount > l.idle {
                    return Err(Reject::InsufficientIdle);
                }
                if l.principal + l.supplying + amount > self.policy.supply_cap {
                    return Err(Reject::CapExceeded);
                }
                (
                    amount,
                    vec![Call::Approve { amount }, Call::Supply { amount }],
                )
            }
            Action::Withdraw { amount } => {
                if amount == 0 {
                    return Err(Reject::ZeroAmount);
                }
                if amount > l.principal - l.withdrawing {
                    return Err(Reject::InsufficientPrincipal);
                }
                (amount, vec![Call::Withdraw { amount }])
            }
            Action::Unwind => {
                let amount = l.principal - l.withdrawing;
                if amount == 0 {
                    return Err(Reject::ZeroAmount);
                }
                (amount, vec![Call::Withdraw { amount }])
            }
            Action::SendToTreasury { amount } => {
                if amount == 0 {
                    return Err(Reject::ZeroAmount);
                }
                if amount > l.idle {
                    return Err(Reject::InsufficientIdle);
                }
                (
                    amount,
                    vec![Call::Transfer {
                        to: self.policy.treasury,
                        amount,
                    }],
                )
            }
        };
        // Reserve.
        let l = &mut self.ledger;
        match action {
            Action::Supply { .. } => {
                l.idle -= amount;
                l.supplying += amount;
            }
            Action::Withdraw { .. } | Action::Unwind => l.withdrawing += amount,
            Action::SendToTreasury { .. } => {
                l.idle -= amount;
                l.sending += amount;
            }
        }
        let id = self.next_op;
        self.next_op += 1;
        self.ops.push(Op {
            id,
            action,
            origin,
            created_ms: now,
            slots: calls.into_iter().map(new_slot).collect(),
            cursor: 0,
            status: OpStatus::Active,
            amount,
        });
        self.active = Some(id);
        self.prune_ops();
        let mut fx = vec![event(
            "op_started",
            format!(
                r#"{{"op":{id},"origin":"{origin:?}","action":"{action:?}","amount":"{amount}"}}"#
            ),
        )];
        fx.extend(self.reserve_and_sign(h, now, id)?);
        Ok(fx)
    }

    /// Reserve a nonce for the current slot (if not yet) and request its signature.
    fn reserve_and_sign<H: Hasher>(&mut self, h: &H, now: u64, id: u64) -> Out {
        let (max_fee, prio) = policy::normal_fees(&self.policy);
        let chain = self.config.chain.clone();
        let nonce = self.next_nonce;
        let req = self.next_req + 1;
        let op = self.op_mut(id).ok_or(Reject::NoSuchOp)?;
        let cursor = op.cursor;
        let slot = op
            .slots
            .get_mut(cursor as usize)
            .ok_or(Reject::WrongState("no slot".into()))?;
        if slot.signing.is_some() {
            return Err(Reject::WrongState("sign in flight".into()));
        }
        let mut reserved = false;
        if slot.status == SlotStatus::Unreserved {
            let params = TxParams {
                nonce,
                gas_limit: evm::gas_limit(&slot.call),
                max_fee_per_gas: max_fee,
                max_priority_fee_per_gas: prio,
            };
            let tx = evm::build(&chain, &slot.call, &params);
            let payload = Hash32(evm::signing_payload(h, &tx));
            slot.main = Some(Draft {
                call: slot.call,
                params,
                payload,
                signed: vec![],
            });
            slot.status = SlotStatus::Open;
            slot.reserved_at_ms = now;
            reserved = true;
        } else if slot.status != SlotStatus::Open {
            return Err(Reject::WrongState("slot closed".into()));
        }
        let payload = slot
            .main
            .as_ref()
            .map(|d| d.payload)
            .ok_or(Reject::WrongState("no draft".into()))?;
        slot.signing = Some((req, Which::Main));
        if reserved {
            self.next_nonce += 1;
        }
        self.next_req = req;
        Ok(vec![Effect::Sign {
            op: id,
            slot: cursor,
            which: Which::Main,
            req,
            payload,
        }])
    }

    /// Anyone: request the signature of the current slot of the active operation (next step of a
    /// multi-step operation, or a retry after `SignUnknown`).
    pub fn advance<H: Hasher>(&mut self, h: &H, now: u64) -> Out {
        let id = self.active.ok_or(Reject::NoSuchOp)?;
        let op = self.op(id).ok_or(Reject::NoSuchOp)?;
        let slot = &op.slots[op.cursor as usize];
        let fresh = slot.status == SlotStatus::Unreserved;
        let retry = slot.status == SlotStatus::Open
            && slot.sign_unknown
            && slot.main.as_ref().is_some_and(|d| d.signed.is_empty());
        if !fresh && !retry {
            return Err(Reject::WrongState("nothing to sign".into()));
        }
        self.reserve_and_sign(h, now, id)
    }
}

// ---------------------------------------------------------------------------------------------
// Signing callbacks

impl Vault {
    /// Result of a sign request. `signed` is `Some((raw, hash))` only if the contract verified that
    /// the signature recovers to the vault's derived key over the stored payload.
    pub fn on_signed(
        &mut self,
        now: u64,
        op: u64,
        slot: u32,
        req: u64,
        signed: Option<SignedTx>,
    ) -> Out {
        let _ = now;
        let o = self.op_mut(op).ok_or(Reject::NoSuchOp)?;
        let s = o.slots.get_mut(slot as usize).ok_or(Reject::NoSuchOp)?;
        let Some((want, which)) = s.signing else {
            return Err(Reject::WrongState("no sign in flight".into()));
        };
        if want != req {
            return Err(Reject::WrongState("stale sign callback".into()));
        }
        s.signing = None;
        match signed {
            Some(tx) => {
                let d = match which {
                    Which::Main => s.main.as_mut(),
                    Which::Cancel => s.cancel.as_mut(),
                    Which::Probe => s.probe.as_mut(),
                }
                .ok_or(Reject::WrongState("no draft".into()))?;
                if !d.signed.iter().any(|x| x.hash == tx.hash) {
                    d.signed.push(tx.clone());
                }
                Ok(vec![event(
                    "signed",
                    format!(
                        r#"{{"op":{op},"slot":{slot},"which":"{which:?}","tx":"{}"}}"#,
                        crate::types::hex0x(&tx.hash.0)
                    ),
                )])
            }
            None => {
                // A timeout does not prove "not signed" (red-team F3): keep the nonce reserved.
                if which == Which::Main {
                    s.sign_unknown = true;
                }
                Ok(vec![event(
                    "sign_unknown",
                    format!(r#"{{"op":{op},"slot":{slot},"which":"{which:?}"}}"#),
                )])
            }
        }
    }

    /// Anyone: add a signature found elsewhere (for example a late MPC response). The contract has
    /// verified it recovers to the vault's key over the draft's payload and built `tx` from it.
    pub fn adopt_signature(&mut self, op: u64, slot: u32, which: Which, tx: SignedTx) -> Out {
        let o = self.op_mut(op).ok_or(Reject::NoSuchOp)?;
        let s = o.slots.get_mut(slot as usize).ok_or(Reject::NoSuchOp)?;
        if s.status != SlotStatus::Open {
            return Err(Reject::WrongState("slot closed".into()));
        }
        let d = match which {
            Which::Main => s.main.as_mut(),
            Which::Cancel => s.cancel.as_mut(),
            Which::Probe => s.probe.as_mut(),
        }
        .ok_or(Reject::WrongState("no draft".into()))?;
        if !d.signed.iter().any(|x| x.hash == tx.hash) {
            d.signed.push(tx.clone());
        }
        Ok(vec![event(
            "signature_adopted",
            format!(
                r#"{{"op":{op},"slot":{slot},"tx":"{}"}}"#,
                crate::types::hex0x(&tx.hash.0)
            ),
        )])
    }
}

// ---------------------------------------------------------------------------------------------
// Settling

impl Vault {
    /// Anyone: ask the MPC to attest that one of the slot's signed transactions succeeded.
    pub fn settle<H: Hasher>(
        &mut self,
        h: &H,
        now: u64,
        op: u64,
        slot: u32,
        tx: Hash32,
        hints: Hints,
    ) -> Out {
        let chain = self.config.chain.clone();
        let req = self.next_req + 1;
        let o = self.op_mut(op).ok_or(Reject::NoSuchOp)?;
        let s = o.slots.get_mut(slot as usize).ok_or(Reject::NoSuchOp)?;
        // Open slots settle normally; reverted slots may still reconcile upward with a late proof.
        let reconciling = matches!(s.status, SlotStatus::Reverted { .. });
        if s.status != SlotStatus::Open && !reconciling {
            return Err(Reject::WrongState("slot not open".into()));
        }
        if s.verifying.is_some() {
            return Err(Reject::WrongState("verify in flight".into()));
        }
        if now < s.cooldown_until_ms {
            return Err(Reject::Cooldown);
        }
        let has = |d: &Option<Draft>| {
            d.as_ref()
                .is_some_and(|d| d.signed.iter().any(|x| x.hash == tx))
        };
        let which = if has(&s.main) {
            Which::Main
        } else if has(&s.cancel) && !reconciling {
            Which::Cancel
        } else if has(&s.probe) && !reconciling {
            Which::Probe
        } else {
            return Err(Reject::UnknownTx);
        };
        let log = if which == Which::Main {
            foreign::expected_log(&chain, &s.call)
        } else {
            None
        };
        let expected = Hash32(foreign::expected_payload_hash(
            h,
            &tx.0,
            &hints,
            log.as_ref(),
        ));
        s.verifying = Some(Verifying {
            req,
            which,
            tx,
            expected,
        });
        self.next_req = req;
        Ok(vec![Effect::Verify {
            op,
            slot,
            which,
            req,
            tx,
            log_index: log.as_ref().map(|_| hints.log_index),
            expected,
        }])
    }

    /// Result of a verify request. `ok` is true only if the contract recovered the attestation
    /// signature against the pinned ForeignTx key and the payload hash equals `expected`.
    pub fn on_verified<H: Hasher>(
        &mut self,
        h: &H,
        now: u64,
        op: u64,
        slot: u32,
        req: u64,
        ok: bool,
    ) -> Out {
        let o = self.op_mut(op).ok_or(Reject::NoSuchOp)?;
        let s = o.slots.get_mut(slot as usize).ok_or(Reject::NoSuchOp)?;
        let Some(v) = s.verifying.clone() else {
            return Err(Reject::WrongState("no verify in flight".into()));
        };
        if v.req != req {
            return Err(Reject::WrongState("stale verify callback".into()));
        }
        s.verifying = None;
        if !ok {
            s.cooldown_until_ms = now + VERIFY_COOLDOWN_MS;
            return Ok(vec![event(
                "not_attested",
                format!(r#"{{"op":{op},"slot":{slot}}}"#),
            )]);
        }
        let mut fx = vec![event(
            "attested",
            format!(
                r#"{{"op":{op},"slot":{slot},"which":"{:?}","tx":"{}"}}"#,
                v.which,
                crate::types::hex0x(&v.tx.0)
            ),
        )];
        match v.which {
            Which::Main => {
                if matches!(s.status, SlotStatus::Reverted { .. }) {
                    s.status = SlotStatus::Landed {
                        which: Which::Main,
                        tx: v.tx,
                    };
                    fx.extend(self.reconcile_landed(op, slot));
                    return Ok(fx);
                }
                s.status = SlotStatus::Landed {
                    which: Which::Main,
                    tx: v.tx,
                };
                fx.extend(self.after_slot(h, now, op, slot, true)?);
            }
            Which::Cancel => {
                s.status = SlotStatus::Landed {
                    which: Which::Cancel,
                    tx: v.tx,
                };
                fx.extend(self.after_slot(h, now, op, slot, false)?);
            }
            Which::Probe => {
                // The probe sits at nonce + 1, so the slot's nonce was consumed by one of the vault's
                // own signatures without a provable success: treat as reverted.
                s.status = SlotStatus::Reverted { by_dao: false };
                fx.extend(self.after_slot(h, now, op, slot, false)?);
            }
        }
        Ok(fx)
    }

    /// Ledger and progress after a slot closed. `success` means the main transaction landed.
    fn after_slot<H: Hasher>(&mut self, h: &H, now: u64, op: u64, slot: u32, success: bool) -> Out {
        let _ = h;
        let _ = now;
        let o = self.op(op).ok_or(Reject::NoSuchOp)?.clone();
        let call = o.slots[slot as usize].call;
        let a = o.amount;
        let l = &mut self.ledger;
        let mut finished = false;
        let mut aborted = false;
        let mut cleanup = false;
        match (call, success) {
            (Call::Approve { amount }, true) if amount > 0 => {}
            (Call::Approve { amount }, false) if amount > 0 => {
                l.idle += a;
                l.supplying -= a;
                aborted = true;
            }
            (Call::Approve { .. }, _) => finished = true, // cleanup approve(0)
            (Call::Supply { .. }, true) => {
                l.supplying -= a;
                l.principal += a;
                finished = true;
            }
            (Call::Supply { .. }, false) => {
                l.supplying -= a;
                l.idle += a;
                cleanup = true;
            }
            (Call::Withdraw { .. }, true) => {
                l.withdrawing -= a;
                l.principal -= a;
                l.idle += a;
                finished = true;
            }
            (Call::Withdraw { .. }, false) => {
                l.withdrawing -= a;
                aborted = true;
            }
            (Call::Transfer { .. }, true) => {
                l.sending -= a;
                l.total_sent += a;
                finished = true;
            }
            (Call::Transfer { .. }, false) => {
                l.sending -= a;
                l.idle += a;
                aborted = true;
            }
            (Call::Cancel, _) => finished = true,
        }
        let o = self.op_mut(op).ok_or(Reject::NoSuchOp)?;
        if cleanup {
            // The approve landed but the supply did not: reset the allowance before the lock opens.
            o.slots.push(new_slot(Call::Approve { amount: 0 }));
            o.cursor = o.slots.len() as u32 - 1;
            return Ok(vec![event("cleanup_queued", format!(r#"{{"op":{op}}}"#))]);
        }
        let last = (slot as usize) + 1 >= o.slots.len();
        if aborted {
            o.status = OpStatus::Aborted;
            self.active = None;
            return Ok(vec![event("op_aborted", format!(r#"{{"op":{op}}}"#))]);
        }
        if finished || last {
            let had_cleanup = matches!(
                o.slots.last().map(|s| s.call),
                Some(Call::Approve { amount: 0 })
            );
            let status = if had_cleanup {
                OpStatus::Aborted
            } else {
                OpStatus::Done
            };
            o.status = status;
            self.active = None;
            return Ok(vec![event(
                "op_done",
                format!(r#"{{"op":{op},"status":"{status:?}"}}"#),
            )]);
        }
        o.cursor = slot + 1;
        Ok(vec![event(
            "op_next_step",
            format!(r#"{{"op":{op},"slot":{}}}"#, slot + 1),
        )])
    }

    /// A slot already resolved as reverted later proved landed: move the ledger the other way.
    fn reconcile_landed(&mut self, op: u64, slot: u32) -> Vec<Effect> {
        let Some(o) = self.op(op) else { return vec![] };
        let call = o.slots[slot as usize].call;
        let a = o.amount;
        let l = &mut self.ledger;
        match call {
            Call::Supply { .. } => {
                l.idle = l.idle.saturating_sub(a);
                l.principal += a;
            }
            Call::Withdraw { .. } => {
                l.principal = l.principal.saturating_sub(a);
                l.idle += a;
            }
            Call::Transfer { .. } => {
                l.idle = l.idle.saturating_sub(a);
                l.total_sent += a;
            }
            _ => {}
        }
        vec![event(
            "reconciled",
            format!(r#"{{"op":{op},"slot":{slot}}}"#),
        )]
    }
}

// ---------------------------------------------------------------------------------------------
// Stuck transactions: cancel, probe, DAO resolve

impl Vault {
    /// Replace the current slot's transaction with a 0-value self-transfer at the same nonce.
    /// DAO and guardians may do it any time; anyone after the settle deadline.
    pub fn cancel<H: Hasher>(&mut self, h: &H, now: u64, caller: &Caller) -> Out {
        if let Caller::Guardian(g) = caller {
            self.require_guardian(g)?;
        }
        let deadline = self.policy.settle_deadline_ms;
        let chain = self.config.chain.clone();
        let req = self.next_req + 1;
        let id = self.active.ok_or(Reject::NoSuchOp)?;
        let o = self.op_mut(id).ok_or(Reject::NoSuchOp)?;
        let cursor = o.cursor;
        let s = &mut o.slots[cursor as usize];
        if s.status != SlotStatus::Open {
            return Err(Reject::WrongState("slot not open".into()));
        }
        if matches!(caller, Caller::Public | Caller::Agent) && now <= s.reserved_at_ms + deadline {
            return Err(Reject::BeforeDeadline);
        }
        if s.signing.is_some() {
            return Err(Reject::WrongState("sign in flight".into()));
        }
        let main = s
            .main
            .as_ref()
            .ok_or(Reject::WrongState("no draft".into()))?;
        if s.cancel.is_none() {
            let (f, p) = policy::bumped_fees(
                main.params.max_fee_per_gas,
                main.params.max_priority_fee_per_gas,
            );
            let params = TxParams {
                nonce: main.params.nonce,
                gas_limit: evm::gas_limit(&Call::Cancel),
                max_fee_per_gas: f,
                max_priority_fee_per_gas: p,
            };
            let tx = evm::build(&chain, &Call::Cancel, &params);
            let payload = Hash32(evm::signing_payload(h, &tx));
            s.cancel = Some(Draft {
                call: Call::Cancel,
                params,
                payload,
                signed: vec![],
            });
        }
        let payload = s
            .cancel
            .as_ref()
            .map(|d| d.payload)
            .unwrap_or(Hash32([0; 32]));
        s.signing = Some((req, Which::Cancel));
        self.next_req = req;
        Ok(vec![Effect::Sign {
            op: id,
            slot: cursor,
            which: Which::Cancel,
            req,
            payload,
        }])
    }

    /// Anyone, after the deadline: sign a 0-value self-transfer at the next nonce. If it lands, the
    /// slot's nonce was consumed (for example by a reverted transaction, which the MPC never attests).
    pub fn probe<H: Hasher>(&mut self, h: &H, now: u64) -> Out {
        let deadline = self.policy.settle_deadline_ms;
        let (max_fee, prio) = policy::normal_fees(&self.policy);
        let chain = self.config.chain.clone();
        let req = self.next_req + 1;
        let next_nonce = self.next_nonce;
        let id = self.active.ok_or(Reject::NoSuchOp)?;
        let o = self.op_mut(id).ok_or(Reject::NoSuchOp)?;
        let cursor = o.cursor;
        let s = &mut o.slots[cursor as usize];
        if s.status != SlotStatus::Open {
            return Err(Reject::WrongState("slot not open".into()));
        }
        if now <= s.reserved_at_ms + deadline {
            return Err(Reject::BeforeDeadline);
        }
        if s.signing.is_some() {
            return Err(Reject::WrongState("sign in flight".into()));
        }
        let main = s
            .main
            .as_ref()
            .ok_or(Reject::WrongState("no draft".into()))?;
        let mut bump_nonce = false;
        if s.probe.is_none() {
            let nonce = main.params.nonce + 1;
            if next_nonce != nonce {
                return Err(Reject::WrongState("nonce moved".into()));
            }
            let params = TxParams {
                nonce,
                gas_limit: evm::gas_limit(&Call::Cancel),
                max_fee_per_gas: max_fee,
                max_priority_fee_per_gas: prio,
            };
            let tx = evm::build(&chain, &Call::Cancel, &params);
            let payload = Hash32(evm::signing_payload(h, &tx));
            s.probe = Some(Draft {
                call: Call::Cancel,
                params,
                payload,
                signed: vec![],
            });
            bump_nonce = true;
        }
        let payload = s
            .probe
            .as_ref()
            .map(|d| d.payload)
            .unwrap_or(Hash32([0; 32]));
        s.signing = Some((req, Which::Probe));
        if bump_nonce {
            self.next_nonce += 1;
        }
        self.next_req = req;
        Ok(vec![Effect::Sign {
            op: id,
            slot: cursor,
            which: Which::Probe,
            req,
            payload,
        }])
    }

    /// DAO fallback when no proof can be produced: declare the active slot reverted or landed.
    /// This trusts the DAO for one ledger fact and is recorded as such.
    pub fn dao_resolve<H: Hasher>(&mut self, h: &H, now: u64, landed: bool) -> Out {
        let id = self.active.ok_or(Reject::NoSuchOp)?;
        let o = self.op_mut(id).ok_or(Reject::NoSuchOp)?;
        let cursor = o.cursor;
        let s = &mut o.slots[cursor as usize];
        if s.status != SlotStatus::Open || s.verifying.is_some() || s.signing.is_some() {
            return Err(Reject::WrongState("slot busy or closed".into()));
        }
        s.status = if landed {
            SlotStatus::TrustedLanded
        } else {
            SlotStatus::Reverted { by_dao: true }
        };
        let mut fx = vec![event(
            "dao_resolved",
            format!(r#"{{"op":{id},"slot":{cursor},"landed":{landed}}}"#),
        )];
        fx.extend(self.after_slot(h, now, id, cursor, landed)?);
        Ok(fx)
    }
}

// ---------------------------------------------------------------------------------------------
// Inbound deposits

impl Vault {
    /// Anyone: credit an inbound USDC transfer to the vault's address once the MPC attests it.
    pub fn credit_deposit<H: Hasher>(
        &mut self,
        h: &H,
        tx: Hash32,
        hints: Hints,
        from: EvmAddr,
        amount: u128,
    ) -> Out {
        let c = &self.config.chain;
        if from == c.vault || from == c.pool || from == c.atoken || from.0 == [0u8; 20] {
            return Err(Reject::BadCreditSender);
        }
        if amount == 0 {
            return Err(Reject::ZeroAmount);
        }
        if self
            .credits
            .iter()
            .any(|(t, i)| *t == tx && *i == hints.log_index)
        {
            return Err(Reject::AlreadyConsumed);
        }
        // A vault-signed transaction is never a deposit.
        let ours = self.ops.iter().any(|o| {
            o.slots.iter().any(|s| {
                [&s.main, &s.cancel, &s.probe].iter().any(|d| {
                    d.as_ref()
                        .is_some_and(|d| d.signed.iter().any(|x| x.hash == tx))
                })
            })
        });
        if ours {
            return Err(Reject::BadCreditSender);
        }
        if self.pending_credit.is_some() {
            return Err(Reject::Busy);
        }
        let log = foreign::inbound_transfer_log(c, &from.0, amount);
        let expected = Hash32(foreign::expected_payload_hash(h, &tx.0, &hints, Some(&log)));
        let req = self.req();
        self.pending_credit = Some(PendingCredit {
            req,
            tx,
            log_index: hints.log_index,
            amount,
            expected,
        });
        Ok(vec![Effect::VerifyCredit {
            req,
            tx,
            log_index: hints.log_index,
            expected,
        }])
    }

    pub fn on_credit_verified(&mut self, req: u64, ok: bool) -> Out {
        let Some(p) = self.pending_credit.clone() else {
            return Err(Reject::WrongState("no credit in flight".into()));
        };
        if p.req != req {
            return Err(Reject::WrongState("stale credit callback".into()));
        }
        self.pending_credit = None;
        if !ok {
            return Ok(vec![event(
                "credit_not_attested",
                format!(r#"{{"tx":"{}"}}"#, crate::types::hex0x(&p.tx.0)),
            )]);
        }
        if self.credits.len() >= MAX_CREDITS_KEPT {
            self.credits.remove(0);
        }
        self.credits.push((p.tx, p.log_index));
        self.ledger.idle += p.amount;
        self.ledger.total_credited += p.amount;
        Ok(vec![event(
            "credited",
            format!(
                r#"{{"tx":"{}","amount":"{}"}}"#,
                crate::types::hex0x(&p.tx.0),
                p.amount
            ),
        )])
    }
}

// ---------------------------------------------------------------------------------------------
// Governance: policy, parking lane, guardians, keys, upgrade

impl Vault {
    fn park(&mut self, now: u64, kind: ParkedKind, lane: Lane) -> Out {
        let open = self
            .parked
            .iter()
            .filter(|p| p.status == ParkedStatus::Waiting)
            .count();
        if open >= MAX_PARKED_OPEN {
            return Err(Reject::TooManyParked);
        }
        let window = match lane {
            Lane::Fast => 0,
            Lane::Short => self.policy.short_window_ms,
            Lane::Long => self.policy.long_window_ms,
        };
        let before = self.exposure();
        let after = match &kind {
            ParkedKind::Policy { policy } => exposure(policy),
            _ => before.clone(),
        };
        let id = self.next_parked;
        self.next_parked += 1;
        let unlock = now + window;
        self.parked.push(Parked {
            id,
            kind,
            lane,
            created_ms: now,
            unlock_ms: unlock,
            expires_ms: unlock + 2 * self.policy.long_window_ms,
            status: ParkedStatus::Waiting,
            exposure_before: before,
            exposure_after: after,
        });
        // Keep closed items bounded.
        while self.parked.len() > MAX_PARKED_OPEN * 4 {
            if let Some(pos) = self
                .parked
                .iter()
                .position(|p| p.status != ParkedStatus::Waiting)
            {
                self.parked.remove(pos);
            } else {
                break;
            }
        }
        Ok(vec![event(
            "parked",
            format!(r#"{{"id":{id},"lane":"{lane:?}","unlock_ms":{unlock}}}"#),
        )])
    }

    /// DAO: change the policy. Tightening applies now; anything else waits in the lane.
    pub fn propose_policy(&mut self, now: u64, new: Policy) -> Out {
        policy::validate(&new, &self.config.floors)
            .map_err(|e| Reject::PolicyInvalid(format!("{e:?}")))?;
        match policy::classify(&self.policy, &new) {
            Lane::Fast => {
                self.policy = new;
                Ok(vec![event("policy_tightened", "{}".into())])
            }
            lane => self.park(now, ParkedKind::Policy { policy: new }, lane),
        }
    }

    /// Guardian: tighten only. Anything that loosens or touches a SLOW-only field is refused.
    pub fn guardian_tighten(&mut self, g: &str, new: Policy) -> Out {
        self.require_guardian(g)?;
        policy::validate(&new, &self.config.floors)
            .map_err(|e| Reject::PolicyInvalid(format!("{e:?}")))?;
        if policy::classify(&self.policy, &new) != Lane::Fast {
            return Err(Reject::NotTighter);
        }
        self.policy = new;
        Ok(vec![event(
            "policy_tightened_by_guardian",
            format!(r#"{{"guardian":"{g}"}}"#),
        )])
    }

    /// DAO: propose a guardian (parked, long window). Removing one is FAST.
    pub fn propose_guardian(&mut self, now: u64, public_key: String) -> Out {
        if self.guardians.len() >= MAX_GUARDIANS {
            return Err(Reject::TooManyGuardians);
        }
        self.park(now, ParkedKind::AddGuardian { public_key }, Lane::Long)
    }

    pub fn remove_guardian(&mut self, public_key: &str) -> Out {
        let pos = self
            .guardians
            .iter()
            .position(|g| g == public_key)
            .ok_or(Reject::UnknownGuardian)?;
        self.guardians.remove(pos);
        Ok(vec![
            Effect::DeleteKey {
                public_key: public_key.to_string(),
            },
            event(
                "guardian_removed",
                format!(r#"{{"guardian":"{public_key}"}}"#),
            ),
        ])
    }

    /// DAO: replace the agent key (same shape: `agent_act` only, same allowance).
    pub fn set_agent_key(&mut self, new: String) -> Out {
        let old = self.agent_key.replace(new.clone());
        Ok(vec![
            Effect::SetAgentKey { old, new },
            event("agent_key_set", "{}".into()),
        ])
    }

    /// DAO: park an upgrade to the given code hash (long window, unbounded exposure).
    pub fn propose_upgrade(&mut self, now: u64, code_hash: Hash32) -> Out {
        self.park(now, ParkedKind::Upgrade { code_hash }, Lane::Long)
    }

    /// Anyone: execute a parked item after its window. Takes no arguments but the id.
    pub fn execute<H: Hasher>(&mut self, h: &H, now: u64, id: u64) -> Out {
        self.roll_epoch(now);
        let idx = self
            .parked
            .iter()
            .position(|p| p.id == id)
            .ok_or(Reject::NoSuchParked)?;
        let p = self.parked[idx].clone();
        if p.status != ParkedStatus::Waiting {
            return Err(Reject::WrongState(format!("{:?}", p.status)));
        }
        if now < p.unlock_ms {
            return Err(Reject::NotYetUnlocked);
        }
        if now > p.expires_ms {
            self.parked[idx].status = ParkedStatus::Expired;
            return Err(Reject::ParkedExpired);
        }
        let mut fx = match p.kind {
            ParkedKind::Policy { policy } => {
                policy::validate(&policy, &self.config.floors)
                    .map_err(|e| Reject::PolicyInvalid(format!("{e:?}")))?;
                self.policy = policy;
                vec![event("policy_changed", format!(r#"{{"parked":{id}}}"#))]
            }
            ParkedKind::Outflow { amount } => {
                if self.paused(now) {
                    return Err(Reject::Paused);
                }
                self.start(h, now, Action::SendToTreasury { amount }, Origin::Parked)?
            }
            ParkedKind::AddGuardian { public_key } => {
                if self.guardians.len() >= MAX_GUARDIANS {
                    return Err(Reject::TooManyGuardians);
                }
                if !self.guardians.contains(&public_key) {
                    self.guardians.push(public_key.clone());
                }
                vec![Effect::AddGuardianKey { public_key }]
            }
            ParkedKind::Upgrade { code_hash } => {
                self.upgrade_ready = Some(code_hash);
                vec![event(
                    "upgrade_ready",
                    format!(r#"{{"code_hash":"{}"}}"#, crate::types::hex0x(&code_hash.0)),
                )]
            }
        };
        self.parked[idx].status = ParkedStatus::Executed;
        fx.push(event("parked_executed", format!(r#"{{"id":{id}}}"#)));
        Ok(fx)
    }

    /// The contract calls this with `sha256(code)` before deploying an upgrade.
    pub fn take_upgrade(&mut self, code_hash: Hash32) -> Out {
        match self.upgrade_ready {
            Some(h) if h == code_hash => {
                self.upgrade_ready = None;
                Ok(vec![event("upgrading", "{}".into())])
            }
            Some(_) => Err(Reject::CodeHashMismatch),
            None => Err(Reject::NotYetUnlocked),
        }
    }

    fn require_guardian(&self, g: &str) -> Result<(), Reject> {
        if self.guardians.iter().any(|x| x == g) {
            Ok(())
        } else {
            Err(Reject::UnknownGuardian)
        }
    }

    /// Guardian: veto a waiting parked item. Limited per guardian per epoch.
    pub fn guardian_veto(&mut self, now: u64, g: &str, id: u64) -> Out {
        self.require_guardian(g)?;
        self.roll_epoch(now);
        let used = self
            .epoch
            .vetoes
            .iter()
            .find(|(k, _)| k == g)
            .map(|(_, n)| *n)
            .unwrap_or(0);
        if used >= self.policy.max_vetoes_per_epoch {
            return Err(Reject::VetoLimit);
        }
        let p = self
            .parked
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(Reject::NoSuchParked)?;
        if p.status != ParkedStatus::Waiting {
            return Err(Reject::WrongState(format!("{:?}", p.status)));
        }
        p.status = ParkedStatus::Vetoed;
        match self.epoch.vetoes.iter_mut().find(|(k, _)| k == g) {
            Some(e) => e.1 += 1,
            None => self.epoch.vetoes.push((g.to_string(), 1)),
        }
        Ok(vec![event(
            "vetoed",
            format!(r#"{{"id":{id},"guardian":"{g}"}}"#),
        )])
    }

    /// Guardian: pause new agent actions, supplies and outflows. Expires, has a cooldown equal to
    /// its length, and the DAO can lift it at once. Withdraw, unwind, cancel and settle still work.
    pub fn guardian_pause(&mut self, now: u64, g: &str, duration_ms: u64) -> Out {
        self.require_guardian(g)?;
        if duration_ms > self.policy.max_pause_ms {
            return Err(Reject::PauseTooLong);
        }
        if now < self.pause_cooldown_until_ms {
            return Err(Reject::PauseCooldown);
        }
        self.paused_until_ms = now + duration_ms;
        self.pause_cooldown_until_ms = self.paused_until_ms + duration_ms;
        Ok(vec![event(
            "paused",
            format!(
                r#"{{"until_ms":{},"guardian":"{g}"}}"#,
                self.paused_until_ms
            ),
        )])
    }

    pub fn dao_unpause(&mut self, now: u64) -> Out {
        self.paused_until_ms = now;
        Ok(vec![event("unpaused", "{}".into())])
    }
}

/// Destination check used by tests and the contract: every address a built transaction can touch.
pub fn allowed_targets(c: &Chain) -> [Address; 3] {
    [c.usdc.0, c.pool.0, c.vault.0]
}
