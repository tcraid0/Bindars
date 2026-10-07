## Changes in 1.5.2

This update makes saving safer, restores reading sections more reliably, and
improves printed output for Markdown and Fountain files.
It introduces no new document, settings, or annotation format.

### Reading and editing

- Contents and saved reading sections load reliably when the reader opens.
  The restored section stays consistent across repeated launches, and closing
  or quitting records the current section.
- Search results and highlights refresh when Mermaid diagrams finish rendering
  or redraw. Search highlighting is batched to keep larger documents responsive,
  and replacing an unavailable image no longer disrupts marked text beside it.
- Reader panels fit the available window width from startup. Opening or closing
  panels preserves keyboard focus, and entering Focus mode moves focus out of
  controls that disappear.
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

### Printing and PDF

- Wide Markdown tables wrap within the printable width instead of clipping
  their last columns. Printed tables use equal-width columns; screen tables
  keep horizontal scrolling.
- Strikethrough text, code substitutions, and author/date separators remain
  readable on white paper in every reader theme.
- Reading progress refreshes when the controls return after printing or
  canceling the print dialog.

### Safer saving and recovery

- Settings updates now write a complete replacement file. A failed write leaves
  the previous settings file intact instead of truncating it.
- Leaving the editor or quitting waits for pending saves, then checks the latest
  text again. This protects changes restored with Undo while a save is still
  running, including when Save is pressed repeatedly.
- On macOS and Linux, saving stops and offers **Save As** if the document's
  folder has been replaced since it was opened.
- On macOS, replacement saves and exports preserve access permissions, Finder
  tags, and other extended attributes. If those attributes cannot be read or
  copied, the destination stays unchanged and the failure details are shown.
- **Make a copy…**, under **Export options** while reading, creates a fresh file
  and opens that copy for editing. It refuses existing files and names with saved
  annotations. Canceling or a failed copy leaves the original open for reading.
- Saving to a new location confirms the destination folder.
- A successful Save As adds the destination to Recent files immediately.
- Recovery-copy imports run one at a time through file selection and confirmation,
  so overlapping attempts cannot restore the wrong copy.
- Settings and annotation files with duplicate JSON keys are refused and
  preserved rather than silently rewritten with missing entries.
- Annotation recovery exports cannot overwrite files in Bindars' app-data folder.
- Notes with a recognizable newer record version ask you to use a newer Bindars
  instead of treating them as damaged. See [Annotations](https://github.com/tcraid0/Bindars/blob/main/docs/annotations.md)
  for backup and repair guidance.
- Unrecognized stored highlight colors display as yellow while retaining their
  original values through note edits and recovery imports. Choosing a supported
  color explicitly replaces the stored value.
- Document, annotation, and export writes also ask the system to sync the containing
  folder. This improves durability on supported systems; it does not guarantee
  recovery from every power failure or storage failure.

Editing an existing document autosaves to that same file. Use **Make a copy…**
before editing to keep the original unchanged. Copies contain document text;
highlights, notes, and bookmarks remain with the original path.

New drafts become ordinary files in **Bindars Drafts** at their first autosave.
**Save** lets you choose a name and location. Save As can replace an existing file
selected with a supported extension; when Bindars adds a missing extension, it
refuses an existing file at the resulting name. Before removing a draft saved
elsewhere, Bindars checks that both files still contain the versions it expects.
It keeps the draft and shows a notice if those checks fail. Drafts with annotations,
or whose annotation state cannot be confirmed, also stay at their original paths.

### Diagram math

Math inside Mermaid diagrams now follows the same safety limits as Markdown math
and is checked before rendering starts. Diagrams with math that exceeds those
limits, or transformations that cannot be checked safely, show their source
instead of rendering.

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
  validation for this release. Folder-change checks depend on filesystem identity
  and cannot reliably detect every replacement on some network shares.
- Reading position restores a section rather than an exact pixel offset. Very
  last-moment scrolling or preference changes may not be recorded before quitting.
- Some printed headings can be separated from their following content, and table
  headers may not repeat on continuation pages. Very wide tables can wrap words
  within cells. Native Linux and Windows printing remain unverified.
- A heading such as `user-content-fn-1` can capture a footnote's internal link.
- A quote block followed by tens of thousands of unmarked continuation lines
  can still be slow to open.
- Renaming or moving a document outside Bindars does not move its annotations.
  Orphaned notes stay stored but are not automatically recovered.
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
