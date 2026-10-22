# macOS release verification

Use this procedure for a Developer ID release distributed from the website.
Record results for the exact candidate; this document is not evidence that a
candidate has passed. The current baseline is an Apple Silicon (`arm64`) app
requiring macOS 15.0 or newer. An Intel or universal candidate needs separate
architecture validation and runtime coverage.

Keep certificate backups, credentials, account details, and private release
evidence outside the repository. Use an existing Keychain profile for
notarization checks; never put passwords or private keys in commands or logs.
Signing, submission, stapling, and publication are separate release operations.
The commands below inspect artifacts and write verification logs; they do not
perform those operations.

## 1. Freeze the source and record the candidate

Use an isolated checkout or source archive of the selected commit. Record the
commit, any deliberate source differences, Node/npm/Rust/Xcode versions, target,
effective Tauri configuration, and exact build command. Install with `npm ci`
and use `--locked` for Cargo. Run the applicable checks in
[CONTRIBUTING.md](../CONTRIBUTING.md#release-verification); retain their logs.
Do not carry results from one source revision onto a changed candidate without
checking which validation needs refreshing.

Record these expected values from the frozen source:

| Item | Source of expectation |
| --- | --- |
| Identifier, version, minimum macOS | `src-tauri/tauri.conf.json` |
| Architecture | Explicit candidate target; currently `arm64` |
| Main executable, icon, associations, resources | Unsigned bundle inventory and Tauri configuration |
| Developer ID team | Independently confirmed release identity, kept in private evidence |
| Hardened Runtime | Enabled; also inspect the resulting signature |
| Entitlements | Explicitly reviewed list; start with none, add only demonstrated requirements |

Tauri supports a local Keychain identity through `APPLE_SIGNING_IDENTITY` or
`bundle.macOS.signingIdentity`. Keep machine-specific identity configuration
outside the shared unsigned CI configuration. Tauri can also submit for
notarization when authentication inputs are present, so the build environment
must match the release stage being performed. See the
[Tauri macOS signing documentation](https://v2.tauri.app/distribute/sign/macos/).

## 2. Preserve the unsigned CI check

For the unsigned build, use an environment without signing/notarization inputs:

```sh
npx tauri build --bundles app --no-sign --ci -- --locked
npm run validate:macos-app
```

The validator checks plist metadata, the `arm64` executable and deployment
target, file associations, icon/license/notice bytes, and executable inventory.
It intentionally rejects a Developer ID signature and signing configuration.
Do not disable those checks or run this validator as the acceptance test for a
signed app. Passing an unsigned sibling does not prove a separately built
signed candidate has matching contents.

macOS CI also mounts a disposable exFAT image and runs the otherwise ignored
native test that checks refused overwrites and successful creation of a new
file. This exercises unsupported-volume behavior without using user documents.
It does not replace testing the packaged editor's Save As flow.

## 3. Inspect the signed app before notarization

Set the paths to the actual signed candidate and a **new** evidence directory.
Run each block in the same Bash session. Stop on a command failure or a mismatch
with the recorded expectations; read the logs, not just the exit codes.

```sh
set -euo pipefail
bindars_app="/absolute/path/to/Bindars.app"
bindars_evidence="/absolute/path/to/new-candidate-evidence"
test -d "$bindars_app/Contents"
mkdir "$bindars_evidence"

/usr/bin/codesign --verify --deep --strict --verbose=4 "$bindars_app" \
  > "$bindars_evidence/signature-verification.log" 2>&1
/usr/bin/codesign --display --verbose=4 "$bindars_app" \
  > "$bindars_evidence/signature-details.log" 2>&1
/usr/bin/codesign --display --entitlements - "$bindars_app" \
  > "$bindars_evidence/entitlements.plist" \
  2> "$bindars_evidence/entitlements.log"
/usr/bin/plutil -convert json -o "$bindars_evidence/Info.json" \
  "$bindars_app/Contents/Info.plist"

bindars_executable=$(/usr/bin/plutil -extract CFBundleExecutable raw -o - \
  "$bindars_app/Contents/Info.plist")
/usr/bin/lipo -archs "$bindars_app/Contents/MacOS/$bindars_executable" \
  > "$bindars_evidence/architectures.txt"
/usr/bin/xcrun vtool -show-build "$bindars_app/Contents/MacOS/$bindars_executable" \
  > "$bindars_evidence/macho-build.txt"
```

Accept only when all of these checks agree:

- Signature verification succeeds. The signing authority is **Developer ID
  Application**, the team matches the independently recorded team, and the
  identifier matches the frozen configuration. An ad hoc or Apple Development
  signature is not a release signature.
- Signature details contain the Hardened Runtime flag and a secure timestamp.
  Inspect the signature itself rather than relying on Tauri's default setting.
- Entitlements match the reviewed list. `com.apple.security.get-task-allow`
  must be absent or false. Empty entitlement output is acceptable if none were
  intended. Do not add JIT, unsigned-memory, library-validation, or sandbox
  exceptions merely to bypass a failure; investigate the failing operation.
- The plist version, identifier, document types, icon, and minimum OS match the
  candidate record. The executable architecture and Mach-O `minos` agree too.
- Inventory **all files** in the signed bundle and compare them to the intended
  package. Recheck icon, license, and notices against the frozen source; inspect
  any added files. A signature seals contents but does not prove they belong in
  this release. If there are nested executables/frameworks/helpers, inspect
  their signatures, identities, runtime flags, and entitlements individually;
  the current expected app has only its main Mach-O executable.

`--deep` above is for verification, not a signing recipe. See Apple's
[distribution-signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac).

## 4. Check notarization and the final container

After a separately performed submission, record its UUID and the SHA-256 of
the submitted artifact. Set the existing Keychain profile name and submission
UUID in the same session; these calls retrieve status and logs only:

```sh
bindars_notary_profile="existing-keychain-profile"
bindars_submission="submission-uuid"
/usr/bin/xcrun notarytool info "$bindars_submission" \
  --keychain-profile "$bindars_notary_profile" --output-format json \
  > "$bindars_evidence/notarization-info.json"
/usr/bin/xcrun notarytool log "$bindars_submission" \
  "$bindars_evidence/notarization-log.json" \
  --keychain-profile "$bindars_notary_profile"
```

Require `Accepted`, verify the submission/log belongs to the recorded artifact,
and inspect every warning or issue. A successful upload or a pending response
is not acceptance. See Apple's
[notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

After the app ticket has been stapled, verify the **final packaged app**, not a
different copy left in the build directory:

```sh
/usr/bin/xcrun stapler validate "$bindars_app" \
  > "$bindars_evidence/app-ticket.log" 2>&1
/usr/bin/codesign --verify --deep --strict --verbose=4 "$bindars_app" \
  > "$bindars_evidence/final-app-signature.log" 2>&1
/usr/bin/syspolicy_check distribution "$bindars_app" \
  > "$bindars_evidence/distribution-check.log" 2>&1
/usr/sbin/spctl --assess --type execute --verbose=4 "$bindars_app" \
  > "$bindars_evidence/app-assessment.log" 2>&1
```

Require successful ticket/signature/distribution checks and a Gatekeeper
assessment identifying notarized Developer ID code. These commands are not a
substitute for launching a quarantined download on another clean environment.

For a signed, notarized, stapled DMG, also inspect the actual distribution file:

```sh
bindars_dmg="/absolute/path/to/final-Bindars.dmg"
/usr/bin/hdiutil verify "$bindars_dmg" \
  > "$bindars_evidence/dmg-integrity.log" 2>&1
/usr/bin/codesign --verify --strict --verbose=4 "$bindars_dmg" \
  > "$bindars_evidence/dmg-signature-verification.log" 2>&1
/usr/bin/codesign --display --verbose=4 "$bindars_dmg" \
  > "$bindars_evidence/dmg-signature-details.log" 2>&1
/usr/bin/xcrun stapler validate "$bindars_dmg" \
  > "$bindars_evidence/dmg-ticket.log" 2>&1
/usr/sbin/spctl --assess --type open --context context:primary-signature \
  --verbose=4 "$bindars_dmg" > "$bindars_evidence/dmg-assessment.log" 2>&1
/usr/bin/shasum -a 256 "$bindars_dmg" > "$bindars_evidence/final-download.sha256"
```

Require the intended Developer ID team on the DMG as well. Mount it read-only
and inspect the contained app using the app checks above. Staple the app before
placing it in the final container; do not modify the app inside a finished DMG.
A ZIP cannot itself be stapled: it must carry the already-stapled app and needs
its own final checksum and extracted-app verification. Stapling can change an
artifact's hash; retain both submission and final-download hashes. Rebuilding,
resigning, or changing packaged content invalidates the previous artifact's
acceptance record and requires renewed verification as applicable.

## 5. Test the packaged application

Use disposable documents and a fresh test account or machine. Record OS version,
architecture, candidate hash, steps, and actual outcomes. Test both macOS 15 and
a current supported macOS; do not label an unavailable environment as passed.

| Area | Required checks |
| --- | --- |
| Install and launch | Browser-download the exact artifact, retain quarantine, install, and launch normally. Test offline launch after ticket validation. Do not remove quarantine or use an Open Anyway override to establish success. |
| Save and departure | Dirty save, conflict Reload/Overwrite/Cancel, delayed and failed writes, later edits, recovery messages, normal Quit, and Dock Quit. Confirm preserved bytes and buffers, not just dismissed dialogs. |
| Native lifecycle | Quit with the window hidden, reopen from the Dock, Finder open/double-click and Dock file drop. Test logout/shutdown with disposable work; the cancel-first quit guard can require repeating the OS request. |
| Existing data and permissions | Upgrade from the supported earlier app using its production identity; verify synthetic documents, notes, preferences, session/recovery data, Drafts creation, and Documents/Desktop/Downloads permission grant and denial. |
| Rendering and input | Packaged CSP, local fonts, ordinary math and default Mermaid diagrams, Find navigation/cleanup, dark selects, spellcheck, native printing, cancellation, and PDF output. |
| Known limits | Check that unsupported-swap volumes refuse overwrites and offer Save As; keep large-document limitations visible. A limited smoke test does not establish simultaneous-writer safety or unlimited document-size support. |

## 6. Record the release decision

Keep a private candidate record with source identity, build/configuration,
signature/entitlements inventory, submission UUID/result/log, ticket checks,
final download checksum, and the native test matrix. Mark each entry passed,
failed, or not run, with its evidence path. Investigate failures in core
preservation, signature, or download behavior before publication. If a required
environment or scenario is unavailable, the release owner may explicitly accept
that coverage limitation. Record the decision and disclose relevant compatibility
and upgrade limitations in the release notes; never turn an unrun check into a
pass or claim full validation of that environment.

Publish only the artifact represented by that record. Installation instructions
must state the tested architecture/minimum OS and the manual update process;
Bindars currently has no automatic updater. An accepted notarization submission
does not replace application testing or responsibility for untrusted documents.
