## Changes in 1.5.2

This update improves reading, editing, and saving Markdown and Fountain files.
It introduces no new document, settings, or annotation format.

### Reading and editing

- Clearer text in all four themes, including links, search results, and labels
  on filled buttons. Sepia keeps its warm background with stronger text contrast.
- The operating system's Reduce Motion preference now also stops smooth reader
  scrolling. The Saved confirmation stays visible, and the startup screen stops
  animating. Bindars' own Reduced effects setting still removes texture and blur.
- Dialogs keep keyboard focus and interaction inside the active dialog, including
  error notifications. Closing them restores focus to the previous control.
- The current section and selected screenplay character expose their state to
  assistive technology.
- Highlight actions follow the selected passage when scrolling and stay below
  the document header.
- Markdown lists continue on Enter in both Styled and Plain formatting modes.
  Enter on an empty list item ends the list. Fountain editing is unchanged.
- Canceling a folder picker no longer interferes with loading the saved folder,
  and an older picker cannot replace a newer choice or Clear action.
- Mermaid diagrams accept mixed-case fence languages such as `Mermaid`.
- Markdown files beginning with a byte-order mark recognize frontmatter correctly,
  including when calculating reading statistics.

### Saving and notes

- **Make a copy…**, under **Export options** while reading, creates a fresh file
  and opens that copy for editing. It refuses existing files and names with saved
  annotations. Canceling or a failed copy leaves the original open for reading.
- Saving to a new location confirms the destination folder.
- Annotation recovery exports cannot overwrite files in Bindars' app-data folder.
- Notes with a recognizable newer record version ask you to use a newer Bindars
  instead of treating them as damaged. See [Annotations](https://github.com/tcraid0/Bindars/blob/main/docs/annotations.md)
  for backup and repair guidance.
- Document, annotation, and export writes also ask the system to sync the containing
  folder. This improves durability on supported systems; it does not guarantee
  recovery from every power failure or storage failure.

Editing an existing document autosaves to that same file. Use **Make a copy…**
before editing to keep the original unchanged. Copies contain document text;
highlights, notes, and bookmarks remain with the original path.

New drafts become ordinary files in **Bindars Drafts** at their first autosave.
**Save** lets you choose a name and location. Save As can replace an existing file
selected with a supported extension; when Bindars adds a missing extension, it
refuses an existing file at the resulting name. A draft saved elsewhere is kept
if it has annotations or Bindars cannot confirm that it has none.

## Upgrading

People already using 1.5.x can update without a new format migration.

Since 1.5.0, Bindars has used ordinary Drafts files instead of hidden recovery
snapshots. Older snapshots are neither read nor deleted by current builds.
Recent-file history changed in 1.4.4; earlier builds may not understand it and
some can replace it. Back up settings before downgrading if you need that history.
See [Saving your work](https://github.com/tcraid0/Bindars/blob/main/docs/recovery-and-privacy.md)
for storage locations and details.

## Known limitations

- Real exFAT drives and network shares have had limited testing and need native
  validation for this release.
- A heading such as `user-content-fn-1` can capture a footnote's internal link.
- A quote block followed by tens of thousands of unmarked continuation lines
  can still be slow to open.
- Renaming or moving a document outside Bindars does not move its annotations.
  Orphaned notes stay stored but are not automatically recovered.
- A damaged annotation collection is preserved and can also prevent settings
  and recent files from loading. External repair may be needed; back up the
  original storage files first.
- A program writing through an already-open file handle may continue writing
  to an older file after Bindars replaces it. On macOS, saving can lose Finder tags.

## Supported package

Linux is the supported release platform, with an x86_64 Debian package only.
The tag workflow publishes the exact package it has built, inspected, installed,
and launched on Ubuntu 22.04. A manually dispatched candidate is a separate build.
Debian 12 or newer and current Linux Mint releases are expected to work but do
not receive the same automated test.

AppImage and Arch distribution remain paused pending repeatable compliance
checks. Windows and macOS binaries remain unpublished while native release
testing and code signing are pending.
