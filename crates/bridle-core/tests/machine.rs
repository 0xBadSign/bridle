//! State-machine tests: scenarios for every rule, and property tests over random interleavings
//! of agent, DAO, guardian, keeper and attacker calls with random MPC outcomes (doc 18, section 5).

use bridle_core::evm::{self, Call, Chain};
use bridle_core::foreign::Hints;
use bridle_core::machine::*;
use bridle_core::policy::{self, Floors, Lane, Policy};
use bridle_core::types::{parse_hex, EvmAddr, Hash32, Hasher, H256};
use proptest::prelude::*;
use sha2::Digest;

struct TH;
impl Hasher for TH {
    fn keccak256(&self, d: &[u8]) -> H256 {
        sha3::Keccak256::digest(d).into()
    }
    fn sha256(&self, d: &[u8]) -> H256 {
        sha2::Sha256::digest(d).into()
    }
}

const MIN: u64 = 60_000;
const G1: &str = "ed25519:guardian1";
const G2: &str = "ed25519:guardian2";

fn chain() -> Chain {
    Chain {
        chain_id: 84532,
        vault: EvmAddr(parse_hex("8dcbcefb6f02dff2714ae6c7a9cdb6ec5a74b4a3").unwrap()),
        usdc: EvmAddr(parse_hex("ba50cd2a20f6da35d788639e581bca8d0b5d4d5f").unwrap()),
        pool: EvmAddr(parse_hex("8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27").unwrap()),
        atoken: EvmAddr(parse_hex("10f1a9d11cdf50041f3f8cb7191cbe2f31750acc").unwrap()),
    }
}

fn treasury() -> EvmAddr {
    EvmAddr([0x77; 20])
}

fn pol() -> Policy {
    Policy {
        supply_cap: 1_000_000_000,
        agent_max_per_action: 100_000_000,
        agent_quota_per_epoch: 5,
        agent_min_interval_ms: MIN,
        fast_outflow_per_epoch: 20_000_000,
        max_fee_per_gas: 100_000_000,
        max_priority_fee_per_gas: 2_000_000,
        short_window_ms: 3 * MIN,
        long_window_ms: 10 * MIN,
        settle_deadline_ms: 30 * MIN,
        epoch_ms: 24 * 60 * MIN,
        max_pause_ms: 60 * MIN,
        max_vetoes_per_epoch: 2,
        treasury: treasury(),
    }
}

fn floors() -> Floors {
    Floors {
        min_max_fee_per_gas: 10_000_000,
        min_max_priority_fee_per_gas: 1_000,
        min_short_window_ms: MIN,
        min_long_window_ms: 2 * MIN,
        min_settle_deadline_ms: 5 * MIN,
    }
}

/// A vault plus a fake Base + MPC that executes effects.
struct World {
    v: Vault,
    now: u64,
    pending_sign: Vec<(u64, u32, Which, u64, Hash32)>,
    pending_verify: Vec<(u64, u32, u64)>,
    pending_credit: Vec<u64>,
    counter: u64,
    /// Every (nonce, payload) the vault ever asked to be signed, for the nonce invariant.
    signed_log: Vec<(u64, Which, Hash32)>,
}

impl World {
    fn new() -> Self {
        let mut v = Vault::new(
            Config {
                chain: chain(),
                floors: floors(),
            },
            pol(),
            7,
        )
        .unwrap();
        v.guardians = vec![G1.into(), G2.into()];
        v.agent_key = Some("ed25519:agent".into());
        World {
            v,
            now: 1_000_000_000,
            pending_sign: vec![],
            pending_verify: vec![],
            pending_credit: vec![],
            counter: 0,
            signed_log: vec![],
        }
    }

    fn absorb(&mut self, fx: &[Effect]) {
        for e in fx {
            match e {
                Effect::Sign {
                    op,
                    slot,
                    which,
                    req,
                    payload,
                } => {
                    // Construct-only: the payload is the keccak of a tx the vault can rebuild.
                    let tx = self.v.tx_for(*op, *slot, *which).expect("draft exists");
                    assert_eq!(
                        evm::signing_payload(&TH, &tx),
                        payload.0,
                        "payload is a vault-built tx"
                    );
                    assert_eq!(tx.chain_id, 84532);
                    let to = tx.to.unwrap();
                    assert!(allowed_targets(&chain()).contains(&to), "target allowed");
                    assert_eq!(tx.value, 0);
                    self.signed_log.push((tx.nonce, *which, *payload));
                    self.pending_sign.push((*op, *slot, *which, *req, *payload));
                }
                Effect::Verify { op, slot, req, .. } => {
                    self.pending_verify.push((*op, *slot, *req))
                }
                Effect::VerifyCredit { req, .. } => self.pending_credit.push(*req),
                _ => {}
            }
        }
    }

