## Downloads

- **Mac (Apple Silicon):** `Bindars_1.8.1_aarch64.dmg`. Requires macOS 15.0 or newer; no Intel build.
- **Linux (x86_64):** install the `.deb` with `sudo apt install ./Bindars_*_amd64.deb`.

The Mac download is accompanied by `SHA256SUMS-macos.txt`; the Debian package has `SHA256SUMS`. The other Mac files (`.app.tar.gz`, `.sig` and `latest.json`) are used by the in-app update; you don't need to download them.

## Changes in 1.8.1

A maintenance release: security fixes in the libraries underneath Bindars, current bug-fix versions of its components, and a tidier look.

### Security

- Two libraries that Tauri, the framework Bindars is built on, depends on had security advisories published this week: `url` (a specially made web address could crash it) and `cookie` (a weakness in one kind of protected cookie). Both are updated. The risk to Bindars was low, since it is a local reader and does not use that kind of cookie.

### Updated components

- Tauri 2.12.7, with its window and web-view layers and the opener plugin.
- The editor (CodeMirror), the Markdown grammar it uses, the styling tools and the build tool, each at its latest bug-fix version.
- Building Bindars from source now needs Rust 1.91 or newer (was 1.90).

### Look

- Buttons, fields, menus, popups and panels now share two corner sizes, one for things you click or type in and one for things that hold content, instead of about ten slightly different ones. Dialogs are a little less rounded; messages and small menus a little more.
- Messages at the bottom of the window slide in and stop instead of bouncing.

Nothing about how documents, notes or settings are stored has changed.

## Updating

On Mac with 1.8.0, choose **Bindars → Check for Updates…**, then **Install and Restart**. This is the first release that 1.8.0 can install by itself. From 1.7.1 or earlier, quit Bindars and replace the application with the copy from the new DMG once. No format migration is needed. See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md) for storage locations and downgrade limitations.

On Linux, keep getting updates from the [download page](https://github.com/tcraid0/Bindars/releases/latest).

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
- When Contents or another panel is open, the Find bar can cover the ends of
  lines. This happened in 1.7 too and is more frequent now that the text stays
  centred on the window.
- After an in-app update, the Dock's recent apps can show Bindars twice. Only
  one copy is running; the extra icon goes away when removed from the Dock.
- The update check does not use a proxy set in macOS System Settings.
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

Automated source checks pass on Linux and on macOS 15: the workspace and Rust tests, lints, the type check, the minimum supported Rust version, the licence inventory and the production build. The dependency audits pass for the app and for the build tools. The Rust audit still lists five maintenance or soundness notices with no fixed version available: four are Linux-only parts of GTK and D-Bus, and one is a library that is locked but never built.

The Mac app and its disk image are signed with a Developer ID and notarized by Apple.

The new corners and messages were checked by hand on macOS 26.6 in a copy with its own app ID, across the light and dark themes.

Not checked by hand: an in-app update from 1.8.0 to 1.8.1 before publishing (the update path was rehearsed for 1.8.0), Linux, VoiceOver, macOS 15, and a browser download on a clean Mac.
