# Live testnet evidence (2026-10-28)

These tests were run against the real NEAR MPC signer (`v1.signer-prod.testnet`) and Base Sepolia before and during the build. Sections 1 and 2 used a throwaway probe contract (`bridle-vault-probe.testnet`, written the same day, not part of this repository); section 2 is the attack and MPC-behaviour suite that the vault design relies on. Results from the vault itself are in `docs/PROGRESS.md`.

## 1. End-to-end feasibility probe

| Check | Result |
|---|---|
| omni-transaction 0.5.0 EIP-1559 builder compiles to NEAR wasm | PASS |
| Contract builds an EIP-1559 tx itself (Base Sepolia chain 84532, `approve(AavePool, 1 USDC)` on Aave test USDC), calls `v1.signer-prod.testnet.sign` from the contract, assembles the signed tx in the callback | PASS; latency 82 s, 72 s, 12 s (direct-call baseline 11 s) |
| Signed raw tx accepted by Base Sepolia RPC as a valid tx | PASS (`insufficient funds ... have 0`, i.e. parsed and sender resolved) |
| Recovered sender = contract's derived address `0x8dcbcefb6f02dff2714ae6c7a9cdb6ec5a74b4a3` (`derived_public_key(path="bridle", predecessor=bridle-vault-probe.testnet, domain 0)`) | PASS |
| Contract calls `verify_foreign_transaction` itself with `expected_payload_hash`, checks the MPC signature in-contract with `env::ecrecover` against `public_key(3)` | PASS (`verified: true`, 13.6 s) |
| Same with a wrong expected hash | PASS (no attestation; callback records `verified: false` without panicking, ~127 s) |


### End-to-end run (2026-10-28, after the owner funded the derived address with 0.01 Base Sepolia ETH)
All three Base Sepolia txs were built inside the NEAR contract, MPC-signed via the contract, then broadcast by a script:

| Step | NEAR (contract -> MPC sign) | Base Sepolia tx | Result |
|---|---|---|---|
| Faucet `mint(USDC, self, 100)` | 12.6 s, `7nrDKHumHvPBBvEtmSZ9zsytitPPwcTBoNRccL9T1gr9` | `0x3ccb265dc456a3f4a17b0f0646897159d0f60d797e0b363749a719c69a45c1c8` | success, 87,902 gas |
| `approve(AavePool, 50)` | 13.3 s, `B5XW6XRMkgvrwbEHneVSTMxxJ6dwE8Sav6Dd81VvLPqN` | `0x4a86454c0d23c3b8e7b8056eb23c6bcdd039014ef7e7093770377d376ea1549b` | success, 46,248 gas |
| Aave `supply(USDC, 50, self, 0)` | 21.7 s, `Au35KCn9J8wPcHcjMDDDHbguP79bd7JsjVdYmGziQkuS` | `0x99aba362ef6b3dc05c5f33fa589009f3c22cc75bf528e1803e831d87fd7fd110` | success, 189,407 gas; Supply log index 24, onBehalfOf = vault address, amount 50,000,000 |
| Wait for Base `safe` head | - | - | 52.8 s |
| Contract `probe_verify` (expected hash precomputed from the Supply log, in-contract `ecrecover` vs `public_key(3)`) | 12.1 s, `4XKrqTukrh19EdTxhc18siAHE5QUBxw9ZQ69q7nxUYar` | - | `verified: true` |
| aToken balance of the vault's Base address | - | aToken `0x10f1a9d11cdf50041f3f8cb7191cbe2f31750acc` | 49.999999 aUSDC |

Total wall time for mint + approve + supply + landing proof: about 2 min 15 s. Gas spent: about 0.00003 ETH.

## 2. Attack and MPC-behaviour tests

Attacker account `bridle-attacker-1028.testnet` (separate faucet account). Target: probe vault `bridle-vault-probe.testnet`
(Base address `0x8dcbcefb6f02dff2714ae6c7a9cdb6ec5a74b4a3`, holding ~50 aUSDC + ETH on Base Sepolia).


