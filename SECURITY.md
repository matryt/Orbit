# Security Policy

Orbit is a modern desktop SFTP & S3 client designed with security and privacy as core priorities. We take the security of our application and the protection of user credentials seriously.

## Supported Versions

Only the latest release versions receive active security patches.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

---

## Reporting a Vulnerability

If you discover a security vulnerability in Orbit, please report it responsibly so that we can address it before public disclosure.

### Reporting Method

Please report all security vulnerabilities via **GitHub Private Vulnerability Reporting (PVR)**:
👉 **[Open a Private Security Advisory](https://github.com/matryt/Orbit/security/advisories/new)**

This enables private, encrypted collaboration between security researchers and maintainers without exposing details publicly before a fix is released.

*(To submit a report, navigate to the **Security** tab of this repository, select **Advisories**, and click **Report a vulnerability**).*

### What to Include in Your Report

To help us triage and resolve the issue quickly, please provide:
1. **Type of Vulnerability**: (e.g., Path Traversal, Credential Exposure, Injection, Host Key Bypass).
2. **Impact**: Potential consequences if exploited.
3. **Step-by-Step Reproduction**: Detailed reproduction steps or Proof of Concept (PoC).
4. **Affected Environment**: Operating system (macOS / Windows / Linux) and Orbit version.
5. **Mitigation Suggestion**: (Optional) Any recommendations on how to patch the issue.

### Our Commitment

* **Acknowledgment**: We strive to acknowledge received vulnerability reports within **48 hours**.
* **Remediation**: We will work on validating and patching confirmed vulnerabilities promptly in a dedicated security release.
* **Credit**: Legitimate security researchers who report vulnerabilities responsibly will be credited in our release notes (unless anonymity is requested).

---

## Security Architecture & Design Principles

* **Zero Plain-Text Secrets**: Orbit never writes SSH passwords, private key passphrases, or S3 secret keys in plain text to disk. All credentials are stored strictly in the operating system's native keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
* **Strict Memory Safety**: The core protocol engine and IPC command handlers are implemented in pure **Rust**, eliminating memory corruption vulnerabilities (e.g., use-after-free, buffer overflows).
* **Least Privilege**: The Tauri desktop bridge exposes minimal native capabilities, and web content security policies restrict unauthorized external script execution.

---

## Release Integrity & Artifact Verification

Orbit implements multiple layers of cryptographic verification to guarantee that distributed binaries are authentic, untampered with, and originate from the official build pipeline:

### 1. Cryptographic SHA-256 Checksums
* Every release includes an official `SHA256SUMS.txt` asset and an integrity table directly in the release notes.
* Release checksums are also archived in the [`checksums/`](checksums/) directory of this repository and at [`SHA256SUMS.txt`](SHA256SUMS.txt).
* **macOS / Linux**:
  ```bash
  shasum -a 256 <downloaded-file>
  ```
* **Windows (PowerShell)**:
  ```powershell
  Get-FileHash <downloaded-file> -Algorithm SHA256
  ```

### 2. GitHub Artifact Attestations (Sigstore / SLSA Provenance)
* All release binaries are signed cryptographically with GitHub's Artifact Attestation infrastructure (`actions/attest-build-provenance`).
* You can verify that a binary was produced by the official GitHub Actions workflow from this repository:
  ```bash
  gh attestation verify <downloaded-file> --owner matryt
  ```
