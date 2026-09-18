# Bindars

Read Markdown and Fountain files, highlight passages, and keep notes.

Bindars is a local-first desktop app for reading `.md`, `.markdown`, and `.fountain` files. It renders GitHub Flavored Markdown with Mermaid diagrams, LaTeX math, syntax-highlighted code, footnotes, and frontmatter. No cloud, no account, no network requests - your files stay on your machine.

Built with Tauri v2, React 19, TypeScript, and Tailwind CSS v4. Linux is
the currently supported release platform. macOS has an unsigned Apple Silicon
build and automated checks targeting macOS 15 or newer; signing, notarization,
and final release testing remain pending. Windows releases also remain pending
native testing and code signing.

## What it does

- GFM tables, task lists, footnotes, and smart typography
- Mermaid diagrams and KaTeX math rendering (`$$x^2$$` inline, `$$` blocks for display math; single `$` is reserved for plain text so dollar amounts in prose render as written)
- Syntax-highlighted code blocks (highlight.js)
- Four themes: light, sepia, dark, midnight
- Table of contents with scroll tracking
- Highlights & notes, plus bookmarks for returning to headings
- Workspace quick switcher for Markdown and Fountain files
- Fountain screenplay rendering with character focus and scene navigation
- Focus mode and presentation mode
- Visible Read/Edit controls that keep your reading position, with undo history and find/replace while editing
- Show the opened file in Finder (macOS) or its folder from either Read or Edit mode
- New documents with guarded Save/Save As and external-change reconciliation
- Optional Markdown heading formatting with an instant plain-markup fallback
- macOS spelling underlines and native right-click suggestions while editing
- Print the document or save it as PDF; export highlights and notes separately as Markdown
- Keyboard-driven workflow - press `?` for the full shortcut list

See [highlights, notes, and recovery](docs/annotations.md) for location, saving,
and document-path limitations. You can also paste plain text into a new document.
Bindars opens `.md`, `.markdown`, and `.fountain` files; it does not import Word
or PDF documents.

On the empty screen, choose **Try an example** and save a copy to try highlighting
and notes. Select a passage and choose **Note**, or choose **Add note** on an
existing highlight. Reopen your saved copy from **Recent files**, **Open**, or
your file manager. Choosing **Try an example** again asks where to save a fresh copy;
confirming replacement writes the example text over the file you choose.

### Spelling on macOS

In Edit mode, macOS can underline misspelled words and offer corrections when
you right-click them. Notes also retain native spelling assistance. Automatic
spelling correction is off in both fields; document search, the quick switcher,
and Edit-mode Find/Replace disable autocorrection and spelling underlines to keep
search and replacement text literal.
Checking follows native timing, so existing text may not be marked until you
edit it. These field controls apply only on macOS; Linux behavior is unchanged.

Quotes, dashes, text shortcuts, and URLs stay literal by default; saved native
Substitutions choices can override those defaults. See the
[validation notes](docs/macos-spellcheck-validation.md) for tested behavior
and remaining platform coverage.

### Workspace search

Choose a folder in the Workspace panel, then use Search or the quick switcher
shortcut to find filenames, document titles, headings, and body excerpts.
Choose **Refresh** after files change: editing, saving, adding, renaming, or
deleting a file does not automatically update the workspace snapshot.

Results appear when indexing finishes; the previous snapshot stays available
during a refresh. Search covers the first 30,000 characters of body text and
up to two matching headings per file. Markdown body excerpts omit code, math,
diagrams, and images. A heading result jumps to that heading; a content result
opens the document, where you can use in-document search to find the phrase.
This is a quick navigation tool, not an exhaustive full-document search.

### Rendering rules

- Raw HTML in Markdown is removed, not rendered: `<br>`, `<details>`, `<img>`,
  and similar tags disappear and only the Markdown around them is shown.
- Images must be relative paths inside the document's folder (or a subfolder).
  Remote images, `data:` URLs, and absolute paths are not loaded. A `../`
  segment is allowed only while the resolved path stays inside that folder.
  Image shortcuts (symbolic links) must also resolve inside that folder.
  Images larger than 20 MiB are not loaded, and images are served only for
  the document currently open in the reader.
- Links to other `.md`, `.markdown`, and `.fountain` files open in the reader,
  including `../` paths. `http(s)` and `mailto` links open in your system
  browser or mail client; other URL schemes are removed.

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

Windows and macOS are not included as stable downloads yet. The unsigned
macOS development build is not a distribution-signed release.

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
