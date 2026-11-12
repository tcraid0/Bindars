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

Long notes show a three-line preview. **Read more** reveals the full note inline;
**Show less** returns to the preview. Short notes need no expansion control. You
can expand several notes independently, even while editing is temporarily
unavailable. Expansion does not save changes or move your reading position.
Choose the quotation to return to its highlighted passage, or **Edit note** to
change the note.

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
matching cannot reconstruct evidence that was never saved. Their locations
remain uncertain until you confirm a passage with **Choose passage**.

### Edits made in Bindars

Bindars sees every change made in its own editor. For Markdown documents it
uses that to keep a highlight in place through more edits than the matching
rules above allow. It never searches for similar text. This applies to
highlights whose exact location was known when you entered Edit, and it works
in two ways.

- **The highlight's block still reads the same.** When the paragraph, heading,
  list item or other block that holds the highlight shows exactly the same
  text, the highlight stays on it. Edits elsewhere, formatting applied to that
  block and identical passages elsewhere are all fine.
- **The block was reworded, but the highlighted characters were not touched.**
  Bindars follows the characters you highlighted. You can change, add or remove
  words before or after them, split the paragraph, or join it to another.
  Typing directly against either end keeps the highlight on the original
  characters only: add an "s" and the highlight covers "ledger" inside
  "ledgers".

The second way needs plain text. From the start of the block to the end of the
highlight, the Markdown source must be exactly what the reader shows, apart
from curled quotes and apostrophes. In these cases it does not apply:

- that stretch contains any of `` * _ ` ~ [ ] < > & \ $ | ``, which covers bold,
  italic, code, links, HTML, entities, escapes, math and table cells after the
  first;
- that stretch contains a `--` or `...` that the reader replaces;
- the highlight is on a later line of a block quote, in a code block, or
  continues across a line break in the source;
- any highlighted character was changed, deleted or replaced. This includes
  retyping the same words while the rest of the block changes, and cutting and
  pasting the highlighted text or its whole block. Deleting highlighted text
  and using Undo is followed only by the first way: the block must read the
  same afterwards, and its first character must not have been deleted.

When neither way applies, the matching rules above decide. A one-of-a-kind
passage may still be found by its surrounding text; otherwise the note shows
**Location uncertain** and **Choose passage** places it again. Changes made
outside Bindars, Fountain documents, and highlights that were not exactly
located when you entered Edit always use the matching rules.

Annotations belong to the canonical path returned when opening a document.
Renaming or moving a file does not automatically migrate its annotations. Replacing a file at
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

### Choosing a passage again

If a highlight shows **Location uncertain**, its note is still in
**Highlights & notes**. Choose **Choose passage**, select the intended text in
Read, then choose **Use this passage**. Check the occurrence carefully when
the same words appear more than once. The note stays with the highlight.
If you choose different words, the panel also keeps the original excerpt.
Cancel leaves the attachment unchanged.

## Reconnecting notes after a rename or move

Choose **Reconnect notes…** in Highlights & notes or beside a missing document
in document navigation. Select the original
document; its full path and counts distinguish collections with the same name.
Choose the destination file to preview how many highlighted passages are located,
uncertain, or missing using the existing conservative annotation rules. The
preview also counts matching bookmark headings. Images and diagram content that
has not rendered cannot be confirmed in this preview.

**Reconnect these notes** explicitly moves the complete stored record, including
notes, bookmarks, unknown supported metadata and unresolved passages. No document
text changes. It refuses a destination with annotations or unrecognized stored
data; automatic merging is not supported. Reconnection waits for pending note
edits and queued writes, blocks conflicting annotation mutations, and rechecks
the source record and destination file revision before the atomic storage update.
A stale preview or failed write leaves the original records intact. Both paths'
in-memory annotation records are invalidated after success.

This is a deliberate recovery action, not automatic file-identity tracking.
Similar titles or text never authorize moving notes. It also works for a kept
annotated draft after saving its text elsewhere.

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

### Departure continuity

Leaving Edit by quitting, closing the window or opening another document must
not lose what "Edits made in Bindars" established. For that, version 3
highlights may carry optional `continuity` evidence, called a claim. Its format
is `{format: 1, sourceHash, block?, run?, basis}`. At least one of `block` and
`run` is present.

- `block` is `{line, column, blockHash, start, end}`: the position of the
  block's first text character, the hash of the block's rendered text, and the
  highlight's zero-based offsets within that text. It is accepted only for a
  block whose rendered text has the same hash.
- `run` is `{line, column}`: the position of the highlight's own first
  character. It is recorded only when the plain-text rule held on entering
  Edit and no highlighted character was touched. It is accepted only when the
  plain-text rule holds again in the saved source.

Lines and columns are one-based positions in the saved source. Hashes are
lowercase SHA-256, using the same UTF-8 string convention as positioned
anchors. No document text is stored in the claim. `basis` contains the
superseded position's `sourceHash`, `textHash`, `start`, and `end` values.

Claims are queued once at admitted departure, while the originating file still
owns the annotation hook, only when the observed final editor source equals the
published saved source. Plain Edit→Read continues to use memory without this
write, and applies the same two checks. A settled reader verifies a claim only
against its exact source hash and unchanged basis. Each part is checked
separately and the highlighted text must be found at the claimed place; if the
two parts point to different places, neither is used. The normal position
refresh removes the claim. A claim in any other shape, or with a malformed
part, is ignored as a whole without discarding the highlight; different-source
claims stay inert and cause no write. Note/color edits retain claims; passage
replacement removes them. A newer claim replaces an older one. Older 1.6.4
record serialization preserves this optional field without a version bump.

Entering Edit before a persisted claim has been verified remains conservative:
that claim does not establish observed identity for a new edit session. A
reworded block is followed only under the plain-text rule; otherwise word
changes inside the block, splits, merges and deleted original characters still
may leave a location uncertain. No matching or legacy fallback policy is
relaxed.
