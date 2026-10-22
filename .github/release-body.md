## Downloads

- **Mac (Apple Silicon):** `Bindars_1.6.2_aarch64.dmg` — signed with Developer ID,
  notarized by Apple, and stapled. Requires macOS 15.0 or newer; no Intel build.
  Open the DMG, drag Bindars into Applications, and launch it normally.
  macOS may ask you to confirm the first opening of an internet download.
- **Linux (x86_64):** download the `.deb` and install with
  `sudo apt install ./Bindars_*_amd64.deb`.

Use `SHA256SUMS-macos.txt` for the Mac DMG and `SHA256SUMS` for the Debian package.
Updates are manual; Bindars does not include an automatic updater.

## Changes in 1.6.2

This update improves save safety, Find responsiveness, math rendering, and
release verification. It introduces no new document or annotation format.

### Saving and quitting

- Conflict Reload, Cancel, and quit decisions wait for an in-flight overwrite.
- macOS termination requests go through the same save-and-quit guard as the app.
- Existing documents on drives without safe file-swap support are left untouched.
  Your edits stay in the editor, autosave pauses for that path, and Save As lets
  you save under a new name or on another drive. Overwrite cannot bypass this.

### Find and rendering

- Find highlights at most 1,000 complete matches and 2,000 text fragments. It
  labels limited results and keeps navigation within the displayed matches.
- Clearing Find avoids the previous long stalls in documents with many matches.
- Default Mermaid math labels are positioned correctly in WebKit, and math
  fonts load from local assets under the existing security policy.
- Dropdowns follow dark themes on Linux.

### Security and maintenance

- Updated KaTeX to 0.18.4 and Vite to 7.3.7; corrected source-map-js lock metadata.
- External links are limited to web and email URLs. Permission regression tests
  cover nested definitions and aliases without launching OS applications.
- Reviewed Rust audit exceptions, clarified malicious-document security scope,
  and added a separate signed-Mac verification procedure.

## Upgrading

On Mac, quit Bindars and replace the application in Applications with the copy
from the new DMG. Back up your documents and Bindars data first. The signed Mac
app passed tests with synthetic state, but a controlled upgrade from a prior
version has not been run. See the storage locations linked below.

People already using 1.5.x or 1.6.1 can update without a new format migration. Search
data moves out of the settings file into a separate cache that Bindars rebuilds
when needed. Bindars can now remember Home as the last place; builds before
1.6.1 ignore that record.

Since 1.5.0, Bindars has used ordinary Drafts files instead of hidden recovery
snapshots. Older snapshots are neither read nor deleted by current builds.
Recent-file history changed in 1.4.4; earlier builds may not understand it and
some can replace it. Back up settings before downgrading if you need that history.
See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md)
for storage locations and details.

## Known limitations

- The signed Mac app passed overwrite refusal and Save As recovery on a real
  exFAT test volume. FAT32 has native source-test coverage; network shares and
  other drive configurations have limited testing. Folder-change checks depend on filesystem identity
  and cannot reliably detect every replacement on some network shares.
- On macOS and Linux, existing files cannot be replaced on volumes without
  verified file-swap support, including exFAT/FAT32 and some network shares.
  Bindars keeps your text and offers Save As to a new name or another drive.
- Mermaid diagrams explicitly enabling `forceLegacyMathML` can still show
  misplaced formulas in WebKit. Default math rendering is unaffected.
- Reading position restores a section rather than an exact pixel offset. Very
  last-moment scrolling or preference changes may not be recorded before quitting.
- Some printed headings can be separated from their following content, and table
  headers may not repeat on continuation pages. Very wide tables can wrap words
  within cells. Native Linux and Windows printing remain unverified.
- A heading such as `user-content-fn-1` can capture a footnote's internal link.
- A quote block followed by tens of thousands of unmarked continuation lines
  can still be slow to open.
- Renaming or moving a document outside Bindars does not move its annotations
  automatically. Use **Find Notes…** to reconnect them.
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

The exact signed Mac app passed 28 native checks on macOS 26.6.2 arm64 using
synthetic state on an existing account. These covered rendering, Find, saving,
conflicts, failed-save recovery, annotations, Dock behavior, Finder Open With,
printing/PDF, and exFAT recovery. No failure was reproduced in those checks.

macOS 15 automated source tests, an unsigned build, and bundle validation passed;
the signed app has not been tested interactively on macOS 15. Fresh-account,
controlled upgrade, signed-app Drafts/first-use folder-permission, and
logout/shutdown checks remain pending. This release proceeds with those known
coverage limitations; notarization does not establish application compatibility.

An earlier isolated build ignored Cmd-Q in the PDF Save sheet. This did not
reproduce in three attempts on the signed app. The Quit menu worked in both.
The native print sheet may request Local Network access for printer discovery;
the prompt's behavior with access denied has not been verified.

Linux distribution provides an x86_64 Debian package.
The tag workflow publishes the exact package it has built, inspected, installed,
and launched on Ubuntu 22.04. A manually dispatched candidate is a separate build.
Debian 12 or newer and current Linux Mint releases are expected to work but do
not receive the same automated test.

AppImage and Arch distribution remain paused pending repeatable compliance
checks. Windows binaries remain unpublished while native release testing and
code signing are pending.
