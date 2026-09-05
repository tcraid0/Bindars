# Bindars

The reading app for markdown. Drop a file in, read it well.

Bindars is a local-first desktop app for reading `.md`, `.markdown`, and `.fountain` files. It renders GitHub Flavored Markdown with Mermaid diagrams, LaTeX math, syntax-highlighted code, footnotes, and frontmatter. No cloud, no account, no network requests - your files stay on your machine.

Built with Tauri v2, React 19, TypeScript, and Tailwind CSS v4. Linux is
the currently supported release platform. Windows and macOS builds are on
hold until they receive native testing and code signing.

## What it does

- GFM tables, task lists, footnotes, and smart typography
- Mermaid diagrams and KaTeX math rendering (`$$x^2$$` inline, `$$` blocks for display math; single `$` is reserved for plain text so dollar amounts in prose render as written)
- Syntax-highlighted code blocks (highlight.js)
- Four themes: light, sepia, dark, midnight
- Table of contents with scroll tracking
- Highlights and bookmarks with text anchoring
- Workspace search across all your markdown files through the command palette
- Fountain screenplay rendering with character focus and scene navigation
- Focus mode and presentation mode
- Position-continuous CodeMirror editing with undo history and find/replace
- New documents with guarded Save/Save As and external-change reconciliation
- Optional Markdown heading formatting with an instant plain-markup fallback
- Print and HTML export
- Keyboard-driven workflow - press `?` for the full shortcut list

## Install

### Linux support

Bindars currently publishes an x86_64 Debian package. Before publication, the
release workflow inspects the package, installs it, and launches it on Ubuntu
22.04. Debian 12 or newer and current Linux Mint releases are expected to work
but do not receive the same automated test.

### Debian / Ubuntu / Linux Mint

Download the `.deb` from the [latest release](https://github.com/tcraid0/Bindars/releases/latest) and install:

```bash
sudo apt install ./Bindars_*_amd64.deb
```

### Other Linux distributions

AppImage and Arch package distribution are paused while the project adds a
repeatable compliance check for bundled native libraries. Other Linux users
may build from source, but those builds are not official release artifacts.

Windows and macOS release builds are planned after native testing and
code signing are in place. They are not included as stable downloads yet.

## Build from source

Requires Node 20.19 or newer and Rust 1.88 or newer on the stable toolchain.

```bash
npm ci
npm run tauri -- build
```

Artifacts land in `src-tauri/target/release/bundle/`. Local Tauri builds may
create several platform-specific formats, but the official release workflow
publishes only the Debian package.

## Development

```bash
npm run tauri -- dev     # full app with hot reload
npm run dev              # frontend only (port 5173)
```

Run checks before committing:

```bash
npx tsc --noEmit                       # frontend types
cd src-tauri && cargo test --lib       # rust tests
cd .. && npm run test:workspace        # integration tests
```

## License

MIT
