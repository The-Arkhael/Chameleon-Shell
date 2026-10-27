# Image for Cursor cloud agents (web/mobile). Ubuntu 24.04 x86-64.
# Do NOT COPY the project in here: Cursor clones the repo itself. git and sudo are required by Cursor.
# Everything the repo's scripts need is installed: Node + pnpm, the pinned Rust toolchain with the
# wasm32 target, wasm-pack, and the Linux tools used to build/verify the ELF fixtures.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo xz-utils unzip \
      build-essential pkg-config libssl-dev binutils musl-tools strace \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (official tarball, avoids third-party apt repos) and pnpm (version matches package.json).
ARG NODE_VERSION=22.22.2
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g pnpm@10.34.6

# Rust 1.86.0 (same as engine/rust-toolchain.toml) in a shared, world-writable location so whichever
# user the agent runs as can build without re-downloading toolchains.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.86.0 \
      -c clippy -c rustfmt -t wasm32-unknown-unknown \
    && cargo install wasm-pack --version 0.13.1 --locked \
    && chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"
