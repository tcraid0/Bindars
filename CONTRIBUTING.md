# Contributing to Bindars

## Reporting Bugs

Open an issue on [GitHub Issues](../../issues) with steps to reproduce.

**Security vulnerabilities** should not be reported as public issues. See [SECURITY.md](SECURITY.md) for reporting instructions.

## Development Setup

```bash
npm install
npx tsc --noEmit                           # TypeScript type check
cd src-tauri && cargo test --lib           # Rust unit tests
cd .. && npm run test:workspace            # Workspace integration tests
```

Node >= 20.19.0 and Rust >= 1.88 on the stable toolchain are required.

## Release Verification

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

## Pull Requests

Before submitting a PR, all three checks must pass:

1. `npx tsc --noEmit`
2. `cd src-tauri && cargo test --lib`
3. From the repository root, `npm run test:workspace`

CI runs these automatically on every PR to `main`.

Keep changes focused. One fix or feature per PR. Include a clear description of what changed and why.

## License

Contributions are licensed under [MIT](LICENSE), the same license as the project.
