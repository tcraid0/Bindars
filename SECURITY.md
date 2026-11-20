# Security Policy

## Threat Model

Bindars reads and renders Markdown files from the user's filesystem. Documents cannot cause network requests. The web view's CSP enforces `connect-src 'none'`.

The only network requests Bindars can make are the macOS update check and download. They run in native code, go only to this repository's GitHub releases, and happen only when the user asks for a check, has turned on automatic checks (off by default), or chooses to install an update. An update is installed only if it is newer and signed for the version it claims.

The primary trust boundary is **untrusted markdown content**: a malicious `.md` file should not be able to execute code, access files outside its directory, or crash the application.

Rendering policy that follows from this: raw HTML is removed before rendering (never inserted into the DOM); document-authored `href` and `src` values are limited to `http`, `https`, `mailto`, and relative paths; images load only from relative paths inside the document's folder. The native image protocol resolves symbolic links and reads through a directory-confined file handle, rejects non-image files, and limits each image to 20 MiB. The general asset protocol is disabled. Mermaid runs at `securityLevel: "strict"`, math inside diagram labels is checked against the same macro and input-size policy as document math before a diagram renders, and the webview may not navigate away from the app origin.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

Only the latest release receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.** Use the
**Report a vulnerability** button on the repository's
[Security tab](../../security/advisories/new) to submit a private GitHub
Security Advisory.

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

- Vulnerabilities triggered by opening or rendering a malicious document, including when an attacker persuades the user to open it
- Code execution via crafted markdown content
- File system access outside the opened file's directory
- Application crashes or freezes from crafted input (DoS)
- Bypass of the sanitize schema (XSS via markdown rendering)
- Path traversal in image loading or file operations
- A forged, unsigned, or downgraded update being accepted for installation

Apple notarization and OS protections do not replace Bindars' responsibility to handle untrusted documents safely.

### Out of scope

- Attacks requiring physical access to the machine
- Pure social engineering without a technical vulnerability in Bindars
- Vulnerabilities in upstream dependencies with no reachable code path in Bindars
- Visual rendering bugs or UI glitches
- Issues that require the user to modify application source code
