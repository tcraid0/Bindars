## Downloads

- **Mac (Apple Silicon):** `Bindars_1.8.0_aarch64.dmg`. Requires macOS 15.0 or newer; no Intel build.
- **Linux (x86_64):** install the `.deb` with `sudo apt install ./Bindars_*_amd64.deb`.

The Mac download is accompanied by `SHA256SUMS-macos.txt`; the Debian package has `SHA256SUMS`. The other Mac files (`.app.tar.gz`, `.sig` and `latest.json`) are used by the in-app update; you don't need to download them.

## Changes in 1.8.0

Bindars can now update itself on Mac, and the text stays still while you read.

### Updates from inside the app (Mac)

- Choose **Bindars → Check for Updates…** to look for a newer version. When there is one, **Install and Restart** downloads it, checks it, replaces Bindars and opens it again. Unsaved work is saved first, as when you quit.
- Nothing is checked unless you ask. Automatic checks are off. On a later launch, Bindars asks once whether you'd like it to check about once a day, and you can change this in the Updates window.
- Checks and downloads contact only GitHub, which sees your internet address. Your documents are never sent. An update is installed only if it is newer and signed for the version it claims.
- If you run Bindars from the disk image, it asks you to move it to Applications before updating.

### Reading

- The blue frame around the document when it opened is gone.
- Escape moves the keyboard back to the document from the toolbar, Contents or the Sidebar.
- The text column stays centred on the window. Opening Contents, the Sidebar or Highlights & notes, or switching between Read and Edit, no longer slides the text sideways. When a panel needs the room, the text moves only as far as it must.
- Headings and code blocks follow the text size, so at large sizes headings stay larger than the text around them.
- Wide diagrams can be scrolled to their left edge instead of being cut off.

### Highlights and notes

- **Copy** in Highlights & notes puts all your highlights and notes on the clipboard as text, ready to paste.
- Copy and Export give the same text: highlights in reading order under their section headings, each passage quoted with its note below it, then any highlight whose place could not be found under "Location unavailable", then bookmarks. Colour and date are no longer included.

Two settings are new: automatic update checks (off by default) and whether Bindars has asked about them. Documents and annotations are stored as before.

## Updating

1.8.0 is the first version with in-app updates, so install it by hand once. On Mac, quit Bindars and replace the application with the copy from the new DMG. Back up documents and Bindars data first. No format migration is needed from 1.7.1. See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md) for storage locations and downgrade limitations.

From 1.8.0 on, choose **Bindars → Check for Updates…** any time on Mac. When an update is ready, choose **Install and Restart**. On Linux, keep getting updates from the [download page](https://github.com/tcraid0/Bindars/releases/latest).

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

Automated source checks pass on Linux and on macOS 15: the workspace and Rust tests, lints, the type check, the licence inventory and the production build. The dependency audits pass, for the app and for the build tools, with no accepted exceptions.

The Mac app and its disk image are signed with a Developer ID and notarized by Apple.

In-app updates were rehearsed on macOS 26.6 (Apple Silicon) between two signed and notarized test builds with their own app ID, a temporary test release and a test signing key:

- the update installed and reopened in about two seconds, at the same place, with no system prompt, and kept an unsaved edit, highlights and notes;
- nothing was sent while automatic checks were off;
- a changed update file, a version the signature was not made for, a signature from another key and a download address outside GitHub were all refused, and the app stayed as it was;
- the copy run from the disk image asked to be moved to Applications;
- with automatic checks on, the Update button appeared after about 11 seconds without interrupting.

The rehearsal found that **Check for Updates…** showed an update found earlier instead of checking again. That was fixed before release.

The reading changes were checked by hand on macOS 26.6 in a copy with its own app ID: the frame is gone, headings and code at text sizes 17 and 24, a wide diagram, Copy and Export giving the same text, all four themes, and Focus mode.

Not checked by hand: the save question during Install and Restart (autosave had already saved the edit), Linux, VoiceOver, macOS 15, and a browser download on a clean Mac.
