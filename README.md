# Bindars

The reading app for markdown. Drop a file in, read it well.

Bindars is a local-first desktop app for reading `.md`, `.markdown`, and `.fountain` files. It renders GitHub Flavored Markdown with Mermaid diagrams, LaTeX math, syntax-highlighted code, footnotes, and frontmatter. No cloud, no account, no network requests - your files stay on your machine.

Built with Tauri v2, React 19, TypeScript, and Tailwind CSS v4. Linux is
the currently supported release platform. Windows and macOS builds are on
hold until they receive native testing and code signing.

## What it does

- GFM tables, task lists, footnotes, and smart typography
- Mermaid diagrams and KaTeX math rendering
- Syntax-highlighted code blocks (highlight.js)
- Four themes: light, sepia, dark, midnight
- Table of contents with scroll tracking
- Highlights and bookmarks with text anchoring
- Workspace search across all your markdown files (Ctrl+K)
- Fountain screenplay rendering with character focus and scene navigation
- Focus mode and presentation mode
- Position-continuous CodeMirror editing with undo history and find/replace
- New documents with Ctrl+N, guarded Save/Save As, and external-change reconciliation
- Optional Markdown heading formatting with an instant plain-markup fallback
- Print and HTML export
- Keyboard-driven workflow - press `?` for the full shortcut list

## Install

### Linux support

Bindars is currently released for x86_64 Linux. This release is manually
tested on Omarchy (Arch-based Linux) and built in CI on Ubuntu 22.04.
Ubuntu, Linux Mint, and Debian 12 or newer are expected to work, but have
not been manually verified for this release.

### Debian / Ubuntu / Linux Mint

Download the `.deb` from the [latest release](https://github.com/tcraid0/Bindars/releases/latest) and install:

```bash
sudo apt install ./Bindars_*_amd64.deb
```

### Arch Linux

Option 1 — build and install the package:

```bash
git clone https://github.com/tcraid0/Bindars.git
cd Bindars/packaging/arch
makepkg -si
```

Option 2 — run the AppImage directly:

```bash
chmod +x Bindars_*_amd64.AppImage
./Bindars_*_amd64.AppImage
```

If the AppImage fails with a FUSE error, install `fuse2`:

```bash
sudo pacman -S fuse2
```

Or bypass FUSE entirely:

```bash
./Bindars_*_amd64.AppImage --appimage-extract-and-run
```

### AppImage (most modern x86_64 distributions)

Download the `.AppImage` from the [latest release](https://github.com/tcraid0/Bindars/releases/latest), make it executable, and run:

```bash
chmod +x Bindars_*_amd64.AppImage
./Bindars_*_amd64.AppImage
```

If it fails with a FUSE error, install FUSE 2 for your distro (e.g. `sudo apt install libfuse2` on Debian/Ubuntu, `sudo pacman -S fuse2` on Arch).

Windows and macOS release builds are planned after native testing and
code signing are in place. They are not included as stable downloads yet.

## Build from source

Requires Node 20.19 or newer and Rust 1.88 or newer on the stable toolchain.

```bash
npm install
npm run tauri -- build
```

Artifacts land in `src-tauri/target/release/bundle/` — `.deb` and `.AppImage` on Linux, `.dmg` on macOS, `.exe` on Windows.

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
