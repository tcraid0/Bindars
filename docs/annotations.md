# Annotations

Select text in the reader and choose a highlight color. The Annotations panel
lets you add or edit a note, remove a highlight, and remove bookmarks even when
their headings have disappeared. Enter saves a note, Shift+Enter adds a line,
and Escape cancels the current edit. Leaving the panel or switching documents
commits the current note to the document where editing began.

## Location and document identity

New highlights record the selected occurrence as well as its quotation and
surrounding text. That occurrence is reused only when both the document source
and the reader's annotation text are unchanged. This distinguishes identical
passages when creating a highlight and when reopening an unchanged document.

After edits, a highlight needs an exact match for its quotation and all stored
context. An originally duplicated context cannot justify moving to the only
remaining copy after deletion. Bindars does not choose the first match or use
fuzzy similarity to guess. Nearby edits can therefore leave a legitimate note
with **Location uncertain**. Deleted or empty quotations show **Location
unavailable**. Both states keep the note available for editing, removal, and
export. Legacy annotations lack the original occurrence evidence; full-context
matching cannot reconstruct evidence that was never saved.

Annotations belong to the canonical path returned when opening a document.
Renaming or moving a file does not migrate its annotations. Replacing a file at
the same path keeps the collection, subject to the location checks above.
Bookmarks remain shortcuts to heading IDs: reordering duplicate headings can
change which heading has that ID. They do not have highlight-style evidence.

Selections can cross inline formatting, links, and code. Hidden MathML and SVG
artwork are excluded. Visible math and HTML inside diagram labels can be marked
where the platform permits selecting that text; a selection spanning excluded
text is rejected instead of silently clipped. Search can cross annotation marks.
Diagrams reapply saved highlights after their asynchronous rendering finishes.

## Saving and recovery

Changes remain pending until the native file write succeeds. Switching documents
keeps each document's latest unsaved record. Retry uses those latest records.
A successful Markdown export does not mean the annotation collection was saved.

Quitting, or closing a window on platforms where that exits the app, commits the
active note and briefly waits for writes. If they fail or take too long, choose
Keep open, Retry saving, Save recovery copy, or Quit without saving. A timeout
never authorizes discarding work. Closing the window on macOS hides it and keeps
pending notes in the running process.

A recovery copy is a JSON file containing full records for every pending path.
To restore one, open an original document, choose **Restore recovery copy** in
Annotations, and confirm replacement of that document's current collection.
Other paths in the copy are untouched; restore them by opening those documents.
The copy is kept. Markdown export is a readable document, not an import format.

## Storage boundary

Annotations use `annotations.json` in the app's data directory, separately from
preferences in `settings.json`. The native boundary serializes reads and writes
and uses the existing atomic file writer. It syncs the temporary file before
replacement; this is not a guarantee against every power failure, filesystem,
or storage-device failure. Multiple concurrent app processes and synchronizing
the app-data directory between machines are not supported merge workflows.

On first use, migration preserves the original settings bytes in
`annotations-legacy-settings.json`, writes and reads back the annotation
collection, then records completion in `annotations-migration.json`. The original
annotation keys remain in settings. They are historical migration data, not the
current collection. Older app versions do not see subsequent annotation edits.

Malformed JSON, unsupported collection versions, or a missing collection after
completed migration stop loading and saving rather than creating an empty
replacement. The settings plugin cannot open until migration preservation has
succeeded. Unrecognized individual records and extra fields are retained when
other annotations are edited.

Keep backups of these files together. If primary storage is damaged, preserve
it before repairing or restoring a known valid collection; do not delete the
migration marker to force reimport of stale settings. Retry loading after repair.
The recovery-copy UI requires a readable destination collection and does not
silently replace damaged primary storage. Damaged preferences can require an app
restart after external repair.
