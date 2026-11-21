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

Use Node 24 LTS (selected by `.nvmrc`) for development and builds. Node 22.12
or newer is supported; CI covers Node 22 and 24. Rust 1.90 or newer is required.
CI runs the full Rust suite on stable and a compile check on Rust 1.90.

On macOS and Linux, the Rust suite includes a real filesystem-watcher test for
external saves and atomic file replacements, with a bounded wait for events.

Use the full `cargo test --locked` command: `--lib` skips the native opener
permission guard in `src-tauri/tests/`.

## Words in the Interface

Use everyday words, and one name for each thing. Code can keep its internal
names (`useWorkspaceIndex`, `annotations.json`, the `workspace:root` setting);
text people see follows this list.

| Say | Not |
|---|---|
| sidebar (with Recent, Drafts, Folders) | workspace |
| Search documents | quick switcher, index |
| folder | root, workspace folder |
| Contents | table of contents |
| Reader settings | Reader Settings |
| Recent | Recent files |
| Highlights & notes (the panel); highlights and notes (in a sentence) | annotations |
| Show / Hide | Toggle |
| changed outside Bindars | changed on disk, modified |
| Don't save | Discard |
| Use other version / Keep my changes (document conflict choices) | Reload / Overwrite |

Dialog titles ask the question or say what happened ("Save changes to
“Notes.md”?"). Buttons say what will happen ("Keep my changes", not "OK").

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
npm run updates:test
npm audit --omit=dev --audit-level=moderate
node scripts/audit-dev-dependencies.mjs
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

A `v*` tag rebuilds, runs the same verification, and drafts a GitHub release
with the tested Debian package and its checksums. A manually dispatched
candidate and a later tag build are separate artifacts. Review the tag build's
results before publishing. Attach the verified Mac DMG, signed update archive,
signature, manifest, and Mac checksums to the draft, then publish it once all
the files are present. Leave pre-release drafts marked as pre-releases.

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
node scripts/audit-dev-dependencies.mjs
```

Commit `THIRD-PARTY-NOTICES` and `third-party-software.json` with the lockfile
changes. This also applies to Dependabot PRs that update runtime packages.
Review Rust audit warnings and `.cargo/audit.toml` against the resolved graph;
a passing audit can still contain unsoundness or maintenance warnings.
Build and test dependencies are audited by `scripts/audit-dev-dependencies.mjs`,
which lists each accepted advisory with its reason and fails on any other, and
on an accepted one that is no longer reported. Shipped npm dependencies have no
exceptions.

## License

Contributions are licensed under [MIT](LICENSE), the same license as the project.
