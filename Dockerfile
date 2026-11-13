# Multi-stage Dockerfile for Orbit CI & Testing
FROM rust:1.85-bookworm AS builder

# Install system dependencies for Tauri and Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    pkg-config \
    libglib2.0-dev \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package*.json ./
RUN npm ci

COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
WORKDIR /app/src-tauri
# Fetch rust dependencies
RUN cargo fetch
WORKDIR /app

# Copy all source files
COPY . .

# Run validation checks
CMD ["sh", "-c", "npm run build && cd src-tauri && cargo clippy -- -D warnings && cargo test"]