    fn run(&mut self, r: Out) -> Result<Vec<Effect>, Reject> {
        if let Ok(fx) = &r {
            let fx = fx.clone();
            self.absorb(&fx);
        }
        r
    }

    fn sign_ok(&mut self) -> Hash32 {
        let (op, slot, _which, req, payload) = self.pending_sign.remove(0);
        self.counter += 1;
        let mut b = payload.0.to_vec();
        b.extend(self.counter.to_le_bytes());
        let hash = Hash32(TH.keccak256(&b));
        let r = self.v.on_signed(
            self.now,
            op,
            slot,
            req,
            Some(SignedTx {
                hash,
                raw: "0x00".into(),
            }),
        );
        self.run(r).unwrap();
        hash
    }

    fn sign_timeout(&mut self) {
        let (op, slot, _, req, _) = self.pending_sign.remove(0);
        let r = self.v.on_signed(self.now, op, slot, req, None);
        self.run(r).unwrap();
    }

    fn hints() -> Hints {
        Hints {
            block_hash: Hash32([9; 32]),
            block_number: 1,
            tx_index: 0,
            log_index: 3,
        }
    }

    fn settle(&mut self, tx: Hash32, ok: bool) -> Result<(), Reject> {
        let id = self.v.active.ok_or(Reject::NoSuchOp)?;
        let cursor = self.v.op(id).unwrap().cursor;
        let r = self.v.settle(&TH, self.now, id, cursor, tx, Self::hints());
        self.run(r)?;
        let (op, slot, req) = self.pending_verify.remove(0);
        let r = self.v.on_verified(&TH, self.now, op, slot, req, ok);
        self.run(r).map(|_| ())
    }

    fn credit(&mut self, amount: u128) {
        self.counter += 1;
        let tx = Hash32(TH.keccak256(&self.counter.to_le_bytes()));
        let r = self
            .v
            .credit_deposit(&TH, tx, Self::hints(), EvmAddr([0x55; 20]), amount);
        self.run(r).unwrap();
        let req = self.pending_credit.remove(0);
        let r = self.v.on_credit_verified(req, true);
        self.run(r).unwrap();
    }

    /// Drive the active operation to completion with successful signatures and proofs.
    fn finish(&mut self) {
        while let Some(id) = self.v.active {
            if self.pending_sign.is_empty() {
                let r = self.v.advance(&TH, self.now);
                self.run(r).unwrap();
            }
            let tx = self.sign_ok();
            let _ = id;
            self.settle(tx, true).unwrap();
        }
    }

    fn total(&self) -> u128 {
        let l = &self.v.ledger;
        l.idle + l.principal + l.supplying + l.sending + l.total_sent
    }
}

// ---------------------------------------------------------------------------------------------
// Scenarios

#[test]
fn supply_withdraw_and_send_happy_path() {
    let mut w = World::new();
    w.credit(100_000_000);
    let r =
        w.v.agent_act(&TH, w.now, Action::Supply { amount: 60_000_000 });
    w.run(r).unwrap();
    assert_eq!(w.v.ledger.supplying, 60_000_000);
    w.finish();
    assert_eq!(w.v.ledger.principal, 60_000_000);
    assert_eq!(w.v.ledger.idle, 40_000_000);
    assert_eq!(w.v.next_nonce, 9, "approve + supply consumed two nonces");

    w.now += MIN;
    let r =
        w.v.agent_act(&TH, w.now, Action::Withdraw { amount: 10_000_000 });
    w.run(r).unwrap();
    w.finish();
    assert_eq!(w.v.ledger.principal, 50_000_000);
    assert_eq!(w.v.ledger.idle, 50_000_000);

    let r =
        w.v.dao_act(&TH, w.now, Action::SendToTreasury { amount: 20_000_000 });
    w.run(r).unwrap();
    w.finish();
    assert_eq!(w.v.ledger.total_sent, 20_000_000);
    assert_eq!(w.total(), 100_000_000);
}

