# Binder

The reading app for markdown. Drop a file in, read it well.

Binder is a local-first desktop app for reading `.md`, `.markdown`, and `.fountain` files. It renders GitHub Flavored Markdown with Mermaid diagrams, LaTeX math, syntax-highlighted code, footnotes, and frontmatter. No cloud, no account, no network requests - your files stay on your machine.

Built with Tauri v2, React 19, TypeScript, and Tailwind CSS v4. Linux target (AppImage + .deb).

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

## Build from source

Requires Node 20+ and Rust.

```bash
npm install
npm run tauri -- build
```

Artifacts land in `src-tauri/target/release/bundle/`. Install the `.deb` or run the AppImage directly.

If the AppImage fails with a FUSE error:

```bash
sudo apt install libfuse2
```

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