| # | Attack | Result | Evidence |
|---|---|---|---|
| A | Attacker asks `v1.signer` to sign with the vault's path `"bridle"` | BLOCKED. Signature returned, but it recovers to the attacker's own derived address `0x9b1369b107a32ef45f90d06e9cc35f43715ba4e5`, not the vault's `0x8dcb...b4a3`. Keys are bound to (predecessor, path). | tx `12FPcJxbwHEPvAsbtZDJB5NBPkD4xjZQ1FGgt6n75mzG` |
| B | Call the vault's `#[private]` sign callback directly with forged arguments | BLOCKED: `Smart contract panicked: Method on_signed_call is private` | tx `Hq2bDZnXdVAdpYyYTnWQfjh7GqC9dn7Jj3YQUerkbiKb` |
| C | Attacker calls the probe's unguarded `probe_sign_call` to transfer the vault's 50 aUSDC to `0xdead` | SUCCEEDED (expected; the probe method has no policy). The attacker obtained a valid signed Base tx from the vault's address. Lesson: all safety lives in the vault's own policy code; one unguarded signing path = total loss. | tx `EVtAc1npBKNknLEYzBvVDDWZxPG9So1CqsrjMTnhtHev` (not broadcast) |
| D1 | Function-call key limited to `get_last` calls a different method | BLOCKED at protocol level: `InvalidAccessKeyError: MethodNameMismatch` | rejected before execution |
| D2 | Same key calls `v1.signer.sign` directly as the vault account | BLOCKED: `DepositWithFunctionCall` (the signer requires 1 yocto; function-call keys cannot attach deposits). A different receiver would also be rejected. | rejected before execution |
| D3 | Same key attaches a deposit to the allowed method | BLOCKED: `DepositWithFunctionCall` | rejected before execution |
| D4 | Control: same key calls the allowed method | SUCCESS | - |
| E | Allowance exhaustion: a call whose max gas cost exceeds the key allowance | BLOCKED: `NotEnoughAllowance` (300 Tgas ~ 0.3 NEAR > 0.25 NEAR allowance) | rejected before execution |
| F | Wrong `expected_payload_hash` / non-existent log (from 12/14) | BLOCKED: MPC returns no attestation; the contract records `verified: false` | see 12, 14 |

Conclusion: the NEAR and MPC primitives behaved exactly as the design assumes. The remaining risk is in Bridle's own code and governance design (the design review, findings F1-F10).

### Round 2 (2026-10-28): flow and landing-proof tests

| # | Test | Result | Evidence |
|---|---|---|---|
| T1 | Full governance path: Sputnik DAO proposal (FunctionCall -> vault `probe_sign_call`, 150 Tgas) -> `act_proposal` VoteApprove (300 Tgas) -> vault -> `v1.signer.sign` -> vault callback assembles the signed Base tx | PASS. One vote produced a signed raw tx in 15.5 s; the whole chain fits in one 300 Tgas act. The proposal was approved instantly (1-of-1 council, no minimum voting period), confirming the treasury two-step concern (design finding F1). The signed raw tx is public in the receipt, so anyone can broadcast it (keeper not needed for liveness). | add_proposal `6ejGXPAdwwQhqqh34eyiNxG6Wo3yZ33HTwQLZ69WptsU`, act `7axw5vjnUGHCH9f84GM97h9pAhqwr59qDQQdaNVGPJFZ` |
| T2 | Landing proof for a REVERTED tx: broadcast the DAO-signed `USDC.transfer(0xdead, 1e12)` (reverts, status 0, 0 logs), wait for `safe`, ask `verify_foreign_transaction` with (a) `BlockHash` only, (b) `BlockHash` + `Log 0` | NO ATTESTATION in both cases (`Request has timed out`, ~115-123 s). Control: `BlockHash`-only on a successful tx (Aave supply `0x99ab...`) attests in 12 s. So the MPC only attests successful txs; a landing proof implies success. | Base tx `0x459c47714f705349ac2c51fbacfff68820e21962a059017d1d4729705cd9457d` (block 51391321) |
| T3 | Replay: ask for an attestation of the same supply tx again | ATTESTED AGAIN with the identical `payload_hash` `85a2f5c9...064b` (13.8 s). An attestation is not single-use: the vault must store consumed (tx_id, log_index) pairs and reject re-use. | - |
| T4 | Concurrency / nonce conflict: three NEAR accounts ask the vault at the same time to sign three different txs with the same EVM nonce 4 | ALL THREE SIGNED (12.9-13.7 s each). Three valid, conflicting txs exist for one nonce; whichever is broadcast first wins. The vault must reserve a nonce in state before requesting a signature, allow at most one in-flight signature per nonce, and bind the landing proof to the exact approved tx hash. None of the three was broadcast. | `An2aB324...`, `DWRkLYV7...`, `2ziVA6Af...` |

