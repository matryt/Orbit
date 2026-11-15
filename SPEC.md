# SPEC.md — Orbit (Client S3 & SFTP Desktop Moderne)

## 1. Vision, Contexte & Stratégie Open Source
Orbit est une application desktop légère, rapide et esthétique (inspirée de *Transmit*, *Linear* et *Raycast*) destinée à remplacer Cyberduck et FileZilla pour la gestion de fichiers **S3** (AWS, Cloudflare R2, Scaleway, MinIO) et **SFTP**.

* **Environnement de développement principal :** macOS (développement et tests locaux avec rendu natif Apple).
* **Plateformes de distribution :** macOS (`.dmg` Apple Silicon ARM64) et Windows 10/11 (`.msi` / `.exe`) compilés automatiquement via **GitHub Actions**.
* **Philosophie Open Source (Dépôt Public MIT) :** Outil développé pour répondre à un besoin personnel et partagé avec la communauté. Le périmètre reste volontairement minimaliste (pas de *feature creep*). Le `README.md` précisera que les suggestions sont ouvertes mais que seules les fonctionnalités alignées avec la vision simple et rapide du projet seront retenues (PR bienvenues).

---

## 2. Stack Technique Imposée

### Frontend (TypeScript / React)
* **Framework :** Tauri v2 + React 18 + TypeScript + Vite
* **Styling :** Tailwind CSS + `shadcn/ui` + `lucide-react` (icônes)
* **Gestion d'état :** Zustand (synchronisation fluide des files de transferts et de l'état de navigation)

### Backend (Rust — `src-tauri`)
* **Runtime asynchrone :** `tokio` (features `full`)
* **S3 :** `aws-sdk-s3` + `aws-config` (support obligatoire des `endpoint_url` personnalisés et `force_path_style` pour Cloudflare R2, Scaleway, MinIO)
* **SFTP :** `russh` + `russh-sftp` (100% Rust pur, garantissant une compilation croisée sans erreur OpenSSL/libssh2 entre macOS et Windows)
* **Sécurité / Secrets :** `keyring` (ou `tauri-plugin-keyring`) pour stocker les mots de passe, clés secrètes S3 et passphrases SSH dans le trousseau natif de l'OS (Keychain macOS / Credential Manager Windows)
* **Sérialisation :** `serde` + `serde_json`

---

## 3. Architecture Backend (`src-tauri/src/`)

### 3.1 Trait unifié `StorageProvider`
Toute la logique de navigation et de transfert doit implémenter une interface commune pour que le frontend reste agnostique du protocole :

```rust
#[async_trait]
pub trait StorageProvider: Send + Sync {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, AppError>;
    async fn create_dir(&self, path: &str) -> Result<(), AppError>;
    async fn delete(&self, path: &str, is_dir: bool) -> Result<(), AppError>;
    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), AppError>;
    async fn read_preview(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, AppError>;
    async fn upload_file(&self, local_path: PathBuf, remote_path: String, progress_tx: Channel<TransferProgress>) -> Result<(), AppError>;
    async fn download_file(&self, remote_path: String, local_path: PathBuf, progress_tx: Channel<TransferProgress>) -> Result<(), AppError>;
}
```

