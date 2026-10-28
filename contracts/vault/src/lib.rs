//! Bridle vault contract: the NEAR side of the closed loop.
//!
//! Thin wrapper around `bridle_core::machine::Vault`. It identifies callers (DAO by predecessor,
//! agent and guardians by the function-call key that signed the transaction), runs the core, and
//! executes the core's effects: MPC sign and verify requests, key changes and events. Every MPC
//! response is checked in-contract with `ecrecover` before the core sees it. Refusals are recorded
//! in the on-chain rejection ledger and returned as values; public methods do not panic on bad input.

use bridle_core::evm::{self, Chain, MpcSignature};
use bridle_core::foreign::{self, Hints};
use bridle_core::machine::{Action, Caller, Config, Effect, Out, Reject, SignedTx, Vault, Which};
use bridle_core::policy::{Floors, Policy};
use bridle_core::types::{hex0x, parse_hex, EvmAddr, Hash32, Hasher, H256};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{
    env, near, AccountId, Allowance, Gas, NearToken, PanicOnDefault, PromiseError, PublicKey,
};

const SIGN_PATH: &str = "bridle";
const SIGN_DOMAIN: u32 = 0;
const FOREIGN_DOMAIN: u32 = 3;
const GAS_MPC: Gas = Gas::from_tgas(50);
const GAS_CALLBACK: Gas = Gas::from_tgas(30);
/// Prepaid gas a call must bring if it may reach the MPC (red-team N12: no underfunded callbacks).
const GAS_NEEDED: Gas = Gas::from_tgas(100);
const AGENT_METHODS: &str = "agent_act";
const GUARDIAN_METHODS: &str =
    "guardian_pause,guardian_veto,guardian_tighten,guardian_unwind,cancel";

struct NearHasher;
impl Hasher for NearHasher {
    fn keccak256(&self, d: &[u8]) -> H256 {
        env::keccak256_array(d)
    }
    fn sha256(&self, d: &[u8]) -> H256 {
        env::sha256_array(d)
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Point {
    pub affine_point: String,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    pub scalar: String,
}
/// `v1.signer` signature response.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SigResp {
    pub big_r: Point,
    pub s: Scalar,
    pub recovery_id: u8,
}
/// `v1.signer` foreign-transaction attestation response.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyResp {
    pub payload_hash: String,
    pub signature: SigResp,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// The owning Sputnik DAO.
    owner: AccountId,
    /// The MPC signer contract (`v1.signer-prod.testnet`).
    signer: AccountId,
    /// 64-byte uncompressed secp256k1 key derived for (this account, `bridle`, domain 0).
    vault_pk: Vec<u8>,
    /// 64-byte uncompressed root key of the ForeignTx domain.
    foreign_pk: Vec<u8>,
    /// Allowance for each function-call key the vault adds.
    key_allowance: NearToken,
    vault: Vault,
}

fn pk_string(pk: &PublicKey) -> String {
    String::from(pk)
}

fn now() -> u64 {
    env::block_timestamp_ms()
}

fn log_event(name: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"bridle","version":"1.0.0","event":"{name}","data":{data}}}"#
    ));
}

fn uncompressed(hex_key: &str) -> Vec<u8> {
    let raw =
        hex::decode(hex_key.trim_start_matches("0x").trim_start_matches("04")).unwrap_or_default();
    if raw.len() != 64 {
        env::panic_str("public keys must be 64-byte uncompressed secp256k1 (hex)");
    }
    raw
}

/// Recover the signer of a 32-byte hash with low-s enforced.
fn recover(hash: &[u8; 32], big_r: &str, s: &str, v: u8) -> Option<[u8; 64]> {
    let sig = MpcSignature {
        big_r: big_r.to_string(),
        s: s.to_string(),
        recovery_id: v,
    };
    let rs = sig.rs()?;
    env::ecrecover(hash, &rs, v, true)
}

