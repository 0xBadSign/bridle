# Everything needed to run the README end to end, baked in:
#   docker run --rm <image> make demo-prebuilt   # offline story on the prebuilt wasm
#   docker run --rm <image> make demo            # offline story on contracts built here
#   docker run --rm <image> make verify          # live testnet claims (needs network access)
#   docker run --rm <image> make check           # the full quality gate
# Debian 13 (glibc 2.41): the near-sandbox binary needs glibc 2.39 or newer.
# Rust stable + wasm32 + cargo-near 0.22.0 + Node 22 + npm ci + the near-sandbox binary.
FROM node:22-trixie AS node

FROM rust:1-trixie
# Node 22 is copied from the official Node image (no installer scripts are run).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

RUN rustup target add wasm32-unknown-unknown \
 && rustup component add rustfmt clippy \
 && cargo install cargo-near --version 0.22.0 --locked --no-default-features

WORKDIR /bridle
COPY package.json package-lock.json ./
RUN npm ci
# Download the NEAR sandbox binary now so that the demo runs offline.
RUN npx --no-install near-sandbox --version

COPY . .
ENV CARGO_TARGET_DIR=/bridle/target CARGO_BUILD_JOBS=4
# Build both contracts now so `make demo` starts from a warm cache.
RUN make build

CMD ["make", "demo-prebuilt"]
