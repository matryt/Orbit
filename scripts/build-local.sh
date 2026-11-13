#!/usr/bin/env bash
set -euo pipefail

echo "========================================="
echo "       Orbit Local Release Builder       "
echo "========================================="

# Check requirements
command -v node >/dev/null 2>&1 || { echo "❌ Node.js est requis"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "❌ Rust / Cargo est requis"; exit 1; }

echo "1/3 Installation des dépendances frontend..."
npm ci

echo "2/3 Compilation des assets frontend (TypeScript & Vite)..."
npm run build

echo "3/3 Compilation du binaire et du bundle natif Tauri..."
npx tauri build

echo ""
echo "✨ Build terminé avec succès !"
echo "Les installeurs se trouvent dans : src-tauri/target/release/bundle/"

