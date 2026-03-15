# Security Policy

## Threat Model

Bindars is a **local-only** desktop application. It reads and renders markdown files from the user's filesystem. There are zero outbound network requests — no `fetch`, `XMLHttpRequest`, `WebSocket`, or HTTP client usage anywhere in the codebase. CSP enforces `connect-src 'none'`.

The primary trust boundary is **untrusted markdown content**: a malicious `.md` file should not be able to execute code, access files outside its directory, or crash the application.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

Only the latest release receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, please report via one of:

- **GitHub Security Advisories**: Use the "Report a vulnerability" button on the [Security tab](../../security/advisories/new) of this repository (preferred).
- **Email**: Send details to the maintainer's email listed in the Git commit history.

Please include:
- Description of the vulnerability
- Steps to reproduce (a sample `.md` file is ideal)
- Impact assessment (what can an attacker achieve?)

### Response timeline

- **Acknowledgment**: within 72 hours
- **Assessment**: within 1 week
- **Fix or mitigation**: within 30 days for confirmed issues

## Scope

### In scope

- Code execution via crafted markdown content
- File system access outside the opened file's directory
- Application crashes or freezes from crafted input (DoS)
- Bypass of the sanitize schema (XSS via markdown rendering)
- Path traversal in image loading or file operations

### Out of scope

- Attacks requiring physical access to the machine
- Social engineering the user into opening a malicious file (that's the OS's job)
- Vulnerabilities in upstream dependencies with no reachable code path in Bindars
- Visual rendering bugs or UI glitches
- Issues that require the user to modify application source code