#[test]
fn agent_cannot_leave_the_mandate() {
    let mut w = World::new();
    w.credit(500_000_000);
    let n = w.now;
    assert_eq!(
        w.v.agent_act(&TH, n, Action::SendToTreasury { amount: 1 }),
        Err(Reject::NotAllowed)
    );
    assert_eq!(
        w.v.agent_act(&TH, n, Action::Unwind),
        Err(Reject::NotAllowed)
    );
    assert_eq!(
        w.v.agent_act(
            &TH,
            n,
            Action::Supply {
                amount: 100_000_001
            }
        ),
        Err(Reject::AboveAgentMax)
    );
    assert_eq!(
        w.v.agent_act(&TH, n, Action::Withdraw { amount: 1 }),
        Err(Reject::InsufficientPrincipal)
    );
    let r = w.v.agent_act(&TH, n, Action::Supply { amount: 10 });
    w.run(r).unwrap();
    assert_eq!(
        w.v.agent_act(&TH, n + MIN, Action::Supply { amount: 10 }),
        Err(Reject::Busy)
    );
    w.finish();
    assert_eq!(
        w.v.agent_act(&TH, n + 1, Action::Supply { amount: 10 }),
        Err(Reject::TooSoon)
    );
}

#[test]
fn agent_quota_and_cap() {
    let mut w = World::new();
    w.credit(2_000_000_000);
    let mut p = pol();
    p.supply_cap = 250_000_000;
    w.v.policy = p;
    for i in 0..2 {
        w.now += MIN;
        let r = w.v.agent_act(
            &TH,
            w.now,
            Action::Supply {
                amount: 100_000_000,
            },
        );
        w.run(r).unwrap_or_else(|e| panic!("{i}: {e:?}"));
        w.finish();
    }
    w.now += MIN;
    assert_eq!(
        w.v.agent_act(
            &TH,
            w.now,
            Action::Supply {
                amount: 100_000_000
            }
        ),
        Err(Reject::CapExceeded)
    );
    for _ in 0..3 {
        w.now += MIN;
        let r = w.v.agent_act(&TH, w.now, Action::Withdraw { amount: 1 });
        w.run(r).unwrap();
        w.finish();
    }
    w.now += MIN;
    assert_eq!(
        w.v.agent_act(&TH, w.now, Action::Withdraw { amount: 1 }),
        Err(Reject::QuotaExhausted)
    );
    w.now += pol().epoch_ms;
    let r = w.v.agent_act(&TH, w.now, Action::Withdraw { amount: 1 });
    assert!(r.is_ok(), "quota resets next epoch");
}

#[test]
fn treasury_two_step_is_slowed_f1() {
    let mut w = World::new();
    w.credit(500_000_000);
    // Within the fast limit: immediate.
    let r =
        w.v.dao_act(&TH, w.now, Action::SendToTreasury { amount: 20_000_000 });
    w.run(r).unwrap();
    w.finish();
    // Anything more this epoch: parked behind the long window, vetoable.
    let r =
        w.v.dao_act(
            &TH,
            w.now,
            Action::SendToTreasury {
                amount: 400_000_000,
            },
        )
        .unwrap();
    assert!(matches!(&r[0], Effect::Event { name, .. } if name == "parked"));
    assert!(w.v.active.is_none(), "nothing signed");
    let id = w.v.parked[0].id;
    assert_eq!(
        w.v.execute(&TH, w.now + MIN, id),
        Err(Reject::NotYetUnlocked)
    );
    w.v.guardian_veto(w.now + MIN, G1, id).unwrap();
    assert!(w.v.execute(&TH, w.now + 11 * MIN, id).is_err());
    // Re-propose; without a veto it executes after the window.
    w.v.dao_act(
        &TH,
        w.now,
        Action::SendToTreasury {
            amount: 400_000_000,
        },
    )
    .unwrap();
    let id = w.v.parked.last().unwrap().id;
    let r = w.v.execute(&TH, w.now + 11 * MIN, id);
    w.run(r).unwrap();
    w.finish();
    assert_eq!(w.v.ledger.total_sent, 420_000_000);
}

