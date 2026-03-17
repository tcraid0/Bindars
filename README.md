# Bindars

The reading app for markdown. Drop a file in, read it well.

Bindars is a local-first desktop app for reading `.md`, `.markdown`, and `.fountain` files. It renders GitHub Flavored Markdown with Mermaid diagrams, LaTeX math, syntax-highlighted code, footnotes, and frontmatter. No cloud, no account, no network requests - your files stay on your machine.

Built with Tauri v2, React 19, TypeScript, and Tailwind CSS v4. Available on Linux, macOS, and Windows.

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
- Basic editing with Ctrl+E, file watching for external changes
- Print and HTML export
- Keyboard-driven workflow - press `?` for the full shortcut list

## Install

### Debian / Ubuntu

Download the `.deb` from the [latest release](https://github.com/tcraid0/bindars/releases/latest) and install:

```bash
sudo dpkg -i Bindars_*_amd64.deb
```

### Arch Linux

Option 1 — build and install the package:

```bash
git clone https://github.com/tcraid0/bindars.git
cd bindars/packaging/arch
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

### AppImage (any distro)

Download the `.AppImage` from the [latest release](https://github.com/tcraid0/bindars/releases/latest), make it executable, and run:

```bash
chmod +x Bindars_*_amd64.AppImage
./Bindars_*_amd64.AppImage
```

If it fails with a FUSE error, install FUSE 2 for your distro (e.g. `sudo apt install libfuse2` on Debian/Ubuntu, `sudo pacman -S fuse2` on Arch).

### macOS

Download the `.dmg` for your architecture from the [latest release](https://github.com/tcraid0/bindars/releases/latest):

- **Apple Silicon** (M1/M2/M3/M4): `Bindars_*_aarch64.dmg`
- **Intel**: `Bindars_*_x64.dmg`

Open the DMG and drag Bindars to Applications. On first launch you may see an "unidentified developer" warning — right-click the app and select Open to bypass it.

### Windows

Download the `.exe` installer from the [latest release](https://github.com/tcraid0/bindars/releases/latest) and run it. SmartScreen may show a warning — click "More info" then "Run anyway".

## Build from source

Requires Node 20+ and Rust.

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
