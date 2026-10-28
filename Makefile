# Run inside WSL / Linux from the repository root.
# `make demo` plays the whole story offline: local NEAR sandbox, mock MPC signer, mock Base.
SHELL := /bin/bash
export CARGO_TARGET_DIR ?= $(CURDIR)/target
export CARGO_BUILD_JOBS ?= 4

.PHONY: build test demo check

build:
	cd contracts/vault && cargo near build non-reproducible-wasm --no-abi
	cd contracts/mock-signer && cargo near build non-reproducible-wasm --no-abi

test:
	cargo test --workspace

demo: build
	@test -d node_modules/near-sandbox || npm ci
	node scripts/demo.mjs

check:
	bash scripts/check.sh