#[test]
fn policy_lane_classifier() {
    let a = pol();
    let mut b = a.clone();
    b.supply_cap -= 1;
    b.agent_min_interval_ms += 1;
    assert_eq!(policy::classify(&a, &b), Lane::Fast);
    let mut c = a.clone();
    c.agent_quota_per_epoch += 1;
    assert_eq!(policy::classify(&a, &c), Lane::Short);
    let mut d = a.clone();
    d.treasury = EvmAddr([1; 20]);
    assert_eq!(policy::classify(&a, &d), Lane::Long);
    let mut e = a.clone();
    e.epoch_ms -= 1; // shorter epoch would reset quotas more often
    assert_eq!(policy::classify(&a, &e), Lane::Long);
}

#[test]
fn every_field_has_a_direction() {
    let j = serde_json::to_value(pol()).unwrap();
    let n = j.as_object().unwrap().len();
    assert_eq!(
        n,
        policy::FIELDS.len(),
        "add a direction row for every Policy field"
    );
    for k in j.as_object().unwrap().keys() {
        assert!(
            policy::FIELDS.iter().any(|(f, _, _)| f == k),
            "missing direction for {k}"
        );
    }
}

#[test]
fn guardian_cannot_loosen_or_go_below_floors_f2() {
    let mut w = World::new();
    let mut looser = pol();
    looser.supply_cap += 1;
    assert_eq!(w.v.guardian_tighten(G1, looser), Err(Reject::NotTighter));
    let mut deadlock = pol();
    deadlock.max_fee_per_gas = 1; // would block every tx, including exit
    deadlock.max_priority_fee_per_gas = 1;
    assert!(matches!(
        w.v.guardian_tighten(G1, deadlock),
        Err(Reject::PolicyInvalid(_))
    ));
    let mut tighter = pol();
    tighter.agent_max_per_action = 1;
    w.v.guardian_tighten(G1, tighter).unwrap();
    assert_eq!(
        w.v.guardian_tighten("ed25519:stranger", pol()),
        Err(Reject::UnknownGuardian)
    );
}

#[test]
fn pause_expires_has_cooldown_and_dao_lifts_it() {
    let mut w = World::new();
    w.credit(100_000_000);
    let n = w.now;
    assert_eq!(
        w.v.guardian_pause(n, G1, 61 * MIN),
        Err(Reject::PauseTooLong)
    );
    w.v.guardian_pause(n, G1, 10 * MIN).unwrap();
    assert_eq!(
        w.v.agent_act(&TH, n + MIN, Action::Supply { amount: 1 }),
        Err(Reject::Paused)
    );
    // Re-arming right after expiry is refused (cooldown = duration).
    assert_eq!(
        w.v.guardian_pause(n + 11 * MIN, G2, 10 * MIN),
        Err(Reject::PauseCooldown)
    );
    w.v.guardian_pause(n + 21 * MIN, G2, 10 * MIN).unwrap();
    w.v.dao_unpause(n + 22 * MIN).unwrap();
    assert!(w
        .v
        .agent_act(&TH, n + 22 * MIN, Action::Supply { amount: 1 })
        .is_ok());
}

#[test]
fn removed_guardian_loses_power() {
    let mut w = World::new();
    let fx = w.v.remove_guardian(G1).unwrap();
    assert!(fx
        .iter()
        .any(|e| matches!(e, Effect::DeleteKey { public_key } if public_key == G1)));
    assert_eq!(
        w.v.guardian_pause(w.now, G1, MIN),
        Err(Reject::UnknownGuardian)
    );
}

#[test]
fn veto_limit_per_epoch() {
    let mut w = World::new();
    for _ in 0..3 {
        let mut p = pol();
        p.agent_quota_per_epoch += 1;
        w.v.propose_policy(w.now, p).unwrap();
    }
    w.v.guardian_veto(w.now, G1, 0).unwrap();
    w.v.guardian_veto(w.now, G1, 1).unwrap();
    assert_eq!(w.v.guardian_veto(w.now, G1, 2), Err(Reject::VetoLimit));
    w.v.guardian_veto(w.now, G2, 2).unwrap();
}

