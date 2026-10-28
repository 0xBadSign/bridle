# Progress

## Where we are
- M0 done. M1 done: core and vault are live on testnet. M2 and M3 logic is implemented in core and unit/property tested. Live coverage so far: deposit credit, supply (approve + supply), DAO fast outflow, parked outflow, veto, and rejections.
- Next: the M4 sandbox (mock signer) and `make demo`; a live suite for the remaining paths (withdraw, unwind, cancel, probe, upgrade, key changes); M5 agent and arena; M6 dashboard and README.

## Testnet deployment
| What | Value |
|---|---|
| Vault | `vault.bridle-hq.testnet`. A sub-account created without any key; only function-call keys, listed at deploy. Deploy tx `GvJQgpqL5P5MRttooxSdVRDbhKWAtA2Lvvy1pRugodYd` |
| Vault Base address (MPC-derived) | `0x96fbd55e58c16b10df15532e9157e067f2d1d8aa` |
| Owner DAO | `bridle-hq.sputnik-v2.testnet`. Council `bridle-hq.testnet`, 1-of-1. Create tx `DivTyMizcMJz6SPV5mtDhtKKp5uPrVFFbkSNKkMQ4dwL` |
| Treasury (DAO-derived Base address, path `treasury`) | `0xdc35e2ce2ae9c135795b6cc53288d4f72a866007` |
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
