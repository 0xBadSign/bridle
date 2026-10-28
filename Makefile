# Run inside WSL / Linux from the repository root.
# `make verify`        re-checks every live testnet claim against public RPCs (Node only, no keys).
# `make demo-prebuilt` plays the whole story offline on the prebuilt wasm (Node only, no Rust).
# `make demo`          the same story on contracts built from source (needs Rust and cargo-near).
SHELL := /bin/bash
export CARGO_TARGET_DIR ?= $(CURDIR)/target
export CARGO_BUILD_JOBS ?= 4

.PHONY: build test demo demo-prebuilt verify check

build:
	cd contracts/vault && cargo near build non-reproducible-wasm --no-abi
	cd contracts/mock-signer && cargo near build non-reproducible-wasm --no-abi

test:
	cargo test --workspace

demo: build
	@test -d node_modules/near-sandbox || npm ci
	node scripts/demo.mjs

demo-prebuilt:
	@test -d node_modules/near-sandbox || npm ci
	node scripts/demo.mjs --prebuilt

verify:
	@test -d node_modules/near-api-js || npm ci
	node scripts/verify-claims.mjs

check:
	bash scripts/check.sh
