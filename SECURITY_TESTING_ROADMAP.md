# Orbit - Feuille de Route des Tests de Sécurité & Robustesse

Ce document répertorie les vecteurs d'attaque potentiels, l'état actuel de la couverture de tests dans Orbit, et les spécifications de tests de sécurité à implémenter pour pérenniser le code face aux régressions et aux environnements distants hostiles.

---

## 📊 Matrice d'état des lieux de la couverture actuelle

*Dernière mise à jour : 25/11/2026 (après la 0.5.0).*

| Domaine de Sécurité | Statut Actuel | Ce qui est testé aujourd'hui | Lacunes & Risques non couverts |
| :--- | :---: | :--- | :--- |
| **1. Traversée de répertoire & noms locaux** | 🟢 **Couvert** (hors test Windows réel) | Rejet de `..`, `a/../b`, octets nuls, `\` dans `walk.rs`, `sftp/client.rs` et `transferGroups.ts`. Liens symboliques non suivis lors des parcours. Noms invalides sous Windows (`:` / flux NTFS, `<>"\|?*`, `CON`, points finaux) réécrits avant la détection de conflits (`toWindowsSafeName`). | Validation manuelle sur un vrai poste Windows. Les encodages `%2e%2e` sont sans objet : aucun chemin n'est décodé comme une URL. |
| **2. Trousseau & Fuite de secrets** | 🟡 **Partiel** | Mots de passe de bastion/proxy exclus de l'export (`networkProfile.test.ts`). | `KeyringService` sans tests. Export par liste d'exclusion (`...rest`) et non par liste blanche. Collision `prod:bastion` théorique tant qu'il n'existe pas d'import (IDs générés localement). **Bloquant avant tout import de profils.** |
| **3. Endpoints S3 & SSRF** | 🟡 **Partiel** | Validation du format du nom de bucket dans `s3Utils.ts`. | Aucune validation des endpoints (`169.254.169.254`, adresses locales). Risque faible tant que l'utilisateur saisit lui-même l'endpoint. **Bloquant avant tout import de profils.** |
| **4. Intégrité de `known_hosts`** | 🟢 **Couvert** | `validate_ssh_host` refuse contrôles, espaces et métacaractères (`, # * ? ! [ ] @ \| / \\`) pour la cible et le bastion, à la connexion et avant écriture. Fichier corrompu (lignes tronquées, base64 invalide, 100 000 caractères, BOM, CRLF) traité sans panique. | Le chemin `learn_known_hosts` (nouvel hôte) délègue l'écriture à `russh` : protégé uniquement par la validation à la connexion. |
| **5. Détection Sudo & Bannières SSH** | 🟢 **Couvert** | Lecture plafonnée à 4 Kio, arrêt dès une ligne complète. Seule une ligne strictement égale au jeton compte (ANSI, `echo`, MOTD, octet nul ignorés). | — |
| **6. Frontière IPC (webview → Rust)** | 🔴 **Non couvert** | CSP stricte (`script-src 'self'`), aucun `dangerouslySetInnerHTML`. | `get_secret` renvoie le secret de n'importe quel ID. `storage_read_preview` / `local_read_preview` allouent `max_bytes` sans plafond. |
| **7. Mises à jour in-app** | 🔴 **Non couvert** | Choix de l'asset par OS/arch, comparaison de versions. | Signature invalide, rétrogradation, `latest.json` malformé ou hostile. |
| **8. chmod / chown récursif SFTP** | 🟡 **Partiel** | Liens symboliques non suivis en local (`O_NOFOLLOW`). chown passe par SFTP `setstat` (aucune commande shell construite). | Récursion distante face à des liens symboliques (nécessite un faux serveur SFTP). |
| **9. Chaîne de dépendances** | 🔴 **Non couvert** | Dependabot (mises à jour). | Aucun `cargo audit` / `cargo-deny` / `npm audit` bloquant en CI. |

