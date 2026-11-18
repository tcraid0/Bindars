## Downloads

- **Mac (Apple Silicon):** `Bindars_1.7.1_aarch64.dmg`. Requires macOS 15.0 or newer; no Intel build.
- **Linux (x86_64):** install the `.deb` with `sudo apt install ./Bindars_*_amd64.deb`.

Updates are manual. The Mac download is accompanied by `SHA256SUMS-macos.txt`; the Debian package has `SHA256SUMS`.

## Changes in 1.7.1

The sidebar is easier to use and easier to read.

### Clicks that work every time

- A document in Recent, or on Home, opens when you click anywhere on its row. Before, only the name itself opened it, and clicks elsewhere on the row did nothing.
- If you click a document while another one is still opening, Bindars opens the one you clicked last. Before, that click could be ignored.

### Folders and documents look different

- In Folders, each folder has a folder symbol and an arrow, and the current folder's name has a folder symbol too. Documents are no longer bold, so folders and documents are easy to tell apart.
- File endings such as `.md` and `.fountain` are shown in a lighter grey, so names are quicker to read. The full name is still there.
- The search box at the top of the sidebar has a magnifying glass and a quieter look.
- The extra line above the first document in Folders is gone.

### Screenplay titles

- Screenplay titles in Recent and Search no longer show formatting marks such as `**` or `_`.

No new setting, dependency, document format or annotation format is introduced.

## Upgrading

On Mac, quit Bindars and replace the application with the copy from the new DMG. Back up documents and Bindars data first. No format migration is needed from 1.7.0. The first time 1.7.1 starts, it rebuilds its search list once. See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md) for storage locations and downgrade limitations.

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
- A different document now opens from its top when it has no remembered place.
  This was checked from Recent and Folders; the native Open dialog route, where
  an earlier scroll offset could carry over, was not rechecked.
- At extreme interface zoom with the sidebar open, the remaining reading pane
  can require horizontal scrolling. This was reproduced at 300% in 1.6.3 and
  1.6.4 and has not changed.
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
  owner/group or locked and hidden flags. macOS now keeps the creation date;
  Linux replacement saves still do not preserve filesystem ACLs or extended
  attributes.
- Interrupted saves or competing edits can leave temporary files or a
  **Bindars recovered …** copy beside the document. Bindars never deletes these
  leftovers automatically; see [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md)
  before removing them.
- A save that never finishes, for example on a stalled network share, still
  cannot be cancelled, and Quit waits for it. After a failed save, autosave
  stays paused until you save by hand.
- Saving when you switch away does not apply while a dialog or the print sheet
  owns the window. Linux does not yet save on logout.

## Validation

Automated source checks pass on Linux and on macOS 15: the workspace and Rust tests, lints, the type check, the licence inventory and the production build. The dependency audits pass for everything shipped in the app. One advisory with no fix yet (GHSA-fc5q-39xc-vjpf, in `picomatch`) is accepted for build tools only; that package is not part of the app.

The sidebar changes were checked in a browser engine with the app's own styles, in all four themes: where clicks land on each row, the text weights and colours, and the line above the first row. New tests cover each change.

The Mac app and its disk image are signed with a Developer ID and notarized by Apple.