#[near]
impl Contract {
    /// Deployed and initialised in one batch transaction that also deletes the deployer key
    /// (`scripts/deploy.mjs`), so the account never holds a full-access key afterwards.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        signer: AccountId,
        vault_pk: String,
        foreign_pk: String,
        chain: Chain,
        floors: Floors,
        policy: Policy,
        start_nonce: u64,
        agent_key: PublicKey,
        guardian_keys: Vec<PublicKey>,
        key_allowance: NearToken,
    ) -> Self {
        if key_allowance.is_zero() {
            env::panic_str("key allowance must be above zero");
        }
        let config = Config { chain, floors };
        let mut vault = match Vault::new(config, policy, start_nonce) {
            Ok(v) => v,
            Err(e) => env::panic_str(&format!("invalid policy: {e:?}")),
        };
        vault.agent_key = Some(pk_string(&agent_key));
        vault.guardians = guardian_keys.iter().map(pk_string).collect();
        if vault.guardians.len() > bridle_core::machine::MAX_GUARDIANS {
            env::panic_str("too many guardians");
        }
        let b = self_batch();
        add_fc_key(b, &agent_key, key_allowance, AGENT_METHODS);
        for g in &guardian_keys {
            add_fc_key(b, g, key_allowance, GUARDIAN_METHODS);
        }
        Self {
            owner,
            signer,
            vault_pk: uncompressed(&vault_pk),
            foreign_pk: uncompressed(&foreign_pk),
            key_allowance,
            vault,
        }
    }

    // -----------------------------------------------------------------------------------------
    // Role checks

    fn caller(&self) -> Caller {
        let pred = env::predecessor_account_id();
        if pred == self.owner {
            return Caller::Dao;
        }
        if pred == env::current_account_id() {
            let pk = pk_string(&env::signer_account_pk());
            if self.vault.agent_key.as_deref() == Some(pk.as_str()) {
                return Caller::Agent;
            }
            if self.vault.guardians.contains(&pk) {
                return Caller::Guardian(pk);
            }
        }
        Caller::Public
    }

    /// Record a refusal or execute effects. Returns a JSON outcome either way.
    fn finish(&mut self, caller: Caller, method: &str, out: Out) -> Value {
        match out {
            Ok(fx) => {
                let n = fx.len();
                self.run_effects(fx);
                json!({ "ok": true, "effects": n })
            }
            Err(reason) => self.reject(caller, method, reason),
        }
    }

    fn reject(&mut self, caller: Caller, method: &str, reason: Reject) -> Value {
        let r = serde_json::to_value(&reason).unwrap_or(Value::Null);
        log_event(
            "rejected",
            &json!({ "method": method, "caller": caller, "reason": r }).to_string(),
        );
        self.vault.record_rejection(now(), caller, method, reason);
        json!({ "ok": false, "rejected": r })
    }

    fn need_gas(&mut self, caller: &Caller, method: &str) -> Option<Value> {
        if env::prepaid_gas() < GAS_NEEDED {
            return Some(self.reject(
                caller.clone(),
                method,
                Reject::WrongState("attach at least 100 Tgas".into()),
            ));
        }
        None
    }

    fn run_effects(&mut self, fx: Vec<Effect>) {
        for e in fx {
            match e {
                Effect::Sign {
                    op,
                    slot,
                    which,
                    req,
                    payload,
                } => {
                    let args = foreign::sign_args_json(&payload.0, SIGN_PATH, SIGN_DOMAIN);
                    let cb = json!({ "op": op, "slot": slot, "which": which, "req": req });
                    mpc_then(&self.signer, "sign", args, "on_signed", cb);
                }
                Effect::Verify {
                    op,
                    slot,
                    req,
                    tx,
                    log_index,
                    expected,
                    ..
                } => {
                    let args =
                        foreign::verify_args_json(&tx.0, log_index, &expected.0, FOREIGN_DOMAIN);
                    let cb = json!({ "op": op, "slot": slot, "req": req, "expected": expected });
                    mpc_then(
                        &self.signer,
                        "verify_foreign_transaction",
                        args,
                        "on_verified",
                        cb,
                    );
                }
                Effect::VerifyCredit {
                    req,
                    tx,
                    log_index,
                    expected,
                } => {
                    let args = foreign::verify_args_json(
                        &tx.0,
                        Some(log_index),
                        &expected.0,
                        FOREIGN_DOMAIN,
                    );
                    let cb = json!({ "req": req, "expected": expected });
                    mpc_then(
                        &self.signer,
                        "verify_foreign_transaction",
                        args,
                        "on_credit_verified",
                        cb,
                    );
                }
                Effect::AddGuardianKey { public_key } => {
                    if let Ok(pk) = public_key.parse::<PublicKey>() {
                        add_fc_key(self_batch(), &pk, self.key_allowance, GUARDIAN_METHODS);
                    }
                }
                Effect::DeleteKey { public_key } => {
                    if let Ok(pk) = public_key.parse::<PublicKey>() {
                        env::promise_batch_action_delete_key(self_batch(), &pk);
                    }
                }
                Effect::SetAgentKey { old, new } => {
                    let b = self_batch();
                    if let Some(old_pk) = old.and_then(|o| o.parse::<PublicKey>().ok()) {
                        env::promise_batch_action_delete_key(b, &old_pk);
                    }
                    if let Ok(pk) = new.parse::<PublicKey>() {
                        add_fc_key(b, &pk, self.key_allowance, AGENT_METHODS);
                    }
                }
                Effect::Event { name, data } => log_event(&name, &data),
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Agent

    /// The agent's only method. Its function-call key can call nothing else.
    pub fn agent_act(&mut self, action: Action) -> Value {
        let c = self.caller();
        if c != Caller::Agent {
            return self.reject(c, "agent_act", Reject::NotAllowed);
        }
        if let Some(v) = self.need_gas(&c, "agent_act") {
            return v;
        }
        let out = self.vault.agent_act(&NearHasher, now(), action);
        self.finish(c, "agent_act", out)
    }

    // -----------------------------------------------------------------------------------------
    // DAO (owner)

    fn dao_only(&mut self, method: &str) -> Result<(), Value> {
        let c = self.caller();
        if c != Caller::Dao {
            return Err(self.reject(c, method, Reject::NotAllowed));
        }
        Ok(())
    }

    pub fn dao_act(&mut self, action: Action) -> Value {
        if let Err(v) = self.dao_only("dao_act") {
            return v;
        }
        if let Some(v) = self.need_gas(&Caller::Dao, "dao_act") {
            return v;
        }
        let out = self.vault.dao_act(&NearHasher, now(), action);
        self.finish(Caller::Dao, "dao_act", out)
    }

    pub fn propose_policy(&mut self, policy: Policy) -> Value {
        if let Err(v) = self.dao_only("propose_policy") {
            return v;
        }
        let out = self.vault.propose_policy(now(), policy);
        self.finish(Caller::Dao, "propose_policy", out)
    }

    pub fn propose_guardian(&mut self, public_key: PublicKey) -> Value {
        if let Err(v) = self.dao_only("propose_guardian") {
            return v;
        }
        let out = self.vault.propose_guardian(now(), pk_string(&public_key));
        self.finish(Caller::Dao, "propose_guardian", out)
    }

    pub fn remove_guardian(&mut self, public_key: PublicKey) -> Value {
        if let Err(v) = self.dao_only("remove_guardian") {
            return v;
        }
        let out = self.vault.remove_guardian(&pk_string(&public_key));
        self.finish(Caller::Dao, "remove_guardian", out)
    }

    pub fn set_agent_key(&mut self, public_key: PublicKey) -> Value {
        if let Err(v) = self.dao_only("set_agent_key") {
            return v;
        }
        let out = self.vault.set_agent_key(pk_string(&public_key));
        self.finish(Caller::Dao, "set_agent_key", out)
    }

    pub fn propose_upgrade(&mut self, code_hash: Hash32) -> Value {
        if let Err(v) = self.dao_only("propose_upgrade") {
            return v;
        }
        let out = self.vault.propose_upgrade(now(), code_hash);
        self.finish(Caller::Dao, "propose_upgrade", out)
    }

    pub fn dao_unpause(&mut self) -> Value {
        if let Err(v) = self.dao_only("dao_unpause") {
            return v;
        }
        let out = self.vault.dao_unpause(now());
        self.finish(Caller::Dao, "dao_unpause", out)
    }

    /// Trusted fallback when no proof can be produced. Recorded as a DAO resolution.
    pub fn dao_resolve(&mut self, landed: bool) -> Value {
        if let Err(v) = self.dao_only("dao_resolve") {
            return v;
        }
        let out = self.vault.dao_resolve(&NearHasher, now(), landed);
        self.finish(Caller::Dao, "dao_resolve", out)
    }

    // -----------------------------------------------------------------------------------------
    // Guardians

    fn guardian(&mut self, method: &str) -> Result<String, Value> {
        match self.caller() {
            Caller::Guardian(g) => Ok(g),
            c => Err(self.reject(c, method, Reject::UnknownGuardian)),
        }
    }

    pub fn guardian_pause(&mut self, duration_ms: u64) -> Value {
        let g = match self.guardian("guardian_pause") {
            Ok(g) => g,
            Err(v) => return v,
        };
        let out = self.vault.guardian_pause(now(), &g, duration_ms);
        self.finish(Caller::Guardian(g), "guardian_pause", out)
    }

    pub fn guardian_veto(&mut self, id: u64) -> Value {
        let g = match self.guardian("guardian_veto") {
            Ok(g) => g,
            Err(v) => return v,
        };
        let out = self.vault.guardian_veto(now(), &g, id);
        self.finish(Caller::Guardian(g), "guardian_veto", out)
    }

    pub fn guardian_tighten(&mut self, policy: Policy) -> Value {
        let g = match self.guardian("guardian_tighten") {
            Ok(g) => g,
            Err(v) => return v,
        };
        let out = self.vault.guardian_tighten(&g, policy);
        self.finish(Caller::Guardian(g), "guardian_tighten", out)
    }

    pub fn guardian_unwind(&mut self) -> Value {
        let g = match self.guardian("guardian_unwind") {
            Ok(g) => g,
            Err(v) => return v,
        };
        if let Some(v) = self.need_gas(&Caller::Guardian(g.clone()), "guardian_unwind") {
            return v;
        }
        let out = self.vault.guardian_unwind(&NearHasher, now(), &g);
        self.finish(Caller::Guardian(g), "guardian_unwind", out)
    }

    // -----------------------------------------------------------------------------------------
    // Anyone

    /// DAO or guardian at any time; anyone after the settle deadline.
    pub fn cancel(&mut self) -> Value {
        let c = self.caller();
        if let Some(v) = self.need_gas(&c, "cancel") {
            return v;
        }
        let out = self.vault.cancel(&NearHasher, now(), &c);
        self.finish(c, "cancel", out)
    }

    /// Request the next signature of the active operation (next step, or a retry after a timeout).
    pub fn advance(&mut self) -> Value {
        let c = self.caller();
        if let Some(v) = self.need_gas(&c, "advance") {
            return v;
        }
        let out = self.vault.advance(&NearHasher, now());
        self.finish(c, "advance", out)
    }

    /// Ask the MPC to attest one of the slot's signed transactions. Hints only affect liveness.
    pub fn settle(&mut self, op: u64, slot: u32, tx: Hash32, hints: Hints) -> Value {
        let c = self.caller();
        if let Some(v) = self.need_gas(&c, "settle") {
            return v;
        }
        let out = self.vault.settle(&NearHasher, now(), op, slot, tx, hints);
        self.finish(c, "settle", out)
    }

    /// After the deadline: sign a self-transfer at the next nonce to prove the stuck nonce was used.
    pub fn probe(&mut self) -> Value {
        let c = self.caller();
        if let Some(v) = self.need_gas(&c, "probe") {
            return v;
        }
        let out = self.vault.probe(&NearHasher, now());
        self.finish(c, "probe", out)
    }

    /// Add a signature produced outside a callback (for example a late MPC response).
    pub fn adopt_signature(
        &mut self,
        op: u64,
        slot: u32,
        which: Which,
        big_r: String,
        s: String,
        recovery_id: u8,
    ) -> Value {
        let c = self.caller();
        let signed = self.check_signature(op, slot, which, &big_r, &s, recovery_id);
        let out = match signed {
            Some(tx) => self.vault.adopt_signature(op, slot, which, tx),
            None => Err(Reject::UnknownTx),
        };
        self.finish(c, "adopt_signature", out)
    }

    pub fn credit_deposit(
        &mut self,
        tx: Hash32,
        hints: Hints,
        from: EvmAddr,
        amount: near_sdk::json_types::U128,
    ) -> Value {
        let c = self.caller();
        if let Some(v) = self.need_gas(&c, "credit_deposit") {
            return v;
        }
        let out = self
            .vault
            .credit_deposit(&NearHasher, tx, hints, from, amount.0);
        self.finish(c, "credit_deposit", out)
    }

    /// Execute a parked item after its window. No arguments besides the id.
    pub fn execute(&mut self, id: u64) -> Value {
        let c = self.caller();
        if let Some(v) = self.need_gas(&c, "execute") {
            return v;
        }
        let out = self.vault.execute(&NearHasher, now(), id);
        self.finish(c, "execute", out)
    }

    /// Deploy code whose sha256 matches an executed, parked upgrade. Then `migrate` runs.
    pub fn execute_upgrade(&mut self, #[serializer(borsh)] code: Vec<u8>) -> Value {
        let c = self.caller();
        let hash = Hash32(env::sha256_array(&code));
        match self.vault.take_upgrade(hash) {
            Ok(fx) => {
                self.run_effects(fx);
                let b = self_batch();
                env::promise_batch_action_deploy_contract(b, &code);
                env::promise_batch_action_function_call(
                    b,
                    "migrate",
                    &[],
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(50),
                );
                json!({ "ok": true, "code_hash": hex0x(&hash.0) })
            }
            Err(r) => self.reject(c, "execute_upgrade", r),
        }
    }

    /// Runs after an upgrade. Re-adds every function-call key so names are bound to the new code by
    /// an explicit action (red-team N5).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: Contract = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
        let b = self_batch();
        if let Some(a) = old
            .vault
            .agent_key
            .as_ref()
            .and_then(|k| k.parse::<PublicKey>().ok())
        {
            env::promise_batch_action_delete_key(b, &a);
            add_fc_key(b, &a, old.key_allowance, AGENT_METHODS);
        }
        for g in old
            .vault
            .guardians
            .iter()
            .filter_map(|k| k.parse::<PublicKey>().ok())
        {
            env::promise_batch_action_delete_key(b, &g);
            add_fc_key(b, &g, old.key_allowance, GUARDIAN_METHODS);
        }
        log_event("migrated", "{}");
        old
    }

    // -----------------------------------------------------------------------------------------
    // MPC callbacks. They take ids only; every external fact comes from the promise result.

    fn check_signature(
        &self,
        op: u64,
        slot: u32,
        which: Which,
        big_r: &str,
        s: &str,
        v: u8,
    ) -> Option<SignedTx> {
        let tx = self.vault.tx_for(op, slot, which)?;
        let payload = evm::signing_payload(&NearHasher, &tx);
        let draft = self.vault.draft(op, slot, which)?;
        if draft.payload.0 != payload {
            return None;
        }
        let key = recover(&payload, big_r, s, v)?;
        if key.as_slice() != self.vault_pk.as_slice() {
            return None;
        }
        let sig = MpcSignature {
            big_r: big_r.to_string(),
            s: s.to_string(),
            recovery_id: v,
        };
        let (raw, hash) = evm::assemble(&NearHasher, &tx, &sig)?;
        Some(SignedTx {
            hash: Hash32(hash),
            raw: hex0x(&raw),
        })
    }

    #[private]
    pub fn on_signed(
        &mut self,
        op: u64,
        slot: u32,
        which: Which,
        req: u64,
        #[callback_result] r: Result<SigResp, PromiseError>,
    ) -> Value {
        let signed = match r {
            Ok(sig) => self.check_signature(
                op,
                slot,
                which,
                &sig.big_r.affine_point,
                &sig.s.scalar,
                sig.recovery_id,
            ),
            Err(_) => None,
        };
        let out = self.vault.on_signed(now(), op, slot, req, signed);
        self.finish(Caller::Public, "on_signed", out)
    }

    fn check_attestation(&self, expected: &Hash32, v: &VerifyResp) -> bool {
        let Some(hash) = parse_hex::<32>(&v.payload_hash) else {
            return false;
        };
        if hash != expected.0 {
            return false;
        }
        match recover(
            &hash,
            &v.signature.big_r.affine_point,
            &v.signature.s.scalar,
            v.signature.recovery_id,
        ) {
            Some(k) => k.as_slice() == self.foreign_pk.as_slice(),
            None => false,
        }
    }

    #[private]
    pub fn on_verified(
        &mut self,
        op: u64,
        slot: u32,
        req: u64,
        expected: Hash32,
        #[callback_result] r: Result<VerifyResp, PromiseError>,
    ) -> Value {
        let ok = match r {
            Ok(v) => self.check_attestation(&expected, &v),
            Err(_) => false,
        };
        let out = self
            .vault
            .on_verified(&NearHasher, now(), op, slot, req, ok);
        self.finish(Caller::Public, "on_verified", out)
    }

    #[private]
    pub fn on_credit_verified(
        &mut self,
        req: u64,
        expected: Hash32,
        #[callback_result] r: Result<VerifyResp, PromiseError>,
    ) -> Value {
        let ok = match r {
            Ok(v) => self.check_attestation(&expected, &v),
            Err(_) => false,
        };
        let out = self.vault.on_credit_verified(req, ok);
        self.finish(Caller::Public, "on_credit_verified", out)
    }

    // -----------------------------------------------------------------------------------------
    // Views

    /// Everything a dashboard or keeper needs in one call.
    pub fn get_state(&self) -> Value {
        let v = &self.vault;
        let t = now();
        json!({
            "owner": self.owner,
            "signer": self.signer,
            "chain": v.config.chain,
            "floors": v.config.floors,
            "policy": v.policy,
            "exposure": v.exposure(),
            "ledger": v.ledger,
            "epoch": v.epoch,
            "agent_key": v.agent_key,
            "guardians": v.guardians,
            "next_nonce": v.next_nonce,
            "active": v.active,
            "frozen": v.frozen(t),
            "paused_until_ms": v.paused_until_ms,
            "rejection_count": v.rejection_count,
            "upgrade_ready": v.upgrade_ready,
            "now_ms": t,
        })
    }

    pub fn get_ops(&self) -> Value {
        json!(self.vault.ops)
    }

    pub fn get_op(&self, id: u64) -> Value {
        json!(self.vault.op(id))
    }

    pub fn get_parked(&self) -> Value {
        json!(self.vault.parked)
    }

    pub fn get_rejections(&self) -> Value {
        json!({ "count": self.vault.rejection_count, "recent": self.vault.rejections })
    }

    pub fn exposure(&self) -> Value {
        json!(self.vault.exposure())
    }

    pub fn get_credits(&self) -> Value {
        json!(self.vault.credits)
    }
}

// Low-level promise helpers. The high-level `Promise` type links every NEAR action into the wasm,
// including adding full-access keys and deleting the account; these helpers keep those imports out
// so `scripts/wasm-imports.mjs` can prove the vault cannot do either (invariant 2).

/// A new batch of actions on this account.
fn self_batch() -> near_sdk::PromiseIndex {
    env::promise_batch_create(&env::current_account_id())
}

/// Add a function-call key restricted to this account, `methods`, and a finite allowance (N1/F8).
fn add_fc_key(b: near_sdk::PromiseIndex, pk: &PublicKey, allowance: NearToken, methods: &str) {
    let a = Allowance::limited(allowance)
        .unwrap_or_else(|| env::panic_str("key allowance must be above zero"));
    env::promise_batch_action_add_key_allowance_with_function_call(
        b,
        pk,
        0,
        a,
        &env::current_account_id(),
        methods,
    );
}

/// Call the MPC signer with 1 yoctoNEAR and route the result to one of our callbacks.
fn mpc_then(signer: &AccountId, method: &str, args: String, callback: &str, cb_args: Value) {
    let p = env::promise_create(
        signer.clone(),
        method,
        args.as_bytes(),
        NearToken::from_yoctonear(1),
        GAS_MPC,
    );
    env::promise_then(
        p,
        env::current_account_id(),
        callback,
        cb_args.to_string().as_bytes(),
        NearToken::from_yoctonear(0),
        GAS_CALLBACK,
    );
}
