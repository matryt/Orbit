# Directives du Projet Orbit

Ce fichier définit les règles et contraintes que les agents d'assistance doivent toujours respecter sur ce projet.

## Qualité et Validation du Code avant tout Commit / Push

Avant d'effectuer tout `git commit` ou `git push`, les étapes suivantes sont **obligatoires** :

1. **Formatage Rust (Impératif)** :
   - Toujours exécuter `cargo fmt --manifest-path src-tauri/Cargo.toml` et vérifier avec `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`.
   - La CI échoue immédiatement si le formatage Rust n'est pas appliqué.

2. **Linters & Tests Rust** :
   - Exécuter `cargo clippy --manifest-path src-tauri/Cargo.toml` (zéro warning toléré).
   - Exécuter `cargo test --manifest-path src-tauri/Cargo.toml`.

3. **Validation Frontend** :
   - Exécuter `npm run build` (validation TypeScript `tsc` et compilation Vite).
   - Exécuter `npm test` (suite de tests unitaires node:test).
