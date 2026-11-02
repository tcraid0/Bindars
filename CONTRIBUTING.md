# Contributing to Bindars

## Reporting Bugs

Open an issue on [GitHub Issues](../../issues) with steps to reproduce.

**Security vulnerabilities** should not be reported as public issues. See [SECURITY.md](SECURITY.md) for reporting instructions.

## Development Setup

```bash
npm install
npx tsc --noEmit                           # TypeScript type check
cd src-tauri && cargo test --locked        # Rust unit and integration tests
cd .. && npm run test:workspace            # Workspace integration tests
```

Node >= 20.19.0 and Rust >= 1.90 on the stable toolchain are required.

Use the full `cargo test --locked` command: `--lib` skips the native opener
permission guard in `src-tauri/tests/`.

## Release Verification

For a Developer ID Mac candidate, follow
[macOS release verification](docs/macos-release-verification.md). It separates
unsigned CI validation from signed-app checks and records the native and
downloaded-artifact checks required before publication.

Normal development does not exercise Tauri's packaged-asset CSP
transformation (nonce injection into the bundled HTML), so production-only
nonce interactions are invisible until an app is packaged. Before a release,
verify the packaged CSP against the built frontend in real WebKitGTK:

```bash
npm run build
python3 scripts/verify-webkit-csp-styles.py   # needs webkit2gtk-4.1 + python-gobject
```

The script fails if runtime-injected stylesheets (CodeMirror themes, Mermaid)
would be blocked in the packaged app. `tests/csp-style-policy.test.cjs` guards
the underlying configuration invariant in CI.

The workspace tests run the parsers in Node's V8, but the app runs them in
JavaScriptCore, where some regular expressions and large-array operations cost
far more. After changing Fountain or Markdown parsing, a parser dependency, or
a file in `patches/`, run the hostile screenplay and large Markdown cases in
the JavaScriptCore shell. The macOS CI job runs them too. macOS includes the
shell; elsewhere, set `JSC` to the path of a `jsc` binary:

```bash
npm run verify:jsc
```

Before creating a release candidate, run:

```bash
node --test tests/version-consistency.test.cjs
npm run licenses:test
npm run licenses:check
npm audit --omit=dev --audit-level=moderate
npm audit --include=dev --audit-level=moderate
cd src-tauri && cargo audit --file Cargo.lock
```

Run the GitHub `Release` workflow manually from `main` to produce an unreleased
workflow artifact. Artifacts in this public repository are downloadable by
signed-in users with repository read access; they are not private storage.
Keep confidential candidates in access-restricted storage instead.
The workflow builds one `.deb`, checks its metadata and
contents, verifies the bundled notices, installs it on Ubuntu 22.04, and runs a
headless launch test. Review the uploaded control file, file manifest, linked
libraries, checksum, and smoke-test log before creating a version tag.

A `v*` tag rebuilds, runs the same verification, and publishes that exact tested
Debian package only after every check passes. A manually dispatched candidate
and a later tag build are separate artifacts; manually checking the candidate
does not validate the exact bytes published by the tag run. The current workflow
has no manual approval step between testing the tag artifact and publishing it.

Finalize `.github/release-body.md` and synchronize the package, lockfile, Cargo,
and Tauri versions before creating the tag: release notes come from the tagged
commit. Never describe a manual native check as complete unless its results have
been recorded. AppImage and Arch package publication remain paused.

## Pull Requests

Before submitting a PR, these checks must pass:

1. `npx tsc --noEmit`
2. `npm run build`
3. `cd src-tauri && cargo test --locked`
4. From the repository root, `npm run test:workspace`
5. `npm run licenses:check` when a dependency, lockfile, license override, or
   release workflow changes

CI runs these automatically on every PR to `main`.

Keep changes focused. One fix or feature per PR. Include a clear description of what changed and why.

## Dependency updates

Keep the JavaScript and Rust Tauri plugins compatible, and retain the parser
patches in `patches/` until their JavaScriptCore regressions pass without them.
After updating either lockfile, regenerate the committed license inventory:

```bash
cd src-tauri && cargo fetch --locked
cd .. && npm run licenses:generate
npm run licenses:test
npm run licenses:check
npm audit --include=dev --audit-level=moderate
```

Commit `THIRD-PARTY-NOTICES` and `third-party-software.json` with the lockfile
changes. This also applies to Dependabot PRs that update runtime packages.
Review Rust audit warnings and `.cargo/audit.toml` against the resolved graph;
a passing audit can still contain unsoundness or maintenance warnings.

## License

Contributions are licensed under [MIT](LICENSE), the same license as the project.