#[test]
fn sign_timeout_keeps_the_nonce_and_retries_f3() {
    let mut w = World::new();
    w.credit(100_000_000);
    let r = w.v.agent_act(&TH, w.now, Action::Withdraw { amount: 0 });
    assert_eq!(r, Err(Reject::ZeroAmount));
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    w.sign_timeout();
    let op = w.v.active.unwrap();
    assert!(w.v.op(op).unwrap().slots[0].sign_unknown);
    assert_eq!(w.v.next_nonce, 8, "nonce stays reserved");
    // Anyone retries the same payload; the nonce does not move.
    let r = w.v.advance(&TH, w.now);
    w.run(r).unwrap();
    assert_eq!(w.v.next_nonce, 8);
    let tx = w.sign_ok();
    w.settle(tx, true).unwrap();
    w.finish();
    assert_eq!(w.v.ledger.principal, 50);
    // The same nonce never carried two different main payloads.
    let mut seen = std::collections::BTreeMap::new();
    for (n, which, p) in &w.signed_log {
        if *which == Which::Main {
            assert_eq!(*seen.entry(*n).or_insert(*p), *p);
        }
    }
}

#[test]
fn adopted_late_signature_can_settle() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    w.sign_timeout();
    let op = w.v.active.unwrap();
    let late = SignedTx {
        hash: Hash32([0xab; 32]),
        raw: "0x01".into(),
    };
    w.v.adopt_signature(op, 0, Which::Main, late.clone())
        .unwrap();
    w.settle(late.hash, true).unwrap();
    assert_eq!(w.v.op(op).unwrap().cursor, 1);
}

#[test]
fn failed_verifies_never_freeze_before_the_deadline_f4() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    let tx = w.sign_ok();
    for _ in 0..20 {
        w.settle(tx, false).unwrap();
        assert_eq!(w.settle(tx, false), Err(Reject::Cooldown));
        w.now += VERIFY_COOLDOWN_MS;
        assert!(
            !w.v.frozen(w.now)
                || w.now > w.v.op(0).unwrap().slots[0].reserved_at_ms + pol().settle_deadline_ms
        );
    }
    assert!(
        !w.v.frozen(w.now),
        "20 failures within the deadline do not freeze"
    );
    w.now += 30 * MIN;
    assert!(
        w.v.frozen(w.now),
        "past the deadline the vault reports frozen"
    );
    w.settle(tx, true).unwrap();
    assert!(!w.v.frozen(w.now), "a late proof unfreezes");
}

#[test]
fn unknown_or_foreign_tx_cannot_settle() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    w.sign_ok();
    let op = w.v.active.unwrap();
    // Someone else's supply(onBehalfOf = D): not one of the vault's signed hashes.
    assert_eq!(
        w.v.settle(&TH, w.now, op, 0, Hash32([0xee; 32]), World::hints()),
        Err(Reject::UnknownTx)
    );
}

#[test]
fn stale_or_spoofed_callbacks_do_nothing_t11() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    let before = w.v.clone();
    // Wrong request nonce, wrong op, wrong slot, no request in flight.
    assert!(w
        .v
        .on_signed(
            w.now,
            0,
            0,
            999,
            Some(SignedTx {
                hash: Hash32([1; 32]),
                raw: "0x".into()
            })
        )
        .is_err());
    assert!(w.v.on_signed(w.now, 5, 0, 1, None).is_err());
    assert!(w.v.on_verified(&TH, w.now, 0, 0, 1, true).is_err());
    assert!(w.v.on_credit_verified(1, true).is_err());
    assert_eq!(before, w.v, "state unchanged");
}

#[test]
fn cancel_releases_reservations() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    w.sign_ok();
    assert_eq!(
        w.v.cancel(&TH, w.now, &Caller::Public),
        Err(Reject::BeforeDeadline)
    );
    let r = w.v.cancel(&TH, w.now, &Caller::Guardian(G1.into()));
    w.run(r).unwrap();
    let c = w.sign_ok();
    w.settle(c, true).unwrap();
    assert!(w.v.active.is_none());
    assert_eq!(w.v.ledger.idle, 100);
    assert_eq!(w.v.ledger.supplying, 0);
    assert_eq!(w.v.op(0).unwrap().status, OpStatus::Aborted);
    // The cancel reused the approve's nonce with fees raised on both fields.
    let op = w.v.op(0).unwrap();
    let (m, c) = (
        op.slots[0].main.as_ref().unwrap(),
        op.slots[0].cancel.as_ref().unwrap(),
    );
    assert_eq!(m.params.nonce, c.params.nonce);
    assert!(c.params.max_fee_per_gas * 100 >= m.params.max_fee_per_gas * 110);
    assert!(c.params.max_priority_fee_per_gas * 100 >= m.params.max_priority_fee_per_gas * 110);
    assert!(
        c.params.max_fee_per_gas <= pol().max_fee_per_gas,
        "cancel fits under the cap"
    );
}

