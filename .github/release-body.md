## Changes in 1.6.1

This update adds **Home**, a place to choose what to read next, reopens where
you left off, and keeps the sidebar's Recent list steady while you use it.
Version 1.6.0 was not published on its own; its changes are listed below and
are part of this release. It introduces no new document or annotation format.

### Home and where you left off

- The Bindars symbol in the toolbar is now a **Home** button, after Back and
  Forward. Go there with the button, **Shift+Cmd+H** on macOS or **Alt+Home** on
  Linux, or **File › Home** on macOS. An edited document is saved or you are
  asked first, as when opening another file.
- Home lists your five most recent documents by their own titles, with the
  section you were in and when you last opened each; **Continue at** and a
  section mark the one you were reading. **Open File…** and **New** sit beside
  the heading, and **Remove** appears when you point at or focus a row.
- When Home has nothing to list, it offers ways to start: open a file, try the
  example, or start a new document. With one or two documents, Open and New
  stay below the list until there are three.
- Bindars reopens the document you were reading, at its section, or Home if you
  left from Home. A new document you never saved counts as Home. A file you
  open from Finder, the command line or a drop always comes first and opens at
  the top. While a document reopens you see "Opening ‹name›…" instead of the
  welcome screen.
- On Linux, a missing file named on the command line is reported instead of
  being replaced by the last document.
- **Back** and **Forward** include Home and every way of changing document:
  Recent, links, Search, Open File, drops, Finder, New, Try an Example and Make
  a Copy. Back to a file that is gone shows the message once and skips it
  afterwards.
- The first launch keeps its welcome screen and startup animation; going Home
  inside the app never animates.

### Sidebar

- **Recent** keeps its order while you use it, and **Back** returns to
  documents opened from Recent.
- A saved document keeps its place in **Folders**.
- Rows show where a document lives on one line.
- A one-time note points new users to the sidebar, and **View › Show Sidebar**
  opens it on macOS.
- **Add Folder** starts in the current document's folder.
- An empty Recent list says "Documents you open will appear here."

## Changes in 1.6.0

This update adds new ways to find and move between documents, zooms the whole
interface, and makes everyday reading and editing steadier. It introduces no new
document, settings, or annotation format.

### Finding and navigating documents

- The sidebar's **Recent**, **Drafts** and **Folders** tabs replace the Workspace
  panel. Recent lists documents opened from any location, Drafts lists the
  **Bindars Drafts** folder, and Folders browses one folder of your choice and
  its subfolders. Files stay where they are.
- **Search documents** (**Cmd+K** on macOS, **Ctrl+K** on Linux) finds words and
  phrases across those documents. Choosing a passage result opens the document
  at that passage.
- The **Find in Document** button in the header opens the in-document search.
- **View** zooms the whole interface from 75% to 300%, and the level is
  remembered between launches.
- **Cmd+plus**, **Cmd+minus** and **Cmd+0** on macOS, or **Ctrl+plus**,
  **Ctrl+minus** and **Ctrl+0** on Linux, now zoom the whole interface and
  return it to actual size. Reading text size and **Reset** are in Reader
  Settings.
- **Find Notes…** reconnects highlights, notes and bookmarks to a document that
  was renamed or moved outside Bindars.
- Contents shows **Linked from**, the documents that link to the open document,
  and **Unlinked mentions**, the documents that name its title without a link.

### Reading and editing

- Toggle Highlights & notes with **Shift+Cmd+M** on macOS or **Ctrl+Shift+M**
  on Linux. Plain **Ctrl+M** no longer toggles Notes; **Cmd+M** minimizes on macOS.
- With Find open, **Ctrl+F** returns to its field, and **Ctrl+G** and
  **Ctrl+Shift+G** go to the next and previous match while you read (**Cmd+F**,
  **Cmd+G** and **Shift+Cmd+G** on macOS). Find closes when another document
  opens or the file changes on disk, and the one-time annotation hint hides
  while Find is open.
- Dragging to select text, or **Select All**, stays within the document instead
  of also selecting the sidebar, Contents and Notes.
- Error messages stay until you dismiss them. A message raised in a dialog
  appears in that dialog.
- Dropping a file Bindars can't open, or clicking a web or email link the system
  won't open, now shows a message.
- Right-clicking a link or an empty area no longer opens the web view's own menu.
  Text fields, images and selected text keep their menus.
- The toolbar shows the Bindars symbol in place of the wordmark.
- Fountain scene numbers have a separating space in Contents and copied text.
  Existing highlights near numbered scene headings may show **Location uncertain**
  after updating; the saved highlights and their notes are retained.

### Reliability

- A document or recovery copy that has been replaced by a named pipe is refused
  instead of leaving Bindars waiting.
- Document headings such as "Loading screen" no longer pick up the startup
  screen's styles.

## Upgrading

People already using 1.5.x can update without a new format migration. Search
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

- Real exFAT and FAT32 drives and network shares have had limited testing and
  need native validation for this release. Folder-change checks depend on filesystem identity
  and cannot reliably detect every replacement on some network shares.
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

## Supported package

Linux is the supported release platform, with an x86_64 Debian package only.
The tag workflow publishes the exact package it has built, inspected, installed,
and launched on Ubuntu 22.04. A manually dispatched candidate is a separate build.
Debian 12 or newer and current Linux Mint releases are expected to work but do
not receive the same automated test.

AppImage and Arch distribution remain paused pending repeatable compliance
checks. Windows and macOS binaries remain unpublished while native release
testing and code signing are pending.
