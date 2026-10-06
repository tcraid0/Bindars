# Annotations

Select text in the reader and choose a color to highlight it. Choose **Note**
instead to create a yellow highlight and open a note ready for typing. Note
opens **Highlights & notes** and leaves Focus mode; choosing a color keeps the
panel and Focus mode as they are.

With reader text selected, press Tab to reach the first highlight color, or
Shift+Tab to reach Note. Tab and Shift+Tab move through the actions; Enter or
Space activates the focused action. Escape dismisses the actions and returns
focus to the reader. Tab past either end leaves the group normally.

The **Highlights & notes** panel lets you choose **Add note** on an existing
highlight, edit a note, remove a highlight, and remove bookmarks even when their
headings have disappeared. Enter keeps a note, Shift+Enter adds a line, and
Escape cancels the current edit. Cancelling an empty note leaves its highlight.
Starting another note, leaving the panel, or switching documents commits the
current note to the document where editing began.

## Location and document identity

New highlights record the selected occurrence as well as its quotation and
surrounding text. That occurrence is reused only when both the document source
and the reader's annotation text are unchanged. This distinguishes identical
passages when creating a highlight and when reopening an unchanged document.

After edits, a highlight needs an exact match for its quotation and all stored
context. For new highlights with occurrence evidence, an originally duplicated
context cannot justify moving to the only remaining copy after deletion. Bindars
does not choose the first match or use fuzzy similarity to guess. Nearby edits can therefore leave a legitimate note
with **Location uncertain**. Deleted or empty quotations show **Location
unavailable**. Both states keep the note available for editing, removal, and
export. Legacy annotations lack the original occurrence evidence; full-context
matching cannot reconstruct evidence that was never saved. A legacy highlight
can therefore attach to a sole remaining identical passage after deletion.

Annotations belong to the canonical path returned when opening a document.
Renaming or moving a file does not migrate its annotations. Replacing a file at
the same path keeps the collection, subject to the location checks above.
Bookmarks remain shortcuts to heading IDs: reordering duplicate headings can
change which heading has that ID. They do not have highlight-style evidence.

Saving a draft to another location normally removes the draft. A draft with
highlights, notes, or bookmarks is kept instead, with its Recent entry, because
the annotations stay with the draft's path and do not move to the saved file.
A draft is also kept when Bindars cannot confirm that it has none, for example
while they are loading or after they failed to load or save. New drafts skip
names that still have stored annotations. If annotation storage cannot be read
and validated, creating the draft fails and autosave pauses. Your text stays in
the editor; use Save to choose a location. Existing orphaned notes are preserved,
but skipping their names does not restore access to them.

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
Save it outside Bindars' app-data directory; destinations inside that directory
are refused to protect annotations, preferences, and migration files.
To restore one, open an original document, choose **Restore recovery copy** in
**Highlights & notes**, and confirm replacement of that document's current collection.
Other paths in the copy are untouched; restore them by opening those documents.
The copy is kept. Markdown export is a readable document, not an import format.

To share your highlights and notes, export them as Markdown from **Highlights &
notes**. Open that exported file in Bindars and choose **Print to PDF** if you
want a PDF of the notes. Printing the original document does not append note
text.

## Storage boundary

Annotations use `annotations.json` in the app's data directory, separately from
preferences in `settings.json`. The native boundary serializes reads and writes
of both files and uses the same atomic file writer for each: a failed write
leaves the previous file intact. It syncs the temporary file before
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
replacement. Settings cannot be read or written until migration preservation
has succeeded. Unrecognized individual records and extra fields are retained when
other annotations are edited. Unrecognized color names are displayed as yellow,
but their stored values survive note edits, unrelated saves, and recovery-copy
restoration. Choosing a supported color explicitly replaces the stored value.

## If annotations cannot be loaded

A record with a recognizable newer version needs that version of Bindars or
later. It is not evidence that the notes are damaged. Do not reset or rewrite it
with an older build.

If storage is damaged, quit Bindars and copy the entire app-data directory to a
safe location before attempting repair. Its usual locations are:

- Linux: `~/.local/share/io.github.tcraid0.bindars/` (or under `$XDG_DATA_HOME`).
- macOS: `~/Library/Application Support/io.github.tcraid0.bindars/`.
- Windows: `%APPDATA%\io.github.tcraid0.bindars\`.

Keep `annotations.json`, `settings.json`, `annotations-legacy-settings.json`,
and `annotations-migration.json` together when present. Restore a known valid
backup, or have someone familiar with the storage format repair a copy before
replacing the affected file. Do not delete the migration marker to force
reimport of stale settings, or clear the whole collection to repair one document.

A damaged collection can also prevent settings and recent files from loading.
Restart after external repair, then use **Retry loading** if the annotations
panel still reports an error. The recovery-copy UI requires a readable
destination collection; it does not reset damaged primary storage.
