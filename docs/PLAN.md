# Bridle plan

Binding security design: `../near-research/18-security-design.md` (D-refs below point to its sections). Live facts: `../near-research/16-attack-tests.md`.

## 1. One-liner and story

"Bridle gives an AI agent a DAO's money on Base without giving it any key: a NEAR contract builds every transaction, the NEAR MPC network signs it, and the same network proves it landed before the next one is allowed."

The video's opening beat: a pasted prompt injection persuades the agent, the vault rejects the request on-chain, and the blocked counter goes up. Then the loop: supply, landing proof. Then a parked DAO vote and a veto.

Tracks: `security` (lead), `social`, `business`.

## 2. Architecture

```
crates/bridle-core     pure Rust, no near-sdk: policy, classifier, exposure, EVM tx builder,
                       ForeignTx payload hashing, operation state machine (returns effects).
                       All property/model tests live here.
contracts/vault        near-sdk 5.x wrapper: storage, auth (DAO predecessor, FC-key role by
                       signer_account_pk), executes core effects as promises, callbacks.
contracts/mock-signer  sandbox-only MPC stand-in (k256): sign + verify_foreign_transaction
                       against a mock Base ledger posted by the demo script.
agent/                 TypeScript: keeper (broadcast, settle hints) + agent (planner; a
                       deliberately gullible default parser, optional OpenAI-compatible LLM via env).
web/                   static dashboard: vault state, parked queue, exposure, blocked ledger,
                       injection box (arena vault, published arena key, in-browser signing).
scripts/               check.sh (gate), wasm import check, deploy (one batch), demo/live runners.
```

### 2.1 Roles
- **Owner (Sputnik DAO account)**, by predecessor:
  - FAST: `dao_act`, `propose_policy` when it tightens, `remove_guardian`, `unpause`, `set_agent_key` (same-shape key), `resolve`.
  - PARKED: loosening policy, `add_guardian`, `set_treasury`, `upgrade{code_hash}`, outflow above `fast_outflow_per_epoch`.
- **Agent**: a function-call key on the vault, method `agent_act` only, finite allowance. Checked via `env::signer_account_pk()`.
- **Guardians**: function-call keys, methods `guardian_pause`, `guardian_veto`, `guardian_tighten`, `guardian_unwind`. Bounded per D-F2.
- **Anyone**: `broadcast` is off-chain; `settle`, `adopt_signature`, `credit_deposit`, `prove_nonce_advanced`, views.

### 2.2 Typed actions
| Action | Base txs | Who |
|---|---|---|
| `Supply{amount}` | `approve(pool, amount)`, then `supply(usdc, amount, D, 0)` | agent, DAO |
| `Withdraw{amount}` | `withdraw(usdc, amount, D)` | agent, DAO |
| `SendToTreasury{amount}` | `transfer(treasury, amount)` | DAO (FAST up to limit, else PARKED) |
| `Unwind` | `withdraw(usdc, principal, D)` | guardian, DAO |
| `Cancel{nonce}` | 0-value self-transfer at the nonce, fees +12% on both fields | DAO, guardian, anyone after the deadline |

Expected-log checks:
- approve: the `Approval` log.
- supply: the `Supply` log.
- withdraw: the `Withdraw` log.
- transfer: the `Transfer` log.
- cancel: `BlockHash` only.
- inbound credit: a `Transfer` log to D from an address other than the pool, the aToken or D. The amount and sender are keeper hints, checked against those constraints.

### 2.3 Operation state machine (D-4)
Each tx slot moves through these states:

`Unsigned → AwaitingSign → Signed{hashes} | SignUnknown → AwaitingVerify → Landed`

Side states: `Cancelling`, `RevertedResolved`, `Frozen`.

- There is one active operation at a time (global lock).
- The nonce is reserved before `sign`.
- Principal and quota are released only on proof.
- A failed verify sets a cooldown; it never moves a counter.
- Freeze happens only on evidence, a deadline, or an order.

## 3. Milestones

### M0 Scaffold (day 0)
- [ ] Workspace, crates, `scripts/check.sh` (fmt, clippy, tests, wasm build, wasm import check, English-only), `.gitignore`, licenses.

### M1 Core loop on testnet (days 0-3)
- [ ] bridle-core:
  - EVM builder for all action kinds (omni-transaction);
  - payload hashing for sign and ForeignTx (port of `~/near-probe/e2e.mjs`), with golden vectors from the probe txs;
  - policy struct and caps.
- [ ] Vault:
  - init with pinned signer, derived key and ForeignTx key;
  - `dao_act` and `agent_act`, covering Supply, Withdraw, SendToTreasury and the global lock;
  - sign plus callback, with ecrecover against the pinned derived key;
  - `settle` with keeper hints, expected hash, consumed set and Landed;
  - non-panicking `Rejected` events plus a rejection ledger;
  - views.
- [ ] One-batch deploy script: create, deploy, init, add FC keys, DeleteKey. The key list must show only FC keys.
- [ ] Live testnet end-to-end. A DAO vote and an agent key run supply, settle, withdraw and send-to-treasury. Evidence goes in PROGRESS.

### M2 Governance (days 3-6)
- [ ] Classifier with a per-field direction table. Assumption and address fields are always SLOW.
- [ ] Parked queue: windows per class, `execute(id)` without args, one-way states, veto.
- [ ] Agent caps and limits:
  - `exposure()` before and after for each parked item;
  - `fast_outflow_per_epoch`;
  - quota and min interval;
  - fee and gas caps at 80% of the fee cap, leaving headroom for cancels.
- [ ] Guardians:
  - pause, which expires and has a cooldown;
  - veto, limited per epoch and not allowed on guardian removal;
  - tighten, FAST-only;
  - unwind;
  - exit floors that cannot be tightened;
  - removal by the DAO, FAST.

### M3 Robustness (days 6-9)
- [ ] `SignUnknown` plus `adopt_signature`.
- [ ] Cancel at the same nonce, then settle on either the original or the cancel.
- [ ] Deadlines and cooldowns; freeze only on evidence, a deadline or an order.
- [ ] `prove_nonce_advanced`, plus the DAO `resolve` for reverts. Late landing proofs reconcile upward.
- [ ] `credit_deposit` for inbound USDC.
- [ ] Upgrade parked by code hash, then `execute_upgrade(code)` with a hash check. Migration deletes and re-adds FC keys.

### M4 Tests and `make demo` (days 8-11, overlaps M3)
- [ ] Property tests in core for the 10 invariants of D-5. The callback-spoof suite follows T11.
- [ ] Mock signer plus near-sandbox integration tests.
- [ ] `make demo`: the full story offline in about 2 min.
- [ ] `make live`: testnet.

### M5 Agent, arena, keeper (days 10-12)
- [ ] Keeper: watches pending signed txs, broadcasts, waits for `safe`, settles with hints.
- [ ] Agent: planner reads Aave rate and vault state, then supplies or withdraws within the mandate. Gullible injection mode. Optional LLM via env.
- [ ] Arena vault: separate vault and funds, published arena key with a small allowance, plus the attack corpus and the `bridle-attack` CLI.

### M6 Dashboard, README, video (days 12-15)
- [ ] Static dashboard, every row linked to NEAR and Basescan. Injection box signs in the browser with the arena key.
- [ ] README written as "do X - see Y" steps, with the security statement (D-7), prior-art credits, "what is not protected", and the library list.
- [ ] Video script and X post draft for the owner. Submission payload printed for the owner.
