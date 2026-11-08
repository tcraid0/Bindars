## Downloads

- **Mac (Apple Silicon):** `Bindars_1.6.4_aarch64.dmg`. Requires macOS 15.0 or newer; no Intel build.
- **Linux (x86_64):** install the `.deb` with `sudo apt install ./Bindars_*_amd64.deb`.

Updates are manual. The Mac download is accompanied by `SHA256SUMS-macos.txt`; the Debian package has `SHA256SUMS`.

## Changes in 1.6.4

Recent is easier to scan while keeping the information needed to choose the correct document.

- A readable title stays primary, with the exact filename beneath it when distinct. Numbered endings such as `(1).md`, punctuation and extensions remain visible. Filenames appear immediately while titles are being prepared.
- Routine folder names and dates move into supplementary details. Same-named files retain enough visible folder ancestry to tell them apart, even when their last two parent folders also match.
- Hover or focus a Recent row to see its full location and **Last opened** information. Escape dismisses the details. Page Up / Page Down scroll long details while keeping focus on the existing row.
- Details stay inside the window at high interface zoom, and clicking a document does not flash a details panel. Hover details leave Find and Edit shortcuts working normally.
- Drafts shows its shared location once above the list, with full paths retained for recovery notices. A failed refresh keeps the last known canonical Drafts location instead of guessing from a nested file.
- Home keeps its dates and continuation cues, Search keeps locations and matching passages, and Folders keeps filenames primary. Recent keeps its stable order while the sidebar is open.

No new setting, dependency, document format, annotation format or migration is introduced.

## Upgrading

On Mac, quit Bindars and replace the application with the copy from the new DMG. Back up documents and Bindars data first. No format migration is needed from 1.6.3. See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md) for storage locations and downgrade limitations.

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
- Opening a different file through the native Open dialog can retain the previous
  reader scroll offset, placing a shorter document partway down or at its end.
  Use the table of contents or scroll to the top. This behavior also exists in
  1.6.2; it was identified during the 1.6.3 native checks.
- At extreme interface zoom with the sidebar open, the remaining reading pane
  can require horizontal scrolling. This was reproduced at 300% in both 1.6.3
  and 1.6.4; Recent details remain bounded within the window.
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

- Fountain titles containing emphasis markers can still display those markers. This release does not change title extraction.

## Validation

Source checks and independent reviews cover document identity, collision ancestry, delayed indexing, keyboard focus, Escape ownership, opening/removal/retry, Drafts recovery and Home/Search preservation. Isolated native WebKit fixtures passed all ten interface zoom steps from 75% to 300% across four window sizes and all four themes, including keyboard access to long details.

The Apple Silicon Mac download is Developer ID signed, notarized and stapled. The final DMG and its contained app passed signature, ticket and Gatekeeper checks; the contained app matches the native-tested app byte for byte. On macOS 26.6.2, native checks passed for filename/folder selection, focus and Escape, Search, exact saved fixture bytes, math/Mermaid rendering, unavailable-file retry, removal, Home and normal Quit. A narrow synthetic-state upgrade from 1.6.3 restored the document session, Recent identities and zoom preference. Native interface zoom was exercised through 300%.

The Debian package passes metadata/content checks, notice verification, installation and a headless launch test on Ubuntu 22.04. macOS 15 arm64 has automated source/build coverage.

This is limited native coverage. A fresh account, quarantined browser-download and offline first launch, macOS 15 signed-app GUI, VoiceOver speech, permission grant/denial, and the complete lifecycle/conflict-recovery/printing matrix were not established for this candidate. The synthetic upgrade smoke test does not establish exhaustive annotation/recovery upgrade behavior. Interactive Linux/Windows behavior remains unverified. Windows binaries, AppImage and Arch distribution remain unpublished.