#[test]
fn failed_supply_after_approve_resets_allowance() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    let a = w.sign_ok();
    w.settle(a, true).unwrap(); // approve landed
    let r = w.v.advance(&TH, w.now);
    w.run(r).unwrap();
    w.sign_ok();
    let r = w.v.cancel(&TH, w.now, &Caller::Dao);
    w.run(r).unwrap();
    let c = w.sign_ok();
    w.settle(c, true).unwrap(); // supply replaced by a cancel
    let op = w.v.op(0).unwrap();
    assert_eq!(op.slots.last().unwrap().call, Call::Approve { amount: 0 });
    assert!(
        w.v.active.is_some(),
        "lock held until the allowance is reset"
    );
    w.finish();
    assert_eq!(w.v.op(0).unwrap().status, OpStatus::Aborted);
    assert_eq!(w.v.ledger.idle, 100);
}

#[test]
fn reverted_tx_resolved_by_probe_then_reconciled() {
    let mut w = World::new();
    w.credit(100);
    let r =
        w.v.dao_act(&TH, w.now, Action::SendToTreasury { amount: 40 });
    w.run(r).unwrap();
    let main = w.sign_ok();
    assert_eq!(w.v.probe(&TH, w.now), Err(Reject::BeforeDeadline));
    w.now += 31 * MIN;
    let r = w.v.probe(&TH, w.now);
    w.run(r).unwrap();
    let p = w.sign_ok();
    // The probe is at the next nonce.
    let op = w.v.op(0).unwrap();
    assert_eq!(
        op.slots[0].probe.as_ref().unwrap().params.nonce,
        op.slots[0].main.as_ref().unwrap().params.nonce + 1
    );
    w.settle(p, true).unwrap();
    assert!(w.v.active.is_none());
    assert_eq!(w.v.ledger.idle, 100, "treated as reverted, released");
    // A late proof that the transfer did land reconciles upward.
    let r = w.v.settle(&TH, w.now + MIN, 0, 0, main, World::hints());
    w.run(r).unwrap();
    let (op, slot, req) = w.pending_verify.remove(0);
    let r = w.v.on_verified(&TH, w.now, op, slot, req, true);
    w.run(r).unwrap();
    assert_eq!(w.v.ledger.idle, 60);
    assert_eq!(w.v.ledger.total_sent, 40);
}

#[test]
fn dao_resolve_is_the_trusted_fallback() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 50 });
    w.run(r).unwrap();
    w.sign_ok();
    let r = w.v.dao_resolve(&TH, w.now, false);
    w.run(r).unwrap();
    assert!(w.v.active.is_none());
    assert_eq!(w.v.ledger.idle, 100);
}

#[test]
fn deposits_credit_once_and_never_from_the_pool_or_atoken() {
    let mut w = World::new();
    let tx = Hash32([3; 32]);
    let c = chain();
    for bad in [c.pool, c.atoken, c.vault] {
        assert_eq!(
            w.v.credit_deposit(&TH, tx, World::hints(), bad, 5),
            Err(Reject::BadCreditSender)
        );
    }
    let r =
        w.v.credit_deposit(&TH, tx, World::hints(), EvmAddr([5; 20]), 5);
    w.run(r).unwrap();
    let req = w.pending_credit.remove(0);
    w.v.on_credit_verified(req, true).unwrap();
    assert_eq!(
        w.v.credit_deposit(&TH, tx, World::hints(), EvmAddr([5; 20]), 5),
        Err(Reject::AlreadyConsumed)
    );
    assert_eq!(w.v.ledger.idle, 5);
}

#[test]
fn upgrade_waits_and_needs_the_exact_code_hash() {
    let mut w = World::new();
    let h = Hash32([4; 32]);
    w.v.propose_upgrade(w.now, h).unwrap();
    assert_eq!(w.v.take_upgrade(h), Err(Reject::NotYetUnlocked));
    w.v.execute(&TH, w.now + 10 * MIN, 0).unwrap();
    assert_eq!(
        w.v.take_upgrade(Hash32([5; 32])),
        Err(Reject::CodeHashMismatch)
    );
    w.v.take_upgrade(h).unwrap();
}

