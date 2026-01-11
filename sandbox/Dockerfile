# Multi-stage Dockerfile for NEAR Treasury Sandbox Test Environment
# Builds and runs:
# - NEAR Sandbox (via near-sandbox binary)
# - Bulk Payment Contract
# - Treasury Backend (nt-be)
# - Sputnik DAO Indexer (proposal caching)

# ============================================================================
# Stage 1: Build the Bulk Payment Contract
# ============================================================================
FROM rust:1.86 AS contract-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    pkg-config \
    libudev-dev \
    && rm -rf /var/lib/apt/lists/*

RUN cargo install cargo-near --version 0.17.0

RUN rustup target add wasm32-unknown-unknown

COPY contracts/bulk-payment/Cargo.toml contracts/bulk-payment/Cargo.lock* ./
COPY contracts/bulk-payment/src ./src

RUN cargo near build non-reproducible-wasm

# ============================================================================
# Stage 2: Build the Sandbox Initializer
# ============================================================================
FROM rust:latest AS sandbox-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY sandbox/sandbox-init/Cargo.toml ./
COPY sandbox/sandbox-init/src ./src

RUN cargo build --release

# ============================================================================
# Stage 3: Build the Treasury Backend (nt-be)
# ============================================================================
FROM rust:latest AS api-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY nt-be/Cargo.toml nt-be/Cargo.lock ./
COPY nt-be/src ./src
COPY nt-be/migrations ./migrations
COPY nt-be/.sqlx ./.sqlx

ENV SQLX_OFFLINE=true
RUN cargo build --release

# ============================================================================
# Stage 4: Build the Sputnik Indexer
# ============================================================================
FROM rust:latest AS indexer-builder

WORKDIR /app

RUN git clone --depth 1 https://github.com/near-daos/sputnik-dao-caching-api-server.git .
RUN cargo build --release --bin sputnik-indexer

# ============================================================================
# Stage 5: Runtime environment
# ============================================================================
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y \
    curl \
    supervisor \
    ca-certificates \
    socat \
    postgresql \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built binaries
COPY --from=sandbox-builder /build/target/release/sandbox-init /usr/local/bin/
COPY --from=api-builder /build/target/release/nt-be /usr/local/bin/
COPY --from=indexer-builder /app/target/release/sputnik-indexer /usr/local/bin/

# Copy contract WASM
COPY --from=contract-builder /build/target/near/bulk_payment_contract.wasm /app/contracts/bulk_payment.wasm

# Copy configuration files
COPY sandbox/supervisord.conf /etc/supervisor/conf.d/
COPY sandbox/start-sandbox.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/start-sandbox.sh

# Copy additional contracts (DAO factory, wrap.near, etc.)
COPY sandbox/contracts/ /app/contracts/

# Create directories
RUN mkdir -p /data /var/log

# Expose ports
# 3030 - NEAR RPC
# 8080 - Treasury API
# 5001 - Sputnik Indexer
# 5432 - PostgreSQL
EXPOSE 3030 8080 5001 5432

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
