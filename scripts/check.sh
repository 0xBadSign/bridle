#!/usr/bin/env bash
# The quality gate. Run inside WSL from the repository root:
#   bash scripts/check.sh          # everything
#   bash scripts/check.sh rust     # only the Rust checks
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/bridle-target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

ONLY="${1:-all}"
failed=()
run() {
    local name="$1"; shift
    echo "== $name"
    if "$@"; then echo "   ok"; else echo "   FAILED"; failed+=("$name"); fi
}

english_only() {
    # Repository prose must be English. Flag accented Latin letters.
    local hits
    hits=$(git ls-files -co --exclude-standard \
        | grep -v -E '^(LICENSE-|scripts/check\.sh|.*package-lock\.json)' \
        | xargs -d '\n' grep -n -P '[x{00C0}-x{024F}]' 2>/dev/null || true)
    [ -z "$hits" ] || { echo "$hits"; return 1; }
}

no_secrets() {
    # Private keys must never be committed.
    local hits
    # web/arena-keys.js holds the deliberately published arena keys (see that file).
    hits=$(git ls-files -co --exclude-standard | grep -v '^web/arena-keys\.js$' | xargs -d '\n' grep -n -E 'ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|"private_key"' 2>/dev/null || true)
    [ -z "$hits" ] || { echo "$hits"; return 1; }
}

build_contracts() {
    for c in contracts/vault contracts/mock-signer; do
        [ -d "$c" ] || continue
        (cd "$c" && cargo near build non-reproducible-wasm --no-abi >/dev/null 2>&1) || { echo "build failed: $c"; return 1; }
    done
}

wasm_imports() {
    # Invariant 2: the vault wasm can never add a full-access key or delete its account.
    local wasm="$CARGO_TARGET_DIR/near/bridle_vault/bridle_vault.wasm"
    [ -f "$wasm" ] || { echo "missing $wasm"; return 1; }
    node scripts/wasm-imports.mjs "$wasm"
}

if [ "$ONLY" = all ] || [ "$ONLY" = rust ]; then
    run "cargo fmt" cargo fmt --all -- --check
    run "clippy" cargo clippy --workspace --all-targets -- -D warnings
    run "tests" cargo test --workspace
    run "contracts build" build_contracts
    run "wasm imports" wasm_imports
fi
if [ "$ONLY" = all ]; then
    run "english only" english_only
    run "no secrets" no_secrets
fi

if [ ${#failed[@]} -gt 0 ]; then
    echo "FAILED: ${failed[*]}"
    exit 1
fi
echo "ALL CHECKS PASSED"