#[test]
fn guardian_unwind_only_returns_to_the_vault_address() {
    let mut w = World::new();
    w.credit(100);
    let r = w.v.agent_act(&TH, w.now, Action::Supply { amount: 80 });
    w.run(r).unwrap();
    w.finish();
    assert_eq!(
        w.v.guardian_unwind(&TH, w.now, G1),
        Err(Reject::ZeroAmount),
        "below the dust nothing is worth unwinding"
    );
    w.credit(10_000_000);
    w.now += MIN;
    let r =
        w.v.agent_act(&TH, w.now, Action::Supply { amount: 10_000_000 });
    w.run(r).unwrap();
    w.finish();
    let r = w.v.guardian_unwind(&TH, w.now, G1);
    w.run(r).unwrap();
    let op = w.v.active.unwrap();
    // Unwind leaves UNWIND_DUST in Aave so Aave's rounding cannot make it revert.
    assert_eq!(
        w.v.op(op).unwrap().slots[0].call,
        Call::Withdraw {
            amount: 10_000_080 - UNWIND_DUST
        }
    );
    w.finish();
    assert_eq!(w.v.ledger.principal, UNWIND_DUST);
    assert_eq!(w.v.ledger.idle + w.v.ledger.principal, 10_000_100);
    assert_eq!(w.v.ledger.total_sent, 0, "nothing left D");
}

// ---------------------------------------------------------------------------------------------
// Property tests: random interleavings

#[derive(Debug, Clone)]
enum Step {
    Agent(u8, u128),
    Dao(u8, u128),
    SignOk,
    SignTimeout,
    SettleOk,
    SettleFail,
    Advance,
    Cancel(u8),
    Probe,
    Resolve(bool),
    Tick(u64),
    Pause,
    Tighten(u128),
    Credit(u128),
    Execute(u64),
    LateSettle,
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        (0u8..4, 0u128..200_000_000).prop_map(|(k, a)| Step::Agent(k, a)),
        (0u8..4, 0u128..300_000_000).prop_map(|(k, a)| Step::Dao(k, a)),
        Just(Step::SignOk),
        Just(Step::SignOk),
        Just(Step::SignTimeout),
        Just(Step::SettleOk),
        Just(Step::SettleOk),
        Just(Step::SettleFail),
        Just(Step::Advance),
        (0u8..3).prop_map(Step::Cancel),
        Just(Step::Probe),
        any::<bool>().prop_map(Step::Resolve),
        (0u64..40).prop_map(|m| Step::Tick(m * MIN)),
        Just(Step::Pause),
        (0u128..1_000_000_000).prop_map(Step::Tighten),
        (1u128..300_000_000).prop_map(Step::Credit),
        (0u64..6).prop_map(Step::Execute),
        Just(Step::LateSettle),
    ]
}

