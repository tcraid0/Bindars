> Draft: 1.6.3 release artifacts and candidate-specific platform validation are pending.

## Downloads

- **Mac (Apple Silicon):** `Bindars_1.6.3_aarch64.dmg` — pending validation of the
  signed, notarized, and stapled release candidate. Requires macOS 15.0 or newer;
  no Intel build. Once available, open the DMG, drag Bindars into Applications,
  and launch it normally. macOS may ask you to confirm the first opening of an
  internet download.
- **Linux (x86_64):** the `.deb` is pending release-workflow validation. Once
  available, install with `sudo apt install ./Bindars_*_amd64.deb`.

The release will include `SHA256SUMS-macos.txt` for the Mac DMG and `SHA256SUMS`
for the Debian package. Updates are manual; Bindars does not include an automatic
updater.

## Changes in 1.6.3

This update makes documents easier to recognize and return to, makes long notes
readable without editing them, and refreshes application dependencies. It
introduces no new document or annotation format.

### Finding and returning to documents

- Home, Recent, and Search consistently show a document's readable title when
  available, with its filename and location alongside it. Filenames appear
  immediately while titles are being prepared. Folders keeps filenames primary.
- Removing a document from Recent offers **Add Back**, shared with Home. It
  restores the record without moving or reopening the file and preserves its
  last-opened time and latest reading section, including progress made while
  the document was removed. The notice has no timer; it stays until you restore,
  dismiss, reopen that document, remove another entry, or end the session.
- **Folder options** groups folder selection, full locations, and removal in a
  compact header. Breadcrumbs let you return directly to an ancestor folder.
  Choosing a different document leaves the folder browser where you put it.
- Tabs, Search, and folder context stay visible while browsing long lists.
  Short windows and high interface zoom use a scrolling sidebar so every
  control remains reachable. Folder selection, cancellation, removal, and
  restoration preserve keyboard focus.

### Reading notes

- Long notes offer **Read more** and **Show less** beside their three-line
  preview. Several notes can be expanded independently. Expansion preserves
  line breaks and does not edit the note or move the reading position.
- **Find Notes…** is now **Reconnect notes…**, matching its purpose after a
  document has been renamed or moved. The existing preview and confirmation
  safeguards are unchanged.

### Dependencies and maintenance

The dependency refresh since 1.6.2 includes:

| Component | Previous | Updated |
| --- | --- | --- |
| React and React DOM | 19.2.4 | 19.3.1 |
| Tauri native runtime | 2.11.6 | 2.12.5 |
| Tauri JavaScript API | 2.11.1 | 2.12.4 |
| Tauri dialog plugin | 2.6.0 | 2.8.4 |
| Tauri opener plugin | 2.5.3 | 2.7.2 |
| Native file watcher (`notify`) | 7.0.0 | 8.2.1 |
| Tokio | 1.49.0 | 1.54.1 |
| Syntax highlighting (`highlight.js`) | 11.11.1 | 11.12.0 |
| Tailwind CSS | 4.1.18 | 4.3.3 |

- Updated the CodeMirror editor packages, Markdown tooling, bundled font
  packages, YAML support, Tauri build tools/plugins, and test dependencies.
  The existing JavaScriptCore performance patch is retained for micromark 4.0.3.
  Mermaid 11.17.2, KaTeX 0.18.4, and Vite 7.3.7 are unchanged from 1.6.2.
- Regenerated bundled license notices and removed obsolete license/audit
  exceptions. Outstanding Linux GTK and zbus dependency warnings remain
  documented in the repository's audit policy.
- Updated the Linux `async-executor` dependency to 1.14.1, replacing the withdrawn
  1.14.0 release and its executor-shutdown memory-safety regression.
- Added a real macOS/Linux filesystem-watcher regression test for external
  saves and atomic replacements, including checks that unrelated files do not
  produce document-change notifications.
- Release checks now audit development dependencies as well as production
  dependencies. Removed obsolete AppImage helper scripts; AppImage distribution
  remains paused.
- For source builds, Node 24 is the default, Node 22.12 or newer is supported,
  and Rust 1.90 or newer is required. CI covers Node 22/24 and checks the minimum
  Rust version. Installed users do not need these development tools.

## Upgrading

On Mac, quit Bindars and replace the application in Applications with the copy
from the new DMG. Back up your documents and Bindars data first. Validation of
an upgrade from 1.6.2 to this candidate is pending.

Updating from 1.6.2 requires no new format migration. For people coming from
older versions: search data is kept in a separate cache that Bindars can
rebuild, and builds before 1.6.1 ignore Home as a saved last place.

Since 1.5.0, Bindars has used ordinary Drafts files instead of hidden recovery
snapshots. Older snapshots are neither read nor deleted by current builds.
Recent-file history changed in 1.4.4; earlier builds may not understand it and
some can replace it. Back up settings before downgrading if you need that history.
See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md)
for storage locations and details.

## Known limitations

- On macOS and Linux, existing files cannot be replaced on volumes without
  verified file-swap support, including exFAT/FAT32 and some network shares.
  Bindars keeps your text and offers Save As to a new name or another drive.
  Folder-change checks depend on filesystem identity and cannot reliably detect
  every replacement on some network shares.
- Mermaid diagrams explicitly enabling `forceLegacyMathML` can still show
  misplaced formulas in WebKit. Default math rendering is unaffected.
- Reading position restores a section rather than an exact pixel offset. Very
  last-moment scrolling or preference changes may not be recorded before quitting.
- Some printed headings can be separated from their following content, and table
  headers may not repeat on continuation pages. Very wide tables can wrap words
  within cells. Native Linux and Windows printing remain unverified. The Mac
  print sheet may request Local Network access for printer discovery; its
  behavior with access denied has not been verified.
- A heading such as `user-content-fn-1` can capture a footnote's internal link.
- A quote block followed by tens of thousands of unmarked continuation lines
  can still be slow to open.
- Renaming or moving a document outside Bindars does not move its annotations
  automatically. Use **Reconnect notes…** to reconnect them.
- A damaged annotation collection is preserved and can also prevent settings
  and recent files from loading. External repair may be needed; back up the
  original storage files first.
- A program writing through an already-open file handle may continue writing
  to an older file after Bindars replaces it. Replacement saves do not preserve
  owner/group, locked or hidden flags, or timestamps. Linux replacement saves
  still do not preserve filesystem ACLs or extended attributes.
- Interrupted saves or competing edits can leave temporary files or a
  **Bindars recovered …** copy beside the document. Bindars never deletes these
  leftovers automatically; see [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md)
  before removing them.

## Platform validation

**Pending for 1.6.3:** validation of the exact signed Mac application, final DMG,
download/install behavior, upgrade from 1.6.2, and Debian release artifact.
The native checks recorded for 1.6.2 do not establish that this candidate passed.

The UX changes have source-test and browser/macOS WKWebView coverage using
production components and synthetic documents/picker results. These checks do
not replace testing the packaged app with the real native file picker.

Interactive coverage on macOS 15, fresh-account and first-use folder permissions,
and logout/shutdown remains unestablished for this candidate. Candidate results
and any accepted coverage limitations must be recorded before publication;
notarization alone does not establish application compatibility.

Linux distribution provides an x86_64 Debian package. The tag workflow builds,
inspects, installs, and launches its package on Ubuntu 22.04 before publishing
that exact artifact. A manually dispatched candidate is a separate build.
Debian 12 or newer and current Linux Mint releases are expected to work but do
not receive the same automated test.

AppImage and Arch distribution remain paused pending repeatable compliance
checks. Windows binaries remain unpublished while native release testing and
code signing are pending.
