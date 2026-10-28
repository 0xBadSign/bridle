# Prebuilt contracts

Two wasm files, so the offline demo and the live-claim check run without a Rust toolchain.

| File | What | Where it comes from |
|---|---|---|
| `bridle_vault.wasm` | The vault contract | Fetched with the RPC `view_code` query from `vault.bridle-hq.testnet`. `arena.bridle-hq.testnet` runs the same code. |
| `bridle_mock_signer.wasm` | The sandbox stand-in for `v1.signer` (`make demo` only) | Built from `contracts/mock-signer` |
| `SHA256SUMS` | sha256 of both files | `sha256sum -c SHA256SUMS` |

The vault file is byte-identical to the deployed code by construction: the account's `code_hash` is `base58(sha256(wasm))`, and `make verify` checks that for both vaults. Nothing in the repository names the current hash except `SHA256SUMS`.

Both files are built with `cargo near build non-reproducible-wasm --no-abi` (cargo-near 0.22.0, installed with `--no-default-features`, Rust stable, target `wasm32-unknown-unknown`). That build embeds no reproducibility proof, so a rebuild on another machine can differ byte for byte even from the same source. That is why the vault file is taken from the chain and not from a local build.

## Use

```bash
sha256sum -c deploy/prebuilt/SHA256SUMS      # integrity
make demo-prebuilt                           # offline demo on these files
make verify                                  # includes: deployed code hash == sha256 of bridle_vault.wasm
```

## Refresh after a contract upgrade

```bash
node scripts/refresh-prebuilt.mjs --check                        # exit 1 if bridle_vault.wasm is stale
node scripts/refresh-prebuilt.mjs                                # fetch both vaults, require the same hash, rewrite
node scripts/refresh-prebuilt.mjs --mock path/to/new_mock.wasm   # also replace the mock signer
```

The script only reads from the chain. It refuses to write if the two vaults run different code.
