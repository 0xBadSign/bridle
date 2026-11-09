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

## 4. Phase 2 (2026-10-29 to 2026-11-14): raise the odds

Source: the expansion debate in `../near-research/20-expansion-fable.md`, `21-expansion-claude.md` and `23-expansion-round2-fable.md`. The build took hours, not weeks, so the constraint is now judge attention, screener verdicts, owner time and the correctness of any new surface. Order: evidence and legibility first, then a small number of core features with hard dates.

Freezes: **contract and core 2026-11-05 23:59 UTC**; **UI, scripts and docs 2026-11-08 23:59 UTC**. After that, only bug fixes with a test, copy and links. Submit 2026-11-10/11. Nothing is scheduled for the owner on 2026-11-12.

Dropped for good: a second chain (no public test-USDC faucet on Arbitrum Sepolia; the MPC does not observe Ethereum Sepolia), Bitcoin or Solana legs, a TEE agent, Intents, mainnet, Kani, a site rewrite, bounties, more than three tracks.

### M7 Screener bundle (subagent, by 10-31)
- [ ] `make verify` (`scripts/verify-claims.mjs`): re-checks every live claim in the README against public RPCs (NEAR outcomes, Base receipts and logs, FC-only keys, ledger vs. on-chain balances) and prints a PASS/FAIL table. No keys, under a minute.
- [ ] `JUDGING.md` (five-minute path with expected output) and `docs/VERIFY.md` (claim, command, expected line, code location).
- [ ] Prebuilt wasm under `deploy/prebuilt/` with sha256; `make demo-prebuilt` needs only Node; CI rebuilds and diffs the hashes.
- [ ] `Dockerfile` with Rust, cargo-near, Node and the sandbox; a CI job that publishes it to GHCR once the repo is public.
- [ ] Clean-container runs of the whole README: 11-04/05 and 11-09.

### M8 Hosting and liveness (subagent, written 10-31, live when the repo is public)
- [ ] GitHub Pages workflow (uses `scripts/build-pages.mjs`).
- [ ] A 10-minute cron keeper for both vaults (keeper FC key from a repository secret), an allowance watchdog, and a committed liveness log (`docs/evidence/liveness.md`: time, vault, operation, outcome, attestation latency).
- [ ] Arena copy for the busy case: "an operation is in flight; the public keeper finishes it within minutes".
- [ ] Raise the arena agent key's allowance before judging.

### M9 Evidence (main agent plus subagents, 10-30 to 11-03; re-run 11-06)
- [ ] AI red-team campaign over the whole public surface: attacker agents get the arena agent key, fresh faucet accounts for the anyone-methods, the keeper key, the source and RPC. Goal: get USDC to an address they control, or make the ledger count something that did not happen. A dedicated attacker key; at most about ten MPC-triggering actions per session; never during judging. Publish `docs/evidence/ai-redteam.md` and a paste-able "point your own coding agent at it" prompt.
- [ ] Attestation made visible: a per-operation timeline (requested, checked, built, signed, broadcast, safe, attested) showing the attestation signature, the recovered key and the pinned key; `scripts/verify-attestation.mjs <near-tx>`; a recorded "wrong hint" excerpt.
- [x] A real model in the loop: an OpenAI-compatible endpoint (free tier) for the video and the CLI, plus an indirect-injection scenario (a poisoned market note); `docs/evidence/llm-run.md`.

### M10 Core features with hard dates (main agent)
- [ ] Earned trust (green on both vaults by 11-03 23:59 UTC, or revert and describe it as next):
  - The DAO votes floor, ceiling, step and minimum epochs per step.
  - The level rises at most one step per epoch, and only from agent-initiated operations whose final slot landed by MPC attestation. Cancels, credits, DAO operations and `dao_resolve` never count.
  - It resets to the floor on a veto, a pause, a cancel, a reverted resolution, a `dao_resolve` of an agent operation, a streak of agent-key refusals (outsider refusals never count), or a FAST DAO reset. Guardian tighten may lower it.
  - Raising the floor, ceiling or rate is parked; lowering is FAST.
  - `exposure()` reports the ceiling; the current level is its own field.
  - Property tests: the level stays in [floor, ceiling], resets on every negative event, never moves more than one step per epoch.
- [ ] `preview(change)`: a pure view returning lane, wait, exposure before and after and a plain-English diff. Before the core freeze.
- [ ] Factory ("adopt it in three steps"): only if earned trust and the red-team fixes are green by 11-03; otherwise README-only adoption steps.

### M11 Positioning and outreach (10-30 to 11-02)
- [ ] README: contrast with NEAR AI's sample Security prompt; credits (OutLayer, Trezu's planned AI member, Peerfolio v0, abstract-dao); the MPC TEE announcement (after verifying the post); "path to mainnet" (same signer code hash on both networks, checked 2026-10-29); the 13-chain generality line; who would use it.
- [ ] Outreach drafts for the owner: the MPC team (intended audience and stability of `verify_foreign_transaction`), Trezu, one DAO operator.

### M12 Video and submission (11-04 to 11-11)
- [ ] Agent-produced video from the frozen UI: deterministic captures, the real slow beat captured once with a clock and cut to about 25 s, burned-in captions, a 2:15 cut and a 45 s cut. The owner records the voice-over and exports.
- [ ] An open-proposals X-ray page with one staged proposal (UI, by 11-07).
- [ ] WebLLM opt-in toggle in the arena, only if at least 80% of corpus replies from the chosen model are valid obedient JSON (UI, by 11-07).
- [ ] Payload printed for the owner; submit after the owner's yes.
