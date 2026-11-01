# Progress

## Where we are
- 2026-10-29: phase 2 started (PLAN.md section 4, milestones M7 to M12).
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
- O-4: a free OpenAI-compatible API key (e.g. Groq) for `scripts/llm-run.mjs`; until then `docs/evidence/llm-run.md` does not exist and the README says how to produce it.

## Decisions
- D-001 (2026-10-28): full scope of 18-security-design.md; the owner rejected the scope cut.
- D-002: agent and guardian roles are function-call keys on the vault account, identified by `env::signer_account_pk()`. The DAO acts by predecessor.
- D-003: the injection box signs in the browser with a published arena key on a separate arena vault. No hosted server, zero cost.
- D-004: the default agent planner is a deliberately gullible rule-based parser, labelled as such. An LLM is optional via an OpenAI-compatible env var.
- D-005: keeper hints (block hash, block number, tx index, log index, credit sender and amount) enter the expected payload hash. A wrong hint can only cause a missing attestation.
- D-006: the vault uses low-level `env::promise_*` calls instead of `near_sdk::Promise`. The high-level type links the full-access-key and delete-account host functions into the wasm. `scripts/wasm-imports.mjs` proves both are absent.
- D-007: the vault is a sub-account created by its parent in one batch (CreateAccount, Transfer, DeployContract, `new`) with no AddKey. It never had a full-access key, so there is no DeleteKey step to trust.
- D-008: the NEAR RPC defaults to `https://test.rpc.fastnear.com`. `rpc.testnet.near.org` is deprecated and rate-limits with 429.
- D-010 (2026-10-29): phase 2 plan (PLAN.md section 4) from the expansion debate (near-research 20, 21, 23). Evidence and legibility come first; earned trust and `preview` are the only new core features, with hard dates.
- D-011: no second chain. Aave's Arbitrum Sepolia USDC can only be minted by an EOA (`owner()` = `0xab7d…4798`, no code). The MPC does not observe Ethereum Sepolia.
- D-012: two-stage freeze: contract and core 2026-11-05, UI, scripts and docs 2026-11-08.
- D-013: the AI red-team campaign runs before the core freeze and never during judging. Each accepted in-mandate action locks the arena for minutes.
- D-015: the cron keeper runs as a dedicated account `cron.bridle-hq.testnet`, with one function-call key per vault, because a function-call key has a single receiver. `keeper.bridle-hq.testnet` has no full-access key, and its published key reaches only the arena. The full-access key stays in WSL; only the two function-call keys go into GitHub secrets.
- D-014: `v1.signer` (mainnet) and `v1.signer-prod.testnet` have the same code hash `DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9` (checked 2026-10-29). The README's "path to mainnet" paragraph rests on this. Nothing is deployed to mainnet.

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
- 2026-10-28: independent AI-judge-style audit (preliminary score about 7.6/10) found three real issues. Fixed in v2:
  - 2a: a deposit could be credited again after its proof was evicted. Fix: a consumed-proof floor block, plus a 1 USDC minimum credit.
  - 2b: one caller could block settlement. Fix: up to 4 verifies in flight per step, one per caller, with per-caller cooldowns.
  - 2c: a stale parked policy could undo a guardian tightening. Fix: it is re-classified at execute time and refused as `stale_parked`.
  - Also: the upgrade approval is now cleared by the new code's `migrate`, and `uncompressed()` strips exactly one `04` prefix.
  - The README was rewritten to match the code. Live MPC evidence is now in `docs/evidence/`. A GitHub Actions workflow was added.
- 2026-10-28: Aave aToken rounding seen live: 32 USDC supplied showed as 31.999998 aUSDC. Unwind now leaves `UNWIND_DUST` (100 units) in Aave. Live unwind after the fix: idle 39.9999 equals on-chain.
- 2026-10-28: live upgrades of both vaults:
  - v1.1 (dust): main `B7g2YFSF...`, arena `5dJ3qsLe...`.
  - v2 with v1 to v2 state migration: main `GVPJyDt4Tg8ZAfFcahvSaNFVLYHe84m5NaWRV4GEwXss`, arena `H5CdENCopiRZSM3Zop8oSCfGaA5Q4T8Pjou93Eqf7iS2`. Both report `state_version` 2 and their ledgers are intact.
  - Post-migration smoke: arena injection refused (`AH36ycxf...`). The agent's market-mode supply of 31.9999 USDC was attested in both steps (`D9aTFVoX47CbYSB29bN4z7agRtASLvfrVsHn7Aqo4EHE`).
