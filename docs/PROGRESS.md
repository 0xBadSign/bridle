# Progress

## Where we are
- M0 to M6 are built. The core, the vault, the keeper, the agent (market mode + gullible injection mode + optional LLM), the arena vault, the dashboard (`web/`) and `make demo` (offline, 75/75 PASS) are all done. `scripts/check.sh` passes everything.
- Every path ran live on testnet. Evidence is below and in `.private/live-suite.out`.
- Remaining items need the owner: O-1, O-2, O-3. Hosting the dashboard on GitHub Pages also needs the public repo (`node scripts/build-pages.mjs` builds `_site/`).

## Testnet deployment
| What | Value |
|---|---|
| Vault | `vault.bridle-hq.testnet`. A sub-account created without any key; only function-call keys, listed at deploy. Deploy tx `GvJQgpqL5P5MRttooxSdVRDbhKWAtA2Lvvy1pRugodYd` |
| Vault Base address (MPC-derived) | `0x96fbd55e58c16b10df15532e9157e067f2d1d8aa` |
| Owner DAO | `bridle-hq.sputnik-v2.testnet`. Council `bridle-hq.testnet`, 1-of-1. Create tx `DivTyMizcMJz6SPV5mtDhtKKp5uPrVFFbkSNKkMQ4dwL` |
| Treasury (DAO-derived Base address, path `treasury`) | `0xdc35e2ce2ae9c135795b6cc53288d4f72a866007` |
| Arena vault (published agent key, `web/arena-keys.js`) | `arena.bridle-hq.testnet`, Base `0x53532502c663fdbe9dee366b17e03ce79ec6d3de`. Public keeper `keeper.bridle-hq.testnet` (function-call key, public methods only) |
| Agent and guardian keys | `~/.near-credentials/testnet/bridle-keys/vault.bridle-hq.testnet/` (WSL, not in the repo) |

## Owner actions
- O-1 (before submission): a mainnet NEAR account for the prize payout.
- O-2 (end): record the video, publish the X post, confirm the submission payload.
- O-3 (end): create the public GitHub repo, or confirm it can be made public.

## Decisions
- D-001 (2026-10-28): full scope of 18-security-design.md; the owner rejected the scope cut.
- D-002: agent and guardian roles are function-call keys on the vault account, identified by `env::signer_account_pk()`. The DAO acts by predecessor.
- D-003: the injection box signs in the browser with a published arena key on a separate arena vault. No hosted server, zero cost.
- D-004: the default agent planner is a deliberately gullible rule-based parser, labelled as such. An LLM is optional via an OpenAI-compatible env var.
- D-005: keeper hints (block hash, block number, tx index, log index, credit sender and amount) enter the expected payload hash. A wrong hint can only cause a missing attestation.
- D-006: the vault uses low-level `env::promise_*` calls instead of `near_sdk::Promise`. The high-level type links the full-access-key and delete-account host functions into the wasm. `scripts/wasm-imports.mjs` proves both are absent.
- D-007: the vault is a sub-account created by its parent in one batch (CreateAccount, Transfer, DeployContract, `new`) with no AddKey. It never had a full-access key, so there is no DeleteKey step to trust.
- D-008: the NEAR RPC defaults to `https://test.rpc.fastnear.com`. `rpc.testnet.near.org` is deprecated and rate-limits with 429.

## Session log
- 2026-10-28: repo created; plan written from near-research 11-19.
- 2026-10-28: bridle-core written.
  - 6 golden tests: our builder reproduces the live probe tx hashes; the expected logs equal the live logs; the payload hash equals live MPC attestations.
  - 24 scenario and property tests, including strict ledger conservation over random interleavings.
  - Commit 948fc9d.
- 2026-10-28: vault contract (335 KB) built; the wasm import check passes. Deployed with the DAO.
- 2026-10-28: live flows:
  - Deposit credit: NEAR tx `AWXxM6ftqyKaWPRUBZnoS9TEU8iKfNj4c7yRKHm9EPBH`, MPC-attested, 50 USDC credited.
  - Agent supply of 30 USDC (`8DRZCxitY8V3s47gJZsp3WVuVxDiFMcT793JfpjHtt9A`): approve and supply each signed, landed and attested. The ledger shows principal 30, idle 20.
  - Rejections: agent send-to-treasury `not_allowed`, agent 60 USDC `above_agent_max`, outsider `agent_act` and `dao_act` `not_allowed`, guardian loosening `not_tighter`.
  - DAO fast outflow of 10 USDC: proposal 0, attested.
  - DAO outflow of 15 more: parked in the long lane; execute before unlock `not_yet_unlocked`; guardian veto `3ii5JKgNy5hdqvdSDXd2fKSMFXnwv6ZAejzNv9sGsrwf`.
- 2026-10-28: merged the dashboard (web/, browser keeper) and the offline demo (mock signer, mock Base, `make demo` 75/75 PASS in 136 s).
- 2026-10-28: live suite (`scripts/live-suite.mjs`):
  - Agent withdraw: `7HRmvSCniCPuLfvBM968HCastpxYLSR5SRKUrponNf5p`.
  - Guardian cancel at the same nonce. The Base cancel `0x1e869c30...` was attested, the op was aborted and the reservation released. The suite's own check threw on a tooling nonce race; the settle was completed with a separate keeper.
  - Pause, cooldown and DAO unpause: `7niK3m9s...`, `E3Z2VvPU...`.
  - Policy:
    - tightening applied immediately: `GFqhK59m...`;
    - loosening parked in the short lane, then executed: `7v6QZC2s...`.
  - Agent key rotation, old key deleted: `J2o84YBQ...`.
  - Guardians:
    - removal immediate: `o9Rm6hhD...`;
    - addition after the long window: `3FgNkvwb...`.
  - Upgrade:
    - parked by code hash;
    - refused early (`not_yet_unlocked`);
    - refused with the wrong code (`code_hash_mismatch`);
    - applied with the exact code: `BdeP6faL...`, `migrated`. State and keys survived.
  - Guardian unwind: all 25 USDC principal returned to the vault address and attested (`0x7981072f...`).
  - Final state: ledger idle 40 USDC equals the on-chain USDC balance; aUSDC 0; Base nonce 6 equals the vault's `next_nonce`.
- D-009: `scripts/lib.mjs send()` invalidates near-api-js's cached nonce and retries on InvalidNonce. Two tools sharing one key had raced.
