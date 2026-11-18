## Downloads

- **Mac (Apple Silicon):** `Bindars_1.7.0_aarch64.dmg`. Requires macOS 15.0 or newer; no Intel build.
- **Linux (x86_64):** install the `.deb` with `sudo apt install ./Bindars_*_amd64.deb`.

Updates are manual. The Mac download is accompanied by `SHA256SUMS-macos.txt`; the Debian package has `SHA256SUMS`.

## Changes in 1.7.0

Writing in Bindars is easier, highlights survive more editing, and saving is safer in unusual situations.

### A formatting bar for writing

- In **Edit**, a bar above a Markdown document offers Paragraph and heading styles, Bold, Bullets, Numbered and Checklist, with Italic, Link, Quote, Divider and list indenting under **More**. The saved file is still ordinary Markdown.
- **Styled / Plain** changes how Markdown looks while you write. It does not change the file.
- Finish a task by clicking its `[ ]` box in Styled, with Cmd+L (Ctrl+L on Linux), or with **More → Mark done**. Sub-tasks stay under their parent in Read and in print.
- When an action cannot be applied safely, Bindars leaves the text alone and says why in plain words.

### Read and Edit stay in the same place

- Edit opens on the lines you were reading, at the same height, and Read returns to where you were writing.
- The Read/Edit switch and the formatting buttons no longer shift as you change mode. Find sits directly under the formatting bar.
- Bindars remembers whether Contents is open.

### Highlights keep their place through edits

- A highlight stays on its passage when you edit elsewhere, format its paragraph, or change the words around it. Bindars follows the characters you highlighted and never guesses from similar text.
- If a location can no longer be trusted, the highlight shows **Location uncertain** and its note is kept. **Choose passage** lets you place it again.
- Dividers and highlights now print.

### Safer saving

- Pending edits are saved when you switch to another app and when the Mac is about to sleep.
- A save that takes more than a moment shows **Saving…**, and after 30 seconds says the text is still safe in the window.
- A full disk gets a plain message and offers **Save As**. Warnings that autosave has paused now begin with those words.
- Save As and **Make a Copy** refuse a file that already has saved highlights, notes or bookmarks, so a new document cannot inherit them. Make a Copy no longer misses words typed a moment earlier.
- On macOS, saving keeps the file's creation date.
- Quit and closing the window work from the error screen.
- A new document can no longer end up as two drafts.

### Search, sidebar and wording

- Search opens with its box and list first, sits beside View, and keeps its selection steady while the list scrolls.
- The page holds still while a document opens, and a different document opens from its top unless it has a remembered place.
- Folder problems, moved files and save choices are described in plain words, with buttons that say what will happen, such as **Keep my changes**.
- Empty link sections under Contents are hidden.

No new dependency, document format or annotation format is introduced. Highlights gain an optional field that 1.6.4 preserves.

## Upgrading

On Mac, quit Bindars and replace the application with the copy from the new DMG. Back up documents and Bindars data first. No format migration is needed from 1.6.4. See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md) for storage locations and downgrade limitations.

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

- Fountain titles containing emphasis markers can still display those markers. This release does not change title extraction.
- A save that never finishes, for example on a stalled network share, still
  cannot be cancelled, and Quit waits for it. After a failed save, autosave
  stays paused until you save by hand.
- Saving when you switch away does not apply while a dialog or the print sheet
  owns the window. Linux does not yet save on logout.

## Validation

Automated source checks pass on Linux and on macOS 15: the workspace and Rust tests, lints, the type check, the licence inventory and the production build. A trial build of the Linux package passed the release workflow's checks.

The Mac app and its disk image are signed with a Developer ID and notarized by Apple. The app inside the published disk image was tried by hand on macOS 26.6 (Apple Silicon) with made-up documents: saving when switching to another app, the formatting bar, Make a Copy straight after typing, a highlight kept through an edit to its paragraph, idle autosave, switching documents, and Quit straight after typing.

The formatting bar, the Read and Edit place, highlight continuity, Search and document switching were each checked by hand in isolated macOS builds during development. The save changes were checked by hand the same way: switching away in Edit and Focus mode, open dialogs, the header messages at narrow widths, a full disk with Save As recovery, the highlights refusal, creation dates, drafts, and Quit from the error screen.

Not checked by hand: a save slower than two seconds, sleep, the print sheet taking focus, exFAT or network volumes with the new save behaviour, iCloud folders, a browser download on a clean Mac, macOS 15, and any Linux desktop session.
