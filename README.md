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
  (Shift+Cmd+M on macOS or Ctrl+Shift+M on Linux toggles Notes)
- Recent, Drafts, and an optional folder browser, with Search documents and passage navigation
- Persistent whole-interface zoom, separate from reading typography
- Fountain screenplay rendering with character focus and scene navigation
- Focus mode and presentation mode
- Visible Read/Edit controls that keep your reading position, with undo history and find/replace while editing
- Show the opened file in Finder (macOS) or its folder from either Read or Edit mode
- Autosave within 10 seconds, and new documents saved as ordinary files in a Bindars Drafts folder ([how saving works](docs/recovery-and-privacy.md)), with guarded Save/Save As and external-change reconciliation
- Optional Markdown heading formatting with an instant plain-markup fallback
- macOS spelling underlines and native right-click suggestions while editing
- Print the document or save it as PDF; export highlights and notes separately as Markdown
- Keyboard-driven workflow - choose **Help > Keyboard Shortcuts** on macOS or
  press Ctrl+? on Linux for the full shortcut list

See [highlights, notes, and recovery](docs/annotations.md) for location, saving,
and document-path limitations. You can also paste plain text into a new document.
Bindars opens `.md`, `.markdown`, and `.fountain` files; it does not import Word
or PDF documents.

On the empty screen, choose **Try an Example…** and save a copy to try highlighting
and notes. Select a passage and choose **Note**, or choose **Add note** on an
existing highlight. Reopen your saved copy from **Recent files**, **Open**, or
your file manager. Choosing **Try an Example…** again asks where to save a fresh copy;
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

### Finding documents

Bindars opens documents where they already are. **Recent** holds the last 25
opened documents from any location. Its rows keep their order while you use the
sidebar, returning to most-recent-first when you hide and show it or relaunch.
Resizing the window does not reshuffle it.
New documents enter at the top, and each row shows its location and last-opened
time on one quiet line. **Back** returns to documents opened from Recent.

The sidebar starts hidden and remembers your choice. A one-time note offers
**Show Sidebar** when you open a second distinct document; if the reading hint
is showing, it waits for a later document open. Use the toolbar button or
Cmd+B / Ctrl+B to toggle it;
on macOS, **View › Show Sidebar / Hide Sidebar** is also available.

**Drafts** lists existing files in Documents › Bindars Drafts, including drafts
no longer in Recent, using a heading or opening text alongside the filename.
New documents are saved here until you save them somewhere else. The header
and folder browser keep filenames.

On macOS, Drafts isn't listed at first, so a first launch doesn't ask for access
to your Documents folder. Choose **Show existing drafts** to list it; once
Bindars has saved a draft or found existing ones, later launches list Drafts
automatically.

In **Folders**, choose **Add Folder…** to browse one folder's supported files and
subfolders. Nothing is moved or copied. The picker starts in the folder of the
document you are reading. Opening another file does not add or scan its parent
folder, and saving a document keeps its place in the folder list. Browsing does
not change where new documents autosave. **Remove from Sidebar** removes only
this folder reference; the inline **Add Back** action restores it. Neither action
moves or deletes documents or notes.

**Search documents** (Cmd+K / Ctrl+K) searches Recent, Drafts, and the added folder.
Its Scope menu can narrow results to that folder. Unquoted words may occur in
any order; double quotes request a phrase within a text block. Results group by
document, with separate passage counts. Filename/title matches rank first, then
exact phrases, nearby terms, and scattered terms. Up to 50 documents and five
passages per document are shown, with totals when results are truncated.

Choose a passage to open it and highlight the requested occurrence, including
in the document already open. Repeated passages keep their occurrence. A changed
or unresolved passage produces an explanation and refreshes search. **Find in
Document** (Cmd+F / Ctrl+F) finds a phrase in the displayed document; only valid
phrase results populate it. Unordered-term results highlight their passage
without putting search operators into Find.

Use Cmd+G / Ctrl+G for the next Find match and Shift+Cmd+G / Ctrl+Shift+G
for the previous match.

Both searches ignore case, ordinary prose whitespace, and soft line breaks.
They equate straight/curly quotes, `--`/en dash, `---`/em dash, and `...`/ellipsis.
Other punctuation stays literal. Find includes displayed code and rendered
math, retaining their literal punctuation and whitespace. Document Search excludes code, math,
diagrams and images, and covers the first 30,000 extracted body characters plus
headings and names. These forgiving search rules do not change annotation
identity or location rules.

Files appear before text preparation finishes and remain findable by filename
when reading or parsing fails. Status and recovery actions distinguish missing,
unreadable, invalid-encoding, oversized and overly complex documents. There is
no promise that every discovered file can be displayed. The folder browser skips
hidden folders, `node_modules`, `target`, `vendor`, and symbolic links. Discovery
is bounded to 5,000 documents per folder/Drafts source, 100,000 visited entries,
20,000 subfolders and 32 levels; a partial-list notice identifies these limits.
Lists initially render 100 entries and provide buttons for more.

Successful saves update Search immediately. Returning to the app reconciles
external changes; unchanged file size and modification time avoid reparsing.
Discovery and text work publish incrementally and discard obsolete results when
the configured folder changes. Continuous folder watching is not enabled.
Actual incoming links live in the collapsed **Linked from** section in Contents;
**Unlinked mentions** remains a separate collapsed section.

### Interface zoom

Use **View** or Cmd+plus/minus (Ctrl equivalents on Linux) to zoom the entire
interface from 75% to 300%. Cmd+0 / Ctrl+0 chooses **Actual Size** and changes only
interface zoom. Zoom is saved between launches. Reader Settings still provides
independent text size, fonts, spacing, Reduce effects, and its explicit Reset.

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