- 2026-10-28: `make demo` 75/75 PASS on the v2 code; `scripts/check.sh` all green.
- 2026-10-29: phase 2 started. The debate with Fable is in near-research 20, 21 and 23; the thesis data spike is in 22.
- 2026-10-29: v3: earned trust and pre-vote previews (M10). Core:
  - The policy gains `trust_floor_per_action`, `trust_step_per_action`, `trust_landings_per_step` and `trust_epochs_per_step`. Raising any of them is parked (short lane); lowering them is FAST.
  - The agent's cap is min(ceiling, floor + level x step).
  - The level rises by at most one step per epoch, and only when an agent operation finishes with every slot `Landed { Main }` by MPC attestation.
  - The level resets to the floor on:
    - an agent-key refusal for `not_allowed` or `above_agent_max`;
    - a guardian pause, veto or unwind;
    - a cancel, a probe-proved revert, or a `dao_resolve` of an agent operation;
    - an agent key rotation;
    - `dao_reset_trust`.
  - New views: `preview_policy`, `preview_outflow`, and `trust` in `get_state`.
  - Migration v2 to v3 lives in `legacy.rs`:
    - Trust starts neutral (floor = ceiling), so no cap changes at the upgrade.
    - Parked policies still waiting are expired.
    - The key allowance is raised to at least 2 NEAR.
    - v1 support was dropped; no v1 state exists.
- 2026-10-29: tests:
  - Core: 38 + 3 + 6 tests, all green.
  - New: 9 scenario tests, and a second interleaving property test with trust invariants.
  - New: a coverage test that proves the random runs reach trust levels 1 and 2. The first coverage run showed 0 of 300 runs earning any trust; an agent-cycle step fixed that.
  - New: 3 migration tests that decode the real v2 `STATE` of both vaults. The fixtures are in `crates/bridle-core/tests/fixtures/`.
  - `scripts/check.sh`: ALL CHECKS PASSED.
- 2026-10-29: live v3 upgrade of both vaults. Each was parked by code hash, refused early and with other code, then applied:
  - main: propose `AM4Ax7G8gSPqhS9Yd64jUpxfNkz8LSjEsHZwtKXYrCQQ`, upgrade `88RekZP3PgtVW7GTYkYjMGcqXo5m3yzFqtnS18uQwksc`;
  - arena: propose `3BaB1fqFwSER4CDJsAcagt4fFeJK8NVfmsCLfmuZCcw3`, upgrade `6LYC3ZupmiagMam9Axv5bXjCQMRRi9QnAbLch7di73kC`.
  - Both report `state_version` 3, unchanged ledgers, function-call keys only, and allowances refreshed to 2 NEAR.
- 2026-10-29: earned trust switched on by a DAO FAST tightening of the floor from 50 to 10 USDC. `preview_policy` predicted lane `fast` beforehand.
  - main: `FfUCgHpqHAufMDHEeu3JGwCnbwsdm6guhpP6mEMXXc16`
  - arena: `H8XxEECByHLMr6RNej4ccq2UBLPMMf2wpieEWgp1BzXC`
- 2026-10-29: cron keeper account `cron.bridle-hq.testnet` (D-015). The workflows `pages.yml` and `keeper.yml` are written but have not run on GitHub yet.
- 2026-10-29: the AI red-team campaign against the arena started (M9). The brief is in `.private/redteam/BRIEF.md`. The attacker accounts `bridle-red-{a,b,c}-1029.testnet` were funded by the public testnet faucet.
- 2026-10-29: live earned trust on the main vault. Three proved agent operations (withdraw 5, supply 5, withdraw 5) counted toward the first step:
  - agent txs: `8sKvwLT8xVPs61U1UeFTwYTu7XTgfoyHB6fGft2jxV6F`, `cHpUzNDCoxMwE7uaTHt124fSJgh1e1Qgf4rN46a7YZj`, `59MvcHev42vjvDWt6DJ2jMkfQmaucNmD5VwGSwT2hp85`.
  - `landings` went 1, 2, 3; `proved_total` is 3.
  - The level waits for the next epoch (2026-10-29 00:00 UTC), as the per-epoch speed limit requires.
