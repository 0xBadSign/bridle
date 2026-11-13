# Judging path: verify Bridle in five minutes

Everything below needs only **Node 22**, `npm`, `make` and `git`, on Linux, macOS or WSL. No Rust, no keys, no faucet, no testnet account. The first two steps are the whole check; step 3 is optional.

```bash
git clone https://github.com/0xBadSign/bridle bridle && cd bridle
npm ci                  # about 30 s
make verify             # about 20 s, needs internet (public NEAR and Base Sepolia RPCs, read-only)
make demo-prebuilt      # 2 to 5 min, offline after the first run downloads the NEAR sandbox binary
```

Optional container path: `docker build -t bridle . && docker run --rm bridle make verify`. The author has not run the Dockerfile end to end, so the Node path above is the reference.

## Step 1: `make verify` (live claims)

Explorer pages (nearblocks, basescan) may block automated clients; `make verify` checks every listed hash through public RPC.

Re-checks the live testnet claims of the README against public RPCs (`https://test.rpc.fastnear.com`, `https://sepolia.base.org`). The claims are data in `docs/evidence/claims.json` (id, claim, chain, tx hash or account, expected outcome); the checker is `scripts/verify-claims.mjs`. It sends no transaction.

Expected final lines:

```
87/87 claims verified (0 failed, 0 skipped) in 17s
RESULT: PASS
```

Each line before them is `PASS|FAIL|SKIP  <id>  <chain>  <claim>`. Any FAIL makes the exit code 1. The count grows when claims are added; what matters is `RESULT: PASS`. A `SKIP` is printed only when a vault has an operation in flight, so its ledger and its Base balances legitimately differ for a moment; it is never used to hide a mismatch.

What it proves:

| Group | What is checked on chain |
|---|---|
| NEAR transactions (`E`, `L`, `M` ids) | Each hash in the README evidence table succeeded or failed as claimed: `not_allowed` refusal of the injected request, `parked`, `vetoed`, `upgrading` and `migrated` events, `Method on_signed_call is private`, deploy with no `AddKey` |
| Base Sepolia receipts | Status, sender (the vault's MPC-derived address), target (USDC or the Aave pool), chain id 84532, value 0, and a log with the expected address, topic and amount: Approval, Supply, Withdraw, Transfer |
| Vault ledger | `get_ops`: every step of every operation is `landed` (attested), none is `trusted_landed` (`dao_resolve`) |
| Keys | The vault and arena accounts hold only function-call keys, with constant method lists, finite allowances and the vault itself as receiver |
| Code | The deployed code hash of both vaults equals `sha256(deploy/prebuilt/bridle_vault.wasm)`, and that wasm does not import the host functions that add a full-access key or delete the account |
| Ledger vs. Base | `idle` equals the USDC `balanceOf` the vault's Base address; the aUSDC balance covers `principal` (100 base units of rounding allowed); any surplus is Aave interest, which the ledger does not credit, and must stay under 1%; the vault's `next_nonce` equals the Base nonce |
| Address binding | The MPC-derived key of (vault account, path `bridle`) is the vault's Base address; (DAO account, path `treasury`) is the treasury |

## Step 1b: check an MPC landing proof yourself (30 s)

```bash
node scripts/verify-attestation.mjs --latest vault.bridle-hq.testnet --count 2
```

This does not trust the vault:

1. It finds the vault's latest NEAR transactions that carry an MPC attestation.
2. It re-reads each attested Base transaction from a public Base RPC.
3. It rebuilds the payload the MPC signs (the borsh `ForeignTxSignPayload::V1`).
4. It checks that payload against the hash the vault expected and the hash the MPC signed.
5. It recovers the signature to the MPC network's ForeignTx-domain public key.

Expected: 12 `PASS` lines per transaction, ending with `=> the MPC network attested this Base transaction, and anyone can check it`. The dashboard's Operations page runs the same check in the browser ("Verify the proof yourself").

## Step 2: `make demo-prebuilt` (offline story)

Starts a local NEAR sandbox, deploys the real vault contract (the prebuilt file, whose sha256 is first checked against `deploy/prebuilt/SHA256SUMS`), a mock MPC signer and a mock Base, and plays the whole story with PASS/FAIL assertions. Nothing leaves the machine after the sandbox binary is downloaded.

Expected final lines (from a run on the code deployed on 2026-10-29; the number of checks grows when new beats are added, so read it as "all checks pass"):

```
  10. Audit: the vault, Base and the keys                                                    PASS  7/7
  78/78 checks passed in 117s
RESULT: PASS
```

The first lines are `prebuilt wasm: 2 files match deploy/prebuilt/SHA256SUMS (no Rust build)`. The exit code is non-zero if any check fails.

What it proves: a deposit is credited only after attestation; the agent supplies to Aave in two attested steps; the agent's earned cap rises only after a proved landing, at most once per epoch, and falls back to the floor after an injected request; a prompt-injected agent's requests are refused on-chain and counted; forged and reverted landings are never attested; a stuck tx is cancelled at the same nonce and a reverted one is resolved by a probe; an MPC timeout is retried at the same nonce; an outflow above the limit is parked and vetoed; guardians can tighten but never loosen; the vault has no full-access key. Mock signer and mock Base are labelled as mocks; the same flows ran against the real MPC network and Base Sepolia, which is what step 1 re-checks.

## Step 3 (optional): build from source

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-near --version 0.22.0 --locked --no-default-features   # 5 to 10 min
make demo               # builds both contracts, then the same demo (final line: RESULT: PASS)
make check              # fmt, clippy, tests, contract builds, wasm import check, English-only, no-secrets scan
```

A local rebuild may differ byte for byte from `deploy/prebuilt/bridle_vault.wasm` (non-reproducible build); that is why the prebuilt vault file is the code fetched from the chain. `make verify` compares the chain with the prebuilt file, not with your build.

## Where to look next

- `docs/VERIFY.md`: one row per README claim: command, expected line, and the test or code that holds the assertion. It ends with the claims that are verified only by reading code.
- `docs/evidence/claims.json` and `docs/evidence/live-tests.md`: the machine-readable and the narrative live evidence.
- `deploy/prebuilt/README.md`: how the prebuilt files were made and how they are refreshed after an upgrade (`node scripts/refresh-prebuilt.mjs`).
- The dashboard's **Proposals X-ray** page (`web/xray.js`): an open demo proposal whose description says "routine fee tune-up" while its arguments move the treasury to a burn address, explained from the arguments by the vault's own `preview_policy` before anyone votes.
- `scripts/llm-run.mjs`: the same arena attacks through any OpenAI-compatible model, with each plan sent on-chain and the table written to `docs/evidence/llm-run.md` (recorded runs: `llm-run.md`, `llm-run-qwen.md`).
