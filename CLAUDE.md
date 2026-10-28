# Bridle: notes for coding agents

Bridle is the policy module for a Sputnik DAO's Chain Signatures account on NEAR testnet. Start with `README.md`; the step-by-step verification path is `JUDGING.md`.

## Verify without keys or Rust

```bash
npm ci
make verify          # re-checks every live testnet claim of the README against public RPCs; ends with RESULT: PASS
make demo-prebuilt   # offline story on a local NEAR sandbox with the prebuilt vault; ends with RESULT: PASS
node scripts/verify-attestation.mjs --latest vault.bridle-hq.testnet --count 2   # checks an MPC landing proof
```

`docs/VERIFY.md` maps each README claim to the command or check that proves it.

## Layout

- `crates/bridle-core`: pure policy and ledger logic (no NEAR, no I/O), with property tests.
- `contracts/bridle-vault`: the NEAR contract (Chain Signatures, landing proofs, DAO lanes).
- `agent/`: the untrusted operator (rule parser, optional LLM planner) and the keeper.
- `web/`: the dashboard (static, reads public RPCs). `scripts/`: deploy, verify and demo tools.

## Building from source

Rust checks and contract builds: `bash scripts/check.sh` (needs Rust, `cargo-near`). Everything above works without them.

## Conventions

- English only. No secrets in the repository; the only published keys are the deliberately public arena keys in `web/arena-keys.js` (limited function-call keys, explained there).
- Testnet only. Do not vote on proposals of `bridle-hq.sputnik-v2.testnet`: the open demo proposal is deliberately malicious and exists for the Proposals X-ray page.