New design requirements from round 2 (design findings F11-F13):
- F11 replay: keep a consumed-attestation set keyed by (chain, tx_id, log_index).
- F12 nonce conflicts: nonce reservation, single in-flight signature per nonce, intent bound to exact tx hash; a stale signed tx for a reserved nonce must be treated as live until that nonce is consumed on Base (ties to F3 SIGN_UNKNOWN).
- F13 failed txs: absence of an attestation is ambiguous (reverted, not yet safe, or MPC timeout). The vault must not mark an intent "failed" from a missing attestation alone; it retries after `safe` and only then marks "not landed".

### Round 3 (2026-10-28): log binding, exit path, stuck nonce

| # | Test | Result | Evidence |
|---|---|---|---|
| T5 | Log binding (design review M11): in Base Sepolia block 51393110, ask for an attestation of tx A with the log index of tx B's log | NO ATTESTATION (timeout, 128 s). Control: A's own log attests in 12 s. Log indices are block-level (the supply log was index 24), and the MPC binds the log to `tx_id`. A keeper cannot pass someone else's log off as ours. | txA `0xf96dc4fb...2db3`, txB `0x758ef95e...a42a` |
| T6 | Exit path, never run live before: vault-built Aave `withdraw(USDC, 10, self)` then `USDC.transfer(treasury, 10)`, each MPC-signed by the contract, broadcast, and attested | PASS. Withdraw status 1 (156k gas), attested 14.9 s after `safe`; transfer status 1 (52k gas), attested 12.7 s. Wall time about 8 min, mostly waiting for `safe` (~3.5 min each). | `0x50269dd9...ea9a`, `0x019127cb...88cf` |
| T7 | Stuck nonce (design review E6/E7): broadcast a self-transfer priced at half the base fee (stays pending), then try to replace it at the same nonce | Pending tx blocks nonce 6. Replacement with +5% fees: `replacement transaction underpriced`. Replacement with 4x max fee but a lower tip: also rejected, because both `maxFeePerGas` and `maxPriorityFeePerGas` must rise by at least 10%. Replacement with both raised (fee 4x, tip +12%): accepted and mined, nonce moved to 7. So `cancel_entry` works, but only with fee headroom on both fields. | original `0xd5e24e94...acce`, cancel `0x7c4dd8f8...8b0a` (block 51399102) |

Answers to the open questions of the design review:
- #2 log binding: confirmed bound to the tx (T5).
- #3 BlockHash-only on a reverted tx: does NOT attest (T2). So a revert cannot be proved by attestation. Resolution path: the next vault tx at nonce n+1 landing (attested) proves nonce n was consumed; otherwise `resolve_reverted` is a DAO action.
- #4 timeout: 115-128 s on testnet.
- #8 encoding: the contract's EIP-1559 encoding produced txs Base accepted and mined (6 txs so far).
- #9 replacement bump: at least 10% on both fee fields (T7).
- Still open: #1 (late signature after a timeout; designed around with SIGN_UNKNOWN regardless), #5 (allowance refund detail), #6 (NEP-591 by-hash view), #7 (queue bound).

### Round 4 (2026-10-28): callback protection

| # | Test | Result | Evidence |
|---|---|---|---|
| T11 | `#[private]` vs a key on the vault account (design review F7/N2): add an FC key with an EMPTY method list to the vault, use it to call the private callback `on_signed_call` with forged args | `#[private]` DID NOT STOP IT: the call entered the method body and failed only with `Accessed invalid promise result index: 0`, because the callback reads the MPC result from the promise, not from its arguments. The same key could also call any other method (`get_last` succeeded). Compare attack B (another account calling the same callback is rejected as private). Lessons: (1) no key on the vault may have an empty method list; (2) callbacks must take every external fact from `env::promise_result` and check the awaiting state and request nonce. The key was deleted after the test. | `4AaJ4Tvk9YGqGdGUbWGVjxrnPhzKYVVHQzSakB6e2RUC` |

Status of the extra test list from the design critique: T1 log binding (done, T5 here), T2 reverted (done, T2), T4 conflicting signatures at one nonce (done, T4), T6 nonce cancel (done, T7), T10 exit path (done, T6), T11 private vs key (done, T11), T9 reliability (partial: every expected-success verify in 12-15 so far attested in 12-15 s on `Safe`; all timeouts were deliberate negative cases). Left for the build: T3 late signature, T5 allowance refund, T7 batched Sputnik proposal against the real lock, T8 one-batch deploy, T12 third-party supply, T13 pin re-check on day 14.