fn action(k: u8, a: u128) -> Action {
    match k {
        0 => Action::Supply { amount: a },
        1 => Action::Withdraw { amount: a },
        2 => Action::SendToTreasury { amount: a },
        _ => Action::Unwind,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    /// Invariants 1, 4, 5, 9 and ledger conservation under any interleaving.
    #[test]
    fn invariants_hold_under_random_interleavings(steps in proptest::collection::vec(step(), 1..120)) {
        let mut w = World::new();
        let mut credited: u128 = 0;
        let mut signed_by_slot: Vec<(u64, u32, Hash32)> = vec![];
        for s in steps {
            let now = w.now;
            match s {
                Step::Agent(k, a) => { let r = w.v.agent_act(&TH, now, action(k, a)); let _ = w.run(r); }
                Step::Dao(k, a) => { let r = w.v.dao_act(&TH, now, action(k, a)); let _ = w.run(r); }
                Step::SignOk => if !w.pending_sign.is_empty() {
                    let (op, slot, _, _, _) = w.pending_sign[0];
                    let h = w.sign_ok();
                    signed_by_slot.push((op, slot, h));
                },
                Step::SignTimeout => if !w.pending_sign.is_empty() { w.sign_timeout(); },
                Step::SettleOk | Step::SettleFail => {
                    if let Some(id) = w.v.active {
                        let cursor = w.v.op(id).unwrap().cursor;
                        if let Some(&(_, _, h)) = signed_by_slot.iter().rev().find(|(o, sl, _)| *o == id && *sl == cursor) {
                            let _ = w.settle(h, matches!(s, Step::SettleOk));
                        }
                    }
                }
                Step::Advance => { let r = w.v.advance(&TH, now); let _ = w.run(r); }
                Step::Cancel(k) => {
                    let c = match k { 0 => Caller::Dao, 1 => Caller::Guardian(G1.into()), _ => Caller::Public };
                    let r = w.v.cancel(&TH, now, &c); let _ = w.run(r);
                }
                Step::Probe => { let r = w.v.probe(&TH, now); let _ = w.run(r); }
                Step::Resolve(l) => { let r = w.v.dao_resolve(&TH, now, l); let _ = w.run(r); }
                Step::Tick(d) => w.now += d,
                Step::Pause => { let _ = w.v.guardian_pause(now, G1, 10 * MIN); }
                Step::Tighten(cap) => { let mut p = w.v.policy.clone(); p.supply_cap = cap.min(p.supply_cap); p.agent_max_per_action = p.agent_max_per_action.min(p.supply_cap); let _ = w.v.guardian_tighten(G1, p); }
                Step::Credit(a) => { w.credit(a); credited += a; }
                Step::Execute(id) => { let r = w.v.execute(&TH, now, id); let _ = w.run(r); }
                Step::LateSettle => {
                    // Try to settle any earlier slot with any known hash (replay / late proofs).
                    if let Some(&(op, slot, h)) = signed_by_slot.first() {
                        let r = w.v.settle(&TH, now, op, slot, h, World::hints());
                        if w.run(r).is_ok() {
                            let (o, sl, req) = w.pending_verify.pop().unwrap();
                            let r = w.v.on_verified(&TH, now, o, sl, req, true);
                            let _ = w.run(r);
                        }
                    }
                }
            }
            let l = &w.v.ledger;
            // Conservation: every credited unit is idle, in Aave, in flight, or proved sent.
            // (Trusted DAO resolutions and late reconciles move units between buckets, never create them.)
            prop_assert_eq!(l.idle + l.principal + l.supplying + l.sending + l.total_sent, credited,
                "ledger not conserved: {:?}", l);
            prop_assert!(l.withdrawing <= l.principal, "withdrawing within principal");
            // At most one active operation, and its lock is the only one.
            let active = w.v.ops.iter().filter(|o| o.status == OpStatus::Active).count();
            prop_assert!(active <= 1);
            prop_assert_eq!(active == 1, w.v.active.is_some());
        }
        // Nonces: each main payload sits at its own nonce; never two different main payloads per nonce.
        let mut seen = std::collections::BTreeMap::new();
        for (n, which, p) in &w.signed_log {
            if *which == Which::Main {
                prop_assert_eq!(*seen.entry(*n).or_insert(*p), *p, "two payloads at nonce {}", n);
            }
        }
    }

    /// Invariant 7: a FAST change never accepts an action the old policy refused.
    #[test]
    fn fast_changes_only_restrict(cap in 1u128..1_000_000_000, per in 1u128..1_000_000_000, q in 0u32..20,
                                  iv in 0u64..100_000, out in 0u128..1_000_000_000, amt in 1u128..1_000_000_000) {
        let a = pol();
        let mut b = a.clone();
        b.supply_cap = cap; b.agent_max_per_action = per.min(cap); b.agent_quota_per_epoch = q;
        b.agent_min_interval_ms = iv; b.fast_outflow_per_epoch = out;
        if policy::classify(&a, &b) == Lane::Fast {
            prop_assert!(b.supply_cap <= a.supply_cap);
            prop_assert!(b.agent_max_per_action <= a.agent_max_per_action);
            prop_assert!(b.agent_quota_per_epoch <= a.agent_quota_per_epoch);
            prop_assert!(b.agent_min_interval_ms >= a.agent_min_interval_ms);
            prop_assert!(b.fast_outflow_per_epoch <= a.fast_outflow_per_epoch);
            let (ea, eb) = (bridle_core::exposure::exposure(&a), bridle_core::exposure::exposure(&b));
            prop_assert!(eb.max_in_protocol <= ea.max_in_protocol);
            prop_assert!(eb.agent_moves_per_epoch <= ea.agent_moves_per_epoch);
            prop_assert!(eb.fast_outflow_per_epoch <= ea.fast_outflow_per_epoch);
            prop_assert!(eb.agent_gas_wei_per_epoch <= ea.agent_gas_wei_per_epoch);
            // Any agent supply accepted under b fits a's per-action limit.
            if amt <= b.agent_max_per_action { prop_assert!(amt <= a.agent_max_per_action); }
        }
    }
}
