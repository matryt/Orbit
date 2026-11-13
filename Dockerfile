# Multi-stage Dockerfile for Orbit CI & Testing
FROM rust:bookworm AS builder

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

# Add rustfmt and clippy components
RUN rustup component add rustfmt clippy

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package*.json ./
RUN npm ci

# Copy all source files
COPY . .

# Run all CI checks inside the Linux container
RUN npm run build
RUN cd src-tauri && cargo fmt --all -- --check
RUN cd src-tauri && cargo clippy -- -D warnings
RUN cd src-tauri && cargo test

