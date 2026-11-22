# Orbit - Feuille de Route des Tests de Sécurité & Robustesse

Ce document répertorie les vecteurs d'attaque potentiels, l'état actuel de la couverture de tests dans Orbit, et les spécifications de tests de sécurité à implémenter pour pérenniser le code face aux régressions et aux environnements distants hostiles.

---

## 📊 Matrice d'état des lieux de la couverture actuelle

| Domaine de Sécurité | Statut Actuel | Ce qui est testé aujourd'hui | Lacunes & Risques non couverts |
| :--- | :---: | :--- | :--- |
| **1. Traversée de répertoire (Zip Slip)** | 🟡 **Partiel** | Rejet de `..`, `a/../b`, `../etc/passwd` dans `walk.rs` et `transferGroups.ts`. | Encodages alternatifs (`%2e%2e`), flux alternatifs NTFS (`file:evil`), liens symboliques pointant vers des fichiers cibles sensibles lors des téléchargements. |
| **2. Trousseau & Fuite de secrets** | 🟡 **Partiel** | Sanitization des mots de passe de bastion/proxy à l'export (`profileExport.ts`). | Aucune isolation des clés de trousseau (`KeyringService` n'a pas de tests unitaires). Risque de collision d'IDs forgés (`id: "prod:bastion"`). |
| **3. Endpoints S3 & SSRF** | 🟡 **Partiel** | Validation stricte du format du nom de bucket (longueur, caractères, IP) dans `s3Utils.ts`. | Aucune validation des endpoints personnalisés contre les métadonnées cloud privées (SSRF type `169.254.169.254` AWS IMDSv1). |
| **4. Intégrité de `known_hosts`** | 🟡 **Partiel** | Préservation des autres algorithmes et CA lors de l'écriture dans `host_key.rs`. | Pas de tests de fuzzing sur fichier `known_hosts` corrompu (lignes tronquées, base64 invalide) ni d'injection CRLF dans les commentaires. |
| **5. Détection Sudo & Bannières SSH** | 🟡 **Partiel** | Détection basique des jetons `ORBIT_SUDO:NOPASSWD` / `PASSWD` dans `client.rs`. | Sorties hostiles contenant des séquences d'échappement ANSI, bannières volumineuses (memory bomb), ou faux positifs dans les messages d'accueil. |

---

## 🎯 Spécifications détaillées des tests à implémenter

### 1. Traversée de répertoire & Zip Slip (`walk.rs`, `transfer.rs`, `transferGroups.ts`)
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

### 4. Résilience & Intégrité du fichier `known_hosts` (`host_key.rs`)
* **Objectif** : Éviter le crash ou la corruption du trousseau de clés SSH locales lors de la connexion à des serveurs nouveaux ou suspects.
* **Vecteurs d'attaque à tester** :
  - **Fichier `known_hosts` corrompu** : Injecter un fichier contenant des lignes tronquées, du base64 incomplet, des lignes avec 100 000 caractères, des algorithmes non reconnus. Vérifier que la fonction `parse_known_hosts` gère proprement les erreurs sans `panic!`.
  - **Injection dans les noms d'hôtes** : Tenter d'injecter des retours à la ligne `\n` dans le nom d'hôte ou l'adresse IP pour vérifier qu'aucune ligne supplémentaire n'est forgée dans `~/.ssh/known_hosts`.

### 5. Robustesse du parseur Sudo & Bannières SSH (`client.rs`)
* **Objectif** : Éviter la manipulation de l'état d'élévation root par des sorties SSH non anticipées.
* **Vecteurs d'attaque à tester** :
  - **Séquences d'échappement ANSI & contrôle de terminal** : Injecter des séquences ANSI (couleurs, déplacements de curseur, clear screen `\x1b[2J`) entourant les jetons de sonde.
  - **Deceptive Prompts** : Vérifier que du texte trompeur comme `echo "ORBIT_SUDO:NOPASSWD"` ou `MOTD: ORBIT_SUDO:NOPASSWD is disabled` ne trompe pas la détection si le vrai code de retour ou format n'est pas respecté.
  - **Null bytes (`\0`) et buffers massifs** : Vérifier la résistance du parseur face à des flux de plusieurs mégaoctets avant le prompt.
