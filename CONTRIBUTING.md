# Contributing to Binder

## Reporting Bugs

Open an issue on [GitHub Issues](../../issues) with steps to reproduce.

**Security vulnerabilities** should not be reported as public issues. See [SECURITY.md](SECURITY.md) for reporting instructions.

## Development Setup

```bash
npm install
npx tsc --noEmit                           # TypeScript type check
cd src-tauri && cargo test --lib           # Rust unit tests
npm run test:workspace                     # Workspace integration tests
```

Node >= 20.19.0 and Rust stable are required.

## Pull Requests

Before submitting a PR, all three checks must pass:

1. `npx tsc --noEmit`
2. `cd src-tauri && cargo test --lib`
3. `npm run test:workspace`

CI runs these automatically on every PR to `main`.

Keep changes focused. One fix or feature per PR. Include a clear description of what changed and why.

## License

Contributions are licensed under [MIT](LICENSE), the same license as the project.