### 3.2 Gestion des transferts en streaming & Compatibilité OS
* **Zéro chargement complet en RAM :** Lecture et écriture par flux (`tokio::io::AsyncRead` / `AsyncWrite`) pour supporter des fichiers de plusieurs gigaoctets sans saturation mémoire.
* **Tauri Channels :** Émission de la progression (`bytes_transferred`, `total_bytes`, `speed_bps`) vers React toutes les 150ms maximum.
* **S3 Multipart :** Bascule automatique en *Multipart Upload* au-delà de 10 Mo.
* **Chemins cross-platform :** Utilisation stricte de `std::path::PathBuf` côté Rust et `@tauri-apps/api/path` côté TypeScript (aucun séparateur `/` ou `\` codé en dur pour les fichiers locaux).

### 3.3 Profils de connexion & Partage
* Métadonnées sauvegardées dans `connections.json` (dans `app_config_dir`).
* Secrets (`secret_access_key`, `password`, `ssh_passphrase`) isolés dans le trousseau système via `keyring`, liés par l'UUID du profil.
* **Export / Import JSON :** Exportation propre des configurations serveurs sans les secrets pour faciliter le partage d'accès entre utilisateurs.

---

## 4. Spécifications UI / UX & Intégration OS

### 4.1 Fenêtre Native (macOS First + Compatibilité Windows)
* **macOS :** `titleBarStyle: "Overlay"`, `hiddenTitle: true`, effet translucide subtil sur la sidebar (`window-vibrancy` avec `Effect::Sidebar`). Marge gauche (`pl-20`) dans le header React pour les feux tricolores natifs.
* **Windows :** `decorations: false`. Affichage conditionnel d'un composant `<WindowsTitlebar />` (Réduire, Agrandir, Fermer) en haut à droite via détection `@tauri-apps/plugin-os`.

### 4.2 Drag & Drop Natif
* Écoute exclusive de l'événement Tauri `tauri://drag-drop` pour récupérer les chemins absolus (`PathBuf`) depuis le Finder macOS ou l'Explorateur Windows.

### 4.3 Composants Clés de l'Interface
1. **Sidebar (240px) :** Liste des favoris avec badge `S3` (ambre) ou `SFTP` (bleu), pastille de connexion active, bouton `+ Nouvelle connexion` et bouton `Exporter profils`.
2. **Header de navigation :** Fil d'Ariane (Breadcrumbs) cliquable + filtre instantané sur le dossier courant.
3. **Vue Explorateur :**
   * Mode **Panneau unique (Distant)** par défaut.
   * Mode **Double panneau (Local | Distant)** activable via le header ou `Cmd/Ctrl + B`.
4. **Quick Look (`Espace`) :** Téléchargement partiel en mémoire (`read_preview`, max 2 Mo) pour afficher instantanément les fichiers texte/code (JSON, YAML, Logs, Markdown) et images (PNG, JPG, WebP) dans une modale.
5. **Tiroir de transferts :** Barre rétractable en bas de fenêtre, visible uniquement lors des transferts actifs, affichant la vitesse en Mo/s et la progression.

---

## 5. CI/CD & Distribution (GitHub Actions)

Dès la validation de la V1 sur macOS, configurer un workflow `.github/workflows/release.yml` utilisant `tauri-apps/tauri-action` :
* Déclenchement automatique sur création d'un tag `v*` (ex: `v0.1.0`).
* Matrice de build parallèle : `macos-latest` (génération du `.dmg`) et `windows-latest` (génération du `.msi` / `.exe`).
* Publication automatique des binaires sur la page **GitHub Releases** du dépôt public.
* Documentation dans le `README.md` incluant un GIF de démonstration et la commande Gatekeeper macOS (`xattr -cr /Applications/Orbit.app`) pour le premier lancement des binaires non signés.

---

## 6. Plan d'Exécution Étape par Étape (Pour l'IA)

* **Étape 1 (Coquille UI macOS/Windows) :** Initialiser Tauri v2 + React + Tailwind + shadcn/ui. Monter l'interface complète avec données mockées, le header `Overlay` macOS (et fallback boutons Windows), les raccourcis clavier (`Espace`, `Cmd+B`, `Cmd+F`) et la modale Quick Look.
* **Étape 2 (Couche S3) :** Implémenter `S3Provider` en Rust avec `aws-sdk-s3` (endpoint custom + multipart upload) et `keyring`. Connecter au frontend.
* **Étape 3 (Couche SFTP) :** Implémenter `SftpProvider` en Rust avec `russh` et `russh-sftp` (auth par mot de passe et clés SSH `~/.ssh/id_ed25519` / `id_rsa`).
* **Étape 4 (Drag & Drop, Panneau Local & CI/CD) :** Brancher `tauri://drag-drop`, le listing local pour le mode double panneau, l'import/export JSON des profils, et générer le workflow GitHub Actions + `README.md`.