--- | :---: | :--- | :--- |
| **1. Traversée de répertoire (Zip Slip)** | 🟡 **Partiel** | Rejet de `..`, `a/../b`, `../etc/passwd` dans `walk.rs` et `transferGroups.ts`. | Encodages alternatifs (`%2e%2e`), flux alternatifs NTFS (`file:evil`), liens symboliques pointant vers des fichiers cibles sensibles lors des téléchargements. |
| **2. Trousseau & Fuite de secrets** | 🟡 **Partiel** | Sanitization des mots de passe de bastion/proxy à l'export (`profileExport.ts`). | Aucune isolation des clés de trousseau (`KeyringService` n'a pas de tests unitaires). Risque de collision d'IDs forgés (`id: "prod:bastion"`). |
| **3. Endpoints S3 & SSRF** | 🟡 **Partiel** | Validation stricte du format du nom de bucket (longueur, caractères, IP) dans `s3Utils.ts`. | Aucune validation des endpoints personnalisés contre les métadonnées cloud privées (SSRF type `169.254.169.254` AWS IMDSv1). |
| **4. Intégrité de `known_hosts`** | 🟡 **Partiel** | Préservation des autres algorithmes et CA lors de l'écriture dans `host_key.rs`. | Pas de tests de fuzzing sur fichier `known_hosts` corrompu (lignes tronquées, base64 invalide) ni d'injection CRLF dans les commentaires. |
| **5. Détection Sudo & Bannières SSH** | 🟡 **Partiel** | Détection basique des jetons `ORBIT_SUDO:NOPASSWD` / `PASSWD` dans `client.rs`. | Sorties hostiles contenant des séquences d'échappement ANSI, bannières volumineuses (memory bomb), ou faux positifs dans les messages d'accueil. |

---

## 🎯 Spécifications détaillées des tests à implémenter

### 1. Traversée de répertoire & Zip Slip (`walk.rs`, `transfer.rs`, `transferGroups.ts`) — 🟢

> ✅ Fait : séquences relatives, octets nuls, antislashs, liens symboliques, noms Windows (`pathUtils.test.ts`, `transferGroups.test.ts`). Les encodages URL ne s'appliquent pas (aucun décodage). Reste : valider le comportement sur un vrai poste Windows.

* **Objectif** : Empêcher un serveur SFTP ou S3 distant hostile de déposer des fichiers en dehors du répertoire local de destination sélectionné par l'utilisateur.
* **Vecteurs d'attaque à tester** :
  - **Séquences relatives complexes** : `foo/../../../etc/cron.d/malicious`, `bar/....//....//etc`.
  - **Encodages URL & Unicode** : `%2e%2e%2f`, points et barres obliques Unicode homoglyphes, caractères nuls (`path\0.txt`).
  - **Spécificités Windows** : Chemins absolus avec lettres de lecteur injectés sur cible Windows (`C:\Windows\System32\...`), flux de données alternatifs NTFS (`payload.bat:hidden`).
  - **Liens symboliques distants** : S'assurer que le téléchargement d'un dossier distant contenant un symlink pointant vers un fichier arbitraire distant (`/etc/shadow`) ne téléverse pas le fichier cible par inadvertance.

### 2. Isolation du Trousseau OS & Export de Profils (`keyring_service.rs`, `profileExport.ts`)
* **Objectif** : Garantir l'étanchéité des secrets système et empêcher toute exfiltration accidentelle.
* **Vecteurs d'attaque à tester** :
  - **Collision d'identifiants de sous-clés** : Si un profil est nommé `prod:bastion`, s'assurer que ses identifiants dans le trousseau (`prod:bastion` vs `prod` avec sous-clé `:bastion`) n'entrent pas en collision avec le secret bastion d'un autre profil.
  - **Test par Allowlist stricte pour l'export** : Injecter un profil avec des champs inattendus (`api_token`, `private_key`, `secret_answer`) et prouver par test unitaire qu'une sérialisation ne conserve **que** les clés expressément autorisées dans l'allowlist.

### 3. Endpoints S3 & Protection SSRF (`s3Utils.ts`, `s3/client.rs`)
* **Objectif** : Protéger la machine locale et l'environnement cloud contre les requêtes vers des cibles interdites ou des injections d'en-têtes HTTP.
* **Vecteurs d'attaque à tester** :
  - **Détection des adresses locales & de métadonnées** : Rejeter ou afficher un avertissement fort sur les endpoints pointant vers `169.254.169.254`, `fd00::/8`, ou des adresses de boucle locale non déclarées explicitement comme locales.
  - **Injection CRLF (`\r\n`)** : Tester que l'injection de retours chariot dans les préfixes ou métadonnées S3 ne permet pas de falsifier les en-têtes HTTP de la requête AWS SDK.
  - **Noms de clés avec caractères spéciaux** : Clés avec chevrons `<script>`, esperluette `&`, guillemets, pour valider que le rendu UI n'introduit pas de vulnérabilité XSS.

