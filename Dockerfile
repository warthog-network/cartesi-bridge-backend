# syntax=docker.io/docker/dockerfile:1

# ────────────────────────────────────────────────────────────────
# STAGE 1: Build Rust zk-proof-generator + JanusHash checker (riscv64)
# ────────────────────────────────────────────────────────────────
FROM rustlang/rust:nightly AS rust-build

# Install cross-compile deps (Debian-based image)
RUN apt-get update && apt-get install -y \
    gcc-riscv64-linux-gnu \
    g++-riscv64-linux-gnu \
    binutils-riscv64-linux-gnu \
    make \
    && rm -rf /var/lib/apt/lists/*

# Add riscv64 target
RUN rustup target add riscv64gc-unknown-linux-gnu

WORKDIR /usr/src/dapp-rust
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# Build for riscv64
ENV CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_GNU_LINKER=riscv64-linux-gnu-gcc
RUN cargo build --release --target riscv64gc-unknown-linux-gnu --bin zk-proof-generator

# Extract the final binary
RUN mv target/riscv64gc-unknown-linux-gnu/release/zk-proof-generator /zk-proof-generator

# JanusHash / VerusHash v2.2 checker (portable soft-SIMD for RISC-V)
# Static link so Cartesi jammy (older glibc) can run the binary.
WORKDIR /usr/src/janushash
COPY native/janushash/ ./
RUN make clean \
  && make -j"$(nproc)" TARGET=riscv64 \
       LDFLAGS="-static -static-libgcc -static-libstdc++" \
  && cp janushash-check /janushash-check \
  && riscv64-linux-gnu-strip /janushash-check || true \
  && file /janushash-check || true

# ────────────────────────────────────────────────────────────────
# STAGE 2: Build JavaScript part (your existing dApp logic)
# ────────────────────────────────────────────────────────────────
FROM node:20.16.0-bookworm AS js-build

WORKDIR /opt/cartesi/dapp
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ────────────────────────────────────────────────────────────────
# FINAL STAGE: Cartesi RISC-V runtime (linux/riscv64)
# ────────────────────────────────────────────────────────────────
FROM --platform=linux/riscv64 cartesi/node:20.16.0-jammy-slim

ARG MACHINE_EMULATOR_TOOLS_VERSION=0.14.1
ADD https://github.com/cartesi/machine-emulator-tools/releases/download/v${MACHINE_EMULATOR_TOOLS_VERSION}/machine-emulator-tools-v${MACHINE_EMULATOR_TOOLS_VERSION}.deb /
RUN dpkg -i /machine-emulator-tools-v${MACHINE_EMULATOR_TOOLS_VERSION}.deb \
  && rm /machine-emulator-tools-v${MACHINE_EMULATOR_TOOLS_VERSION}.deb

LABEL io.cartesi.rollups.sdk_version=0.9.0
LABEL io.cartesi.rollups.ram_size=128Mi

ARG DEBIAN_FRONTEND=noninteractive
# REQUIRED: cartesi-init is `#!/bin/busybox sh` — without busybox the machine panics (ENOENT).
RUN <<EOF
set -e
apt-get update
apt-get install -y --no-install-recommends busybox-static || \
  apt-get install -y --no-install-recommends busybox-static=1:1.30.1-7ubuntu3
# Ensure /bin/busybox exists for cartesi-init shebang
if [ ! -x /bin/busybox ]; then
  if [ -x /bin/busybox.static ]; then ln -sf /bin/busybox.static /bin/busybox
  elif command -v busybox >/dev/null; then ln -sf "$(command -v busybox)" /bin/busybox
  else echo "busybox not found after install" >&2; exit 1
  fi
fi
rm -rf /var/lib/apt/lists/* /var/log/* /var/cache/*
id dapp >/dev/null 2>&1 || useradd --create-home --user-group dapp
EOF

ENV PATH="/opt/cartesi/bin:${PATH}"

WORKDIR /opt/cartesi/dapp

# Copy JS build artifacts
COPY --from=js-build /opt/cartesi/dapp/dist .

# Copy Rust zk-proof-generator binary (built on host)
COPY --from=rust-build /zk-proof-generator /opt/cartesi/bin/zk-proof-generator
RUN chmod +x /opt/cartesi/bin/zk-proof-generator

# Janus8 PoW checker (VerusHash v2.2 × SHA256t)
COPY --from=rust-build /janushash-check /opt/cartesi/bin/janushash-check
RUN chmod +x /opt/cartesi/bin/janushash-check

ENV ROLLUP_HTTP_SERVER_URL="http://127.0.0.1:5004"
ENV JANUSHASH_CHECK=/opt/cartesi/bin/janushash-check
ENV WART_SPV_REQUIRE_POW=1

ENTRYPOINT ["rollup-init"]
CMD ["node", "index.js"]
