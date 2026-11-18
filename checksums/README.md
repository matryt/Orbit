# Release Checksums Archive

This directory stores cryptographic SHA-256 checksums (`<tag>.sha256`) for all official Orbit releases.

## Verification

To verify a downloaded binary against the recorded checksum:

### macOS / Linux
```bash
shasum -a 256 <file>
```

### Windows (PowerShell)
```powershell
Get-FileHash <file> -Algorithm SHA256
```

## GitHub Artifact Attestations (Sigstore / SLSA)

All official release artifacts are signed via GitHub's Artifact Attestation infrastructure:

```bash
gh attestation verify <file> --owner matryt
```