- 2026-10-31: first live earned-trust step on the main vault. Agent supply 5 USDC `CwBaWoX3rBU3G4depJaRZwMsJG6ihKvGp1z73jkji5rT`; approve settled `3LUfRVtcGkf8mrfnVzMNgGpXJTh5aKL36aTmGLtKM3Rr`; supply settled `AUQa2fYfJL7m2CX5YXh36hqgVe6fQhmy5w5wbvTaakFv` with `trust_up`. Trust is now level 1, cap 15 USDC, `proved_total` 4, next step not before epoch 20758. Claim V10.
- 2026-10-29: indirect prompt injection. A poisoned market note (`agent/notes/market-note-poisoned.txt`) was read by the agent (`--note`), the agent obeyed, and the arena refused with `not_allowed`: `HagrKqq4YwCgBkcnDaptQ81qiHiKtB7cKPYUpVLQzt8q`. The arena page has the same example.
- 2026-10-29: independent attestation check:
  - `scripts/verify-attestation.mjs`, with the shared core in `web/lib/attest.js`.
  - The dashboard's Operations page has a "Verify the proof yourself" button on every landed step.
  - Each check rebuilds the MPC payload from Base data and recovers the signature to the MPC's ForeignTx key, without trusting the vault.
  - All live proofs checked pass 12/12, for example `AGFTK8R9dM25HEMFa81XfiqdkJFpb5JHP2MESgrRYzeh` and `4TTTS89jNYnkxF5weQVZjo9Q3Fdx4FRvnEKjzVdW6nc9`.
- 2026-10-29: M7 screener bundle (subagent):
  - `make verify` (`scripts/verify-claims.mjs`, `docs/evidence/claims.json`): 77/77 PASS. All 11 deliberately tampered expectations failed, as they should.
  - `deploy/prebuilt/`: byte-identical to the deployed code, with `make demo-prebuilt` and `scripts/refresh-prebuilt.mjs`.
  - `JUDGING.md` and `docs/VERIFY.md`.
  - `Dockerfile` and `image.yml`, not run end to end locally (D-016).
- 2026-10-29: M8 hosting and liveness (subagent):
  - `pages.yml`, plus the `keeper.yml` cron with `scripts/cron-tick.mjs`. Liveness goes to an orphan `liveness` branch, summarised by `scripts/liveness-report.mjs`.
  - The arena page explains the busy case.
  - The local dry run was clean.
- 2026-10-29: AI red team (M9): three AI attackers (Sonnet, Fable, Opus), 43 logged attempts, 31 of them NEAR transactions.
  - Logs: `docs/evidence/redteam/`. Write-up: `docs/evidence/ai-redteam.md`.
  - No theft, no false accounting, no fake trust, no lane bypass.
  - One real bug, F-RLP (medium, liveness): `r` and `s` were encoded as fixed 32-byte strings, so about 1 in 128 signed transactions was non-canonical and Base refused it.
    - Hit live: Base `0x72dd67dd...58fa5`. Recovered by cancel: `0x18763da1...71e4`.
    - Fixed in `evm::assemble`, which now uses minimal `r` and `s`.
    - Test: `signatures_with_leading_zero_bytes_are_encoded_canonically`.
  - Also added: `extra_json_fields_cannot_add_a_destination`.
- D-016: the Dockerfile uses `node:22-trixie`, because the NEAR sandbox binary needs glibc 2.39 or newer. It was not built locally: the owner removed Docker from WSL. CI builds and publishes it once the repo is public.
- 2026-11-01: Proposals X-ray page (`web/xray.js`, nav "Proposals X-ray"):
  - Reads the owner DAO's proposals that call either vault and explains each open one from its arguments with the vault's own `preview_policy` / `preview_outflow` views: lane, waiting period, vetoing guardians, field-by-field diff with loosens/tightens, exposure before and after, and a red warning when the treasury changes. The proposer's description is shown as untrusted text next to it.
  - "Try a change yourself": edit any field of the live policy and preview it (read-only, nothing signed).
  - `scripts/stage-proposal.mjs` files one open demo proposal and never votes on it. Staged: proposal 20, `HFrxN7yRFjawSYSAdQRdEHzusLZArqqPixDskrSnmi4o` ("routine fee tune-up" that also doubles the agent ceiling and moves the treasury to a burn address; preview: long lane, 10 min, 3 changes). It stays open for the 7-day proposal period, until 2026-11-08 18:35 UTC, so re-stage on 2026-11-08 before that time.
  - Checked in the browser on desktop and at 375 px (no horizontal scroll, no console errors). `scripts/check.sh`: ALL CHECKS PASSED.
