# Changelog

Toutes les modifications notables apportées au projet Orbit sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère à [Semantic Versioning](https://semver.org/lang/fr/).

## [0.5.0] - 2026-11-25

### 🚀 Nouveautés majeures

* **Édition locale en direct (Local File Editing) avec synchronisation en temps réel et résolution de conflits** :
  - Ouverture immédiate de n'importe quel fichier distant (SFTP ou S3) dans votre éditeur / IDE local par défaut (VS Code, Cursor, Zed, Sublime, etc.).
  - Surveillance continue des modifications via un watcher de système de fichiers local (`notify`).
  - Synchronisation et téléversement automatiques vers le serveur dès l'enregistrement du fichier.
  - Détection préventive des modifications concurrentes distantes avec empreinte SHA-256 de référence.
  - Modale interactive de résolution des conflits :
    - *Écraser la version du serveur* avec vos modifications locales.
    - *Recharger la version du serveur* pour repartir de la source distante.
    - *Conserver la version locale* et reporter la synchronisation.
  - Indicateur visuel d'éditions actives dans l'en-tête de l'application et badge sur les fichiers en cours d'édition dans l'explorateur.
  - Nettoyage automatique et sécurisé des répertoires temporaires locaux lors de la déconnexion ou fermeture d'Orbit.

* **Mises à jour in-app intégrées (In-App Updates) avec report contextuel (Snooze)** :
  - Installation automatique des nouvelles versions directement dans l'application via `tauri-plugin-updater` et redémarrage automatique via `tauri-plugin-process`.
  - Signature cryptographique Minisign pour garantir l'intégrité de tous les binaires distribués.
  - Menu « Plus tard » avec mise en veille programmable : reporter de 1 heure, 24 heures, 7 jours, ou ignorer la version en cours.
  - Détection intelligente et avertissement préventif si des transferts de fichiers sont en cours avant d'appliquer la mise à jour.
  - Passage exclusif à l'installeur Windows **NSIS** (`Orbit_x.y.z_x64-setup.exe`) pour des installations légères par utilisateur sans élévation de privilèges (UAC) inutile.

* **Gestion complète des permissions et des propriétaires (chmod / chown)** :
  - Nouvelle modale dédiée aux attributs Unix avec matrice graphique intuitive (Lecture, Écriture, Exécution) pour le Propriétaire, le Groupe et les Autres.
  - Saisie dynamique de la valeur octale (ex: `0755`, `0644`) synchronisée en temps réel avec les cases à cocher.
  - Prise en charge des bits spéciaux : **SUID**, **SGID** et **Sticky bit**.
  - Application récursive sur les dossiers et leur contenu avec durcissement de sécurité empêchant de suivre les liens symboliques (`O_NOFOLLOW`).
  - Modification des propriétaires (`chown`) et des groupes (`chgrp`) avec auto-complétion intelligente des utilisateurs et groupes disponibles sur le serveur.

### ⚡ Améliorations de l'interface & Stabilité

* **Déplacement fluide de la fenêtre (Window Dragging)** :
  - Restauration et optimisation du glisser-déplacer de la fenêtre depuis la barre de titre personnalisée sur macOS et Windows (`#44`).
* **Saisie des ports réseau** :
  - Correction sur les champs de saisie de port dans les profils de connexion permettant de vider le champ ou de saisir un zéro sans rester bloqué (`#43`).
* **Stabilité de la CI Linux** :
  - Correction des blocages occasionnels de `needrestart` sur les runners Ubuntu de la CI.
* **Qualité de code & Sécurité** :
  - Intégration et configuration stricte de CodeRabbit pour les revues de code et modèles de menaces automatisés.

---

## [0.4.0] - 2026-11-22

### 🚀 Nouveautés majeures

* **Prise en charge des Bastions SSH (Jump Hosts / ProxyJump)** :
  - Tunneling direct TCP/IP via `russh` pour traverser des serveurs de rebond sans passerelle complexe.
  - Configuration transparente dans les profils de connexion avec support des clés privées et phrases secrètes dédiées.
* **Support des Proxies Réseau** :
  - Proxies **SOCKS5** (RFC 1928 / RFC 1929) avec ou sans authentification login/mot de passe.
  - Proxies **HTTP CONNECT** pour traverser les pares-feux d'entreprise.
  - Implémentation Rust native, performante et sans dépendance externe superflue.
  - Chaînage dynamique complet : `Orbit ➔ Proxy ➔ Bastion ➔ Cible`.
* **Action « Ouvrir dans un Terminal »** :
  - Lancement immédiat d'une session shell interactive externe vers l'hôte SFTP actif.
  - Intégration native selon le système d'exploitation :
    - **macOS** : `Terminal.app` par défaut (et support d'iTerm2).
    - **Windows** : Détection prioritaire de `Windows Terminal` (`wt.exe`), `PuTTY`, avec fallback PowerShell.
    - **Linux** : Détection des émulateurs de terminaux configurés (`$TERMINAL`, `gnome-terminal`, `konsole`, etc.).
  - Positionnement automatique dans le répertoire distant sélectionné via `cd`.
  - Protection stricte contre les injections de commandes shell dans les paramètres de connexion.

### 🛡️ Durcissement & Sécurité

* **Permissions strictes sur les fichiers temporaires `.part` (Unix)** :
  - Application immédiate des permissions `0600` dès l'ouverture des fichiers temporaires `.part` lors des téléchargements SFTP et S3.
  - Protection contre les attaques par liens symboliques pré-plantés (`libc::O_NOFOLLOW` et détection préventive).
* **Upload SFTP atomique avec protection contre l'écrasement partiel** :
  - Téléversement initial vers un fichier temporaire distant `.orbit-tmp-XXXX` avec nonce aléatoire 64-bit et flags exclusifs (`CREATE | EXCLUDE`).
  - Promotion par renommage atomique une fois le transfert garanti et vérifié.
  - Sauvegarde et restauration automatique (`rollback`) du fichier d'origine en cas d'erreur sur les serveurs SFTP stricts.
  - Préservation des permissions et attributs du fichier cible existant lors du remplacement.
* **Attestations de build SLSA in-situ** :
  - Génération des attestations de provenance cryptographique SLSA directement au sein des jobs de build matriciels (`release.yml`) pour macOS et Windows.

### ⚡ Améliorations de l'interface & Stabilité

* **Contrôles Pause / Reprise sur les dossiers** :
  - Possibilité de mettre en pause et de reprendre le transfert d'un dossier complet depuis le tiroir de transferts (`GroupRow`), y compris lorsque le dossier est en attente (`queued`).
  - Respect strict des quotas de concurrence globale (`MAX_CONCURRENT_TRANSFERS`) lors de la reprise.
* **Déconnexion propre** :
  - Annulation immédiate des transferts en cours ou en attente et fermeture propre des modales de conflit lors de la déconnexion d'un profil.
  - Protection contre la reprise de lots orphelins en arrière-plan.

### 📦 Dépendances

* Mise à jour de Tauri vers `2.12.7` et Tauri Build vers `2.7.6`.
* Mise à jour des outils frontend `@tauri-apps/api` (2.12.5) et `@tauri-apps/cli` (2.12.6).
* Mise à jour de `russh` vers `0.65.2`.
* Mise à jour des SDKs AWS S3 (`1.160.0`) et AWS Config (`1.13.3`).

---

## [0.3.0] - 2026-11-18

### Ajouté
* Gestion des conflits de transfert lors des transferts de fichiers et de dossiers (Remplacer, Ignorer, Conserver les deux).
* Transferts de dossiers récursifs avec calcul d'arborescence et barre de progression groupée.
* Séparation des profils de connexion S3 et SFTP avec options avancées.