### 4. Résilience & Intégrité du fichier `known_hosts` (`host_key.rs`) — 🟢

> ✅ Fait : `test_validate_ssh_host_*`, `test_update_known_hosts_rejects_injected_host`, `test_update_known_hosts_survives_corrupted_content`.

* **Objectif** : Éviter le crash ou la corruption du trousseau de clés SSH locales lors de la connexion à des serveurs nouveaux ou suspects.
* **Vecteurs d'attaque à tester** :
  - **Fichier `known_hosts` corrompu** : Injecter un fichier contenant des lignes tronquées, du base64 incomplet, des lignes avec 100 000 caractères, des algorithmes non reconnus. Vérifier que la fonction `parse_known_hosts` gère proprement les erreurs sans `panic!`.
  - **Injection dans les noms d'hôtes** : Tenter d'injecter des retours à la ligne `\n` dans le nom d'hôte ou l'adresse IP pour vérifier qu'aucune ligne supplémentaire n'est forgée dans `~/.ssh/known_hosts`.

### 5. Robustesse du parseur Sudo & Bannières SSH (`client.rs`) — 🟢

> ✅ Fait : `test_parse_sudo_probe_ignores_embedded_tokens`, `test_sudo_probe_output_is_bounded`, `test_sudo_probe_output_stops_on_complete_token_line`, `test_sudo_probe_token_after_cap_is_ignored`.

* **Objectif** : Éviter la manipulation de l'état d'élévation root par des sorties SSH non anticipées.
* **Vecteurs d'attaque à tester** :
  - **Séquences d'échappement ANSI & contrôle de terminal** : Injecter des séquences ANSI (couleurs, déplacements de curseur, clear screen `\x1b[2J`) entourant les jetons de sonde.
  - **Deceptive Prompts** : Vérifier que du texte trompeur comme `echo "ORBIT_SUDO:NOPASSWD"` ou `MOTD: ORBIT_SUDO:NOPASSWD is disabled` ne trompe pas la détection si le vrai code de retour ou format n'est pas respecté.
  - **Null bytes (`\0`) et buffers massifs** : Vérifier la résistance du parseur face à des flux de plusieurs mégaoctets avant le prompt.

### 6. Frontière IPC (`commands.rs`, `lib.rs`)
* **Objectif** : Limiter ce qu'une faille XSS dans la webview pourrait obtenir du backend.
* **À faire / tester** :
  - Plafonner `max_bytes` côté Rust dans `storage_read_preview` et `local_read_preview`, avec un test sur une valeur énorme.
  - Restreindre `get_secret` aux IDs de profils existants (et à leurs suffixes `:bastion` / `:proxy`).
  - Test statique : aucun `dangerouslySetInnerHTML` ni `innerHTML` dans `src/`.

### 7. Mises à jour in-app (`updater.rs`, `tauri-plugin-updater`)
* **Objectif** : Garantir qu'aucun binaire non signé ou plus ancien ne peut être installé.
* **Vecteurs à tester** : signature Minisign invalide ou absente, version inférieure à la version courante, `latest.json` malformé (champs manquants, URL non HTTPS, plateforme inconnue).

### 8. chmod / chown récursif côté SFTP (`sftp/client.rs`)
* **Objectif** : S'assurer que la récursion distante ne traverse jamais un lien symbolique vers un dossier hors de la cible.
* **À faire** : un faux serveur SFTP en mémoire (ou des tests d'intégration contre un conteneur `openssh-server`) pour exercer `set_permissions` récursif.

### 9. Chaîne de dépendances (CI)
* **Objectif** : Bloquer une release qui embarque une dépendance avec une vulnérabilité connue.
* **À faire** : job `cargo audit` (ou `cargo-deny`) et `npm audit --audit-level=high` dans `ci.yml`.

---

## ⚠️ Prérequis avant un import de profils ou de `~/.ssh/config`

L'import ferait entrer des valeurs non saisies par l'utilisateur. Avant de le livrer :
1. Export par **liste blanche** et test qui injecte des champs inattendus (domaine 2).
2. Tests de **non-collision** des clés de trousseau (`prod:bastion` vs `prod` + `:bastion`) et validation des IDs importés (domaine 2).
3. **Validation des endpoints S3** importés (domaine 3).
4. Appliquer `validate_ssh_host` aux hôtes importés dès l'import, pour un message d'erreur clair avant la connexion (domaine 4).