- 2026-11-01: the X-ray page reads each vault's owner DAO from `get_state.owner` instead of a constant, so an adopter only adds the vault to `VAULTS`.
- 2026-11-01: `scripts/llm-run.mjs`: one command for the real-model evidence (M9). It runs five direct and indirect injections through any OpenAI-compatible model, sends each plan to the arena with the published agent key (the published keeper finishes anything accepted), and writes `docs/evidence/llm-run.md`. Tested with a local mock model that obeys every injection: dry run, then live, five on-chain refusals `not_allowed` (e.g. `Yy1fCZyfdaTnXSoteWuCzAQJJBhiMDsyknHkQoJRQZc`). The mock output is not committed as evidence; the real run waits for the owner's free API key (O-4).
- 2026-11-01: README "4. Adopt it for your own DAO": configure, deploy in one transaction from the prebuilt wasm, fund and run.
- D-017: no factory contract. PLAN gated it on earned trust and red-team fixes being green early, and a new deploy surface four days before the core freeze adds risk without new evidence. Adoption is the three script steps in the README.
- D-018: the WebLLM arena toggle is dropped. Its gate (at least 80% valid obedient JSON from the chosen in-browser model on the corpus) cannot be measured without a 1-2 GB model download, and the real-model path is covered by `scripts/llm-run.mjs`.
- 2026-11-01: first clean-clone run of the README fastest path (fresh clone of 08d684f, fresh HOME, no keys, WSL): `npm ci` ok, `make verify` 87/87 in 16 s, `make demo-prebuilt` 78/78 in 118 s. Script `.private/clean-run.sh`; repeat on 2026-11-09.
- 2026-11-01: multi-agent review of the day's changes (3 lenses, each finding adversarially verified): 13 confirmed, all fixed.
  - X-ray: arguments are checked the way the vault's serde would (a numeric `amount`, a missing `policy`, non-JSON args or an unknown method are shown as "would fail if executed" instead of a confident preview); an invalid policy shows no lane; multi-action proposals carry guardian removals and unpauses into later actions ("No guardian could veto this"); open outflows are summed against the shared fast allowance; the DAO is paged back over a whole voting period, so newer proposals cannot push an open one out of view; open owner-DAO governance proposals (policy, roles, upgrades) are listed; the try panel is bound to the vault it loaded; refreshes are single-flight and keep open details.
  - Tested with crafted proposals against the live vault (script-tag proposer, image-tag description, numeric amount, remove-all-guardians-then-loosen, unpause-then-send, bad base64, unknown method, governance kind): correct text, no unescaped HTML.
  - `llm-run.mjs`: keeper errors are retried and the run always writes its file; it checks the chain for an active operation instead of trusting the send result.
  - README adoption: the no-DAO path says to pick a new `dao` name; `create-dao.mjs` refuses an existing name and a refused factory call. The demo proposal is described as "currently proposal 20", its description now says DO NOT APPROVE (for the next staging), and the re-stage date is before it expires.
- 2026-11-01: video pipeline (M12, subagent), commit 39b75d4: `node video/make.mjs` drives headless Chrome over CDP (no dependencies), captures the dashboard scenes, renders title cards and burns captions with ffmpeg. Drafts: `video/out/bridle-2m15.mp4` (138 s) and `bridle-45s.mp4` (44.5 s), 1920x1080 H.264; narration with timings in `video/voiceover.md`. One live arena injection was sent for the hook and refused (`not_allowed`). Recapture after the UI freeze; the X-ray beat needs an open demo proposal (re-stage before 2026-11-08 18:35 UTC).
