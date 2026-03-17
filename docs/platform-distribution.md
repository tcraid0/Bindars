# Platform Distribution & Code Signing

Research and implementation notes for shipping Bindars on macOS and Windows.

## Current State

- **Linux:** AppImage + .deb, unsigned (standard for Linux)
- **Windows:** NSIS installer, unsigned (SmartScreen warns on download)
- **macOS:** DMG (ARM + Intel), unsigned

The codebase is already portable. Keyboard shortcuts use `ctrlKey || metaKey`, path handling covers Unix conventions, the Rust backend has no platform-specific logic, and the `.icns` icon already exists in `src-tauri/icons/`.

---

## macOS

### Adding Unsigned Builds

Tauri ignores irrelevant bundle targets per-platform, so adding `"dmg"` to `bundle.targets` in `tauri.conf.json` is safe — Linux and Windows builds are unaffected.

Tauri v2 removed the `universal-apple-darwin` target. ARM (Apple Silicon) and Intel must be built separately with `--target aarch64-apple-darwin` and `--target x86_64-apple-darwin`. The `tauri-apps/tauri-action` names the resulting DMGs with the architecture automatically.

GitHub Actions `macos-latest` runners are Apple Silicon (M-series) as of 2024. They can cross-compile to x86_64. Both Rust targets need to be installed via `rustup target add`.

**GitHub Actions cost:** macOS runners have a **10x minute multiplier**. Each release build takes roughly 15-20 min per architecture = 300-400 effective minutes. Free tier is 2,000 min/month (~5 releases/month before hitting limits). As of January 2026, GitHub reduced hosted runner prices by up to 39%.

Without signing, macOS users see a Gatekeeper "unidentified developer" warning. They can bypass it with right-click > Open. On macOS Sequoia and later this friction is higher.

### Code Signing + Notarization

**Cost:** $99/year for the Apple Developer Program. No additional certificate costs.

**Certificate type:** "Developer ID Application" (for distribution outside the App Store). Not "Mac App Distribution" or "Apple Distribution" — those are for the Mac App Store.

**How it works with Tauri v2:**
The `tauri-apps/tauri-action` handles the entire pipeline automatically when these environment variables are set:

| Environment Variable | Purpose |
|---------------------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate file |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 export |
| `APPLE_SIGNING_IDENTITY` | Certificate CN, e.g. `Developer ID Application: Name (TEAM_ID)` |
| `APPLE_ID` | Apple account email (for notarization) |
| `APPLE_PASSWORD` | App-specific password (generate at appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character team ID from Apple Developer account |

These are ignored on Linux and Windows runners, so they can be added unconditionally to the workflow.

The action handles: certificate import into a temporary keychain, `codesign` signing, `notarytool` submission to Apple, and stapling the notarization ticket to the DMG.

**Entitlements.plist:** A signed Tauri v2 app requires WebView JIT entitlements or the app will crash. Create `src-tauri/Entitlements.plist` with:
- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.allow-dyld-environment-variables`

Reference it in `tauri.conf.json` under `bundle.macOS.entitlements`.

**Verification commands (on a Mac):**
```bash
codesign -dv --verbose=4 /Applications/Bindars.app
spctl --assess -vvv /Applications/Bindars.app
```

### Homebrew Distribution

After signing is in place, a Homebrew cask is the standard macOS distribution channel for developer tools. Requires a `homebrew-bindars` repo with a `Casks/bindars.rb` formula pointing to the signed DMG on GitHub Releases. SHA256 must be updated per release (can be automated in CI). Unsigned casks generate extra Homebrew warnings, so this should wait for signing.

---

## Windows

### Current Situation

The NSIS installer works but is unsigned. Users see a "Windows protected your PC" SmartScreen dialog on first download. This is a 2-click bypass (More info > Run anyway) and is tolerable for early adopters.

### Code Signing

**Cost:** ~$300-550/year total (certificate + HSM).

**Certificate types:**
- **OV (Organization Validated):** ~$216-226/year. Cheaper, available to individuals, but SmartScreen still shows warnings initially. Reputation builds over time based on download volume.
- **EV (Extended Validation):** ~$297-399/year. More expensive, but gets **immediate** SmartScreen trust with no reputation-building period.

**Important change (June 2023):** Certificate authorities no longer issue code signing certificates as exportable files. All new certificates must be stored on hardware security modules (HSMs). This means either:
- A **physical USB token** (~$90-130 one-time, not CI-friendly)
- A **cloud HSM** like Azure Key Vault (~$5-15/month) using `relic` or `AzureSignTool` for CI integration

**Additional regulatory change (Feb 2026):** Maximum certificate lifespan reduced to 1 year (459 days).

**Certificate authorities:** DigiCert, Sectigo, Certera, SSL.com.

**Tauri v2 integration:** Use the `bundle.windows.signCommand` config key to invoke a signing tool. Example with Azure Key Vault:
```json
{
  "bundle": {
    "windows": {
      "signCommand": "relic sign --file %1 --key azure --config relic.conf"
    }
  }
}
```

Azure Key Vault CI setup requires: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, and the certificate name in Key Vault. Role assignments needed: "Key Vault Certificate User" and "Key Vault Crypto User".

### Recommendation

Defer Windows signing until Bindars has meaningful download volume. The cost ($300-550/year) and complexity (cloud HSM, Azure subscription, CI integration) are disproportionate at the PMF exploration stage. SmartScreen's 2-click bypass is tolerable for early users. If download volume grows, an EV certificate is recommended over OV for immediate SmartScreen trust.

---

## Priority Order

1. **macOS unsigned builds** — $0, unlocks the macOS market
2. **macOS signing + notarization** — $99/year, when Mac users ask for it or before any launch push
3. **Windows signing** — ~$400-550/year, when download volume justifies the cost

---

## References

- [Tauri v2 macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri v2 Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri v2 GitHub Actions Pipeline](https://v2.tauri.app/distribute/pipelines/github/)
- [Shipping a Tauri 2.0 macOS App — code signing, notarization, Homebrew](https://dev.to/0xmassi/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrew-mc3)
- [Ship Your Tauri v2 App Like a Pro — signing for macOS and Windows](https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-code-signing-for-macos-and-windows-part-12-3o9n)
- [GitHub Actions Runner Pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- [GitHub Actions 2026 Pricing Changes](https://resources.github.com/actions/2026-pricing-changes-for-github-actions/)
- [Windows EV Signing a Tauri App (Defguard blog)](https://defguard.net/blog/windows-codesign-certum-hsm/)
