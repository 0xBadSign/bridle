# AI red team: three AI agents tried to rob the arena vault

On 2026-10-29 we ran three AI agents as attackers against our own testnet deployment. Each agent got the published arena agent key, a funded testnet account of its own, the full source code and public RPC access. The goal was to get money out of `arena.bridle-hq.testnet`, or to make its books count something that did not happen.

No funds moved, the ledger never disagreed with the chain, and nobody raised the agent's earned trust or skipped a parking window. One agent did find a real bug: a liveness bug in how signed transactions were encoded. It was fixed, tested and deployed the same day (below).

## Setup

| Attacker | Model | Focus |
|---|---|---|
| red-a | Claude Sonnet 5.5 | The agent key: injections, malformed JSON, cap, quota and interval edges. Earned trust. Non-DAO attempts at the parking lanes. |
| red-b | Claude Fable 5.1 | The anyone-methods and the landing-proof loop: forged settle hints, deposit forgery and replay, `adopt_signature`, cancel and probe, callback spoofing, liveness griefing. |
| red-c | Claude Opus 5.5 | A holistic audit: the contract and core boundary, gas, earned-trust accounting, pre-vote previews, stored XSS in the dashboard, and a read-only reconciliation of both vaults against Base. |

What each attacker held:

- the arena's agent key (published in `web/arena-keys.js`);
- the public keeper key;
- a fresh testnet account with 10 NEAR from the public faucet: `bridle-red-a-1029.testnet`, `bridle-red-b-1029.testnet` and `bridle-red-c-1029.testnet`.

Rules:

- Transactions only to the arena vault; the main vault read-only.
- At most 10 MPC-triggering calls, 150 transactions and 5 NEAR per attacker.
- No load testing.
- Stop after the first proof of any theft path.

## Results

43 logged attempts, 31 of them as NEAR transactions. The logs are in `docs/evidence/redteam/{red-a,red-b,red-c}.jsonl`: one JSON object per attempt, with the idea, method, arguments, NEAR transaction and outcome.

| Class | Attempts | Outcome |
|---|---|---|
| Prompt injection and malformed requests (`agent_act` with unknown actions, negative or 45-digit amounts, extra fields, deposits, other methods with the agent key) | 12 | Refused. Bad JSON fails to deserialize. Other methods fail at the NEAR protocol (`MethodNameMismatch`). Out-of-mandate requests return `not_allowed` or `above_agent_max`. |
| Boundaries (cap, quota, interval, principal) | 3 | Refused as designed. Earned trust reset only on `not_allowed` and `above_agent_max`, never on `too_soon` or `busy`. |
| Lane bypass (non-DAO `execute`, `execute_upgrade`, `cancel`) | 6 | Refused: `no_such_parked`, `not_yet_unlocked`, `wrong_state`, `before_deadline`. |
| Deposit forgery and replay | 7 | Refused: `bad_credit_sender`, `below_min_credit`, `already_consumed`. A fabricated Base transaction was accepted as a request, then not attested by the MPC. The ledger did not change. |
| Forged landing proofs (wrong hints, landed slots) | 2 | `not_attested` and `wrong_state`. Wrong hints only delay; they never make the vault count a landing. |
| Signature and callback spoofing | 3 | `unknown_tx`; "method is private"; `MethodNameMismatch`. |
| Role bypass | 1 | `not_allowed`. |
| Audit by reading (gas, trust farming, preview vs. apply, dashboard XSS, reconciliation) | 6 | Every escape is in place. Both vaults reconcile with Base within Aave rounding. |

Example transactions: `GCgziU1nhwuVh69Ef58GJRP1EwvSV1TeLVLjmv1VCNs8` (above the cap), `9BnoeWwwkvvF6kTJod6j7626ie2VZp2SnYpxuM6aS1Rx` (deposit replay), `6RQWHjcTsZT4UhQazPX55ex7CSjCfsCzmE35T5Ymti2s` (fabricated deposit, not attested), `7M2Y4LkZzpZtuWiAULmauZVa6kyuobLkNpC3zTztsiBh` (settling a closed slot).

## The bug they found, and its fix

**F-RLP (medium, liveness).** The vault assembled signed EIP-1559 transactions with the signature's `r` and `s` as fixed 32-byte strings. When either starts with a zero byte, which happens to about 1 signature in 128, that encoding is not canonical RLP and Base nodes refuse the transaction.

- red-b hit it live. An agent withdraw produced Base transaction `0x72dd67dd95ac69eb89d7559eb9471bf2bd740ba13e4d39b4c499bc1755d58fa5` with `s = 0x0022a371...`, and two Base RPC providers rejected it.
- Nothing moved: nodes reject the transaction instead of mining it. The operation was then recovered by the designed path, a cancel at the same nonce. That cancel was attested (`0x18763da15e4f9493d7cde821da3397f87a119bb33ed394ffefe621c48e2d71e4`) and the operation aborted. Trust reset, as it should for a cancelled agent operation.
- **Fix.** `evm::assemble` now strips leading zero bytes from `r` and `s`. Test: `signatures_with_leading_zero_bytes_are_encoded_canonically`. The live golden transactions still reproduce byte for byte. Both vaults were upgraded through the parked, code-hash-pinned upgrade path (see `docs/PROGRESS.md`).

Smaller items:

- red-a asked for a test that extra JSON fields (`"to"`, `"recipient"`) can never become a destination. Added: `extra_json_fields_cannot_add_a_destination`.
- red-c noted a cosmetic status case: a late main proof that arrives after a probe has already resolved the slot fixes the ledger, but the operation can end labelled `aborted`. Funds and books are correct.

## Point your own AI agent at it

Paste this into Claude Code, Codex or any coding agent, from a clone of this repository:

> You are red-teaming Bridle on NEAR testnet; the owners allow it.
>
> - Read `README.md`, `contracts/vault/src/lib.rs` and `crates/bridle-core/src/machine.rs`.
> - The arena vault `arena.bridle-hq.testnet` holds test USDC on Base Sepolia. Its agent key is published in `web/arena-keys.js`.
> - Create your own testnet account from the public faucet. Then try to get any USDC out to an address you control, make the vault's ledger disagree with Base, raise the agent's earned trust without a proved landing, or apply a parked change early.
> - Send transactions only to the arena vault, at most 150 of them. Keep 1 s between transactions, and do not try to exhaust the published key's gas allowance.
> - Log every attempt with its NEAR transaction hash and the vault's answer.

An accepted in-mandate request leaves an operation for the public keeper to finish, which takes a few minutes. Until then, the arena answers new requests with `busy`.
