# Saving your work

Bindars protects current work with autosave and ordinary document files. It
keeps no hidden copies of your writing. This page describes where your work is
saved and what older builds may have left behind.

## Autosave and the Drafts folder

While editing, autosave runs after 2.5 seconds of idle time, or within 10 seconds
of the first unsaved change while you keep typing. Existing documents save to
their own files. New documents become ordinary Markdown files in **Bindars
Drafts**, inside your system's Documents folder, at their first autosave. Files
are named `Untitled.md`, `Untitled 2.md`, and so on without replacing existing
drafts. An empty, unchanged new document does not create a file.

While editing a file in this folder, **Save** opens the filename and location
dialog. A name with no extension is saved as `.md`. If that file already
exists, Bindars leaves it untouched and asks for another name. After saving
successfully elsewhere, Bindars removes the original draft. Canceling the
dialog, or a name that cannot be used, leaves the draft in place and autosave
keeps running. Choosing the same file also leaves the draft in place. These
files can also be opened and managed like other documents, and follow the
backup or sync setup you use for their folder.

The folder is created only when needed. If Documents access is unavailable,
autosave pauses and **Save** lets you choose a location yourself. A failure
while saving the open file, or a conflict with changes made outside Bindars,
also pauses autosave and shows a warning. Resolve the warning or save
elsewhere to protect further edits.

Changes since the last successful save can be lost after an unexpected
shutdown. Discarding changes or reloading from disk also loses the unsaved text;
there is no recovery copy of it. Autosave does not replace backups or a version
history you manage yourself.

## Recovery copies from older builds

Builds before this one kept hidden recovery snapshots: complete, unencrypted
plaintext copies of documents being edited, with each document's name and, for
saved files, its absolute path. Earlier versions, unsaved-draft restore, and
discarded-text recovery were built on them and are gone. Current builds neither
read nor delete these copies.

If an older build ran on this device, the copies may still be on disk under the
per-user app-data directory for the identifier `io.github.tcraid0.bindars`:

- Linux: typically `~/.local/share/io.github.tcraid0.bindars/snapshots/v1/`
  (or under `$XDG_DATA_HOME` when configured).
- macOS: `~/Library/Application Support/io.github.tcraid0.bindars/snapshots/v1/`.
- Windows: `%APPDATA%\io.github.tcraid0.bindars\snapshots\v1\`.

Builds that used the older identifier `dev.bindars.app` kept theirs under that
name instead. The snapshot files are ordinary `.md` files and can be read by
hand. To remove them, quit Bindars and delete the `snapshots` folder. A file
named `snapshot-drafts-migration.json` beside it can be deleted too. Deleted
plaintext may still be recoverable from the storage medium; Bindars does not
perform secure erasure.

## Recent-file history upgrades and older builds

Recent-file history stores its format version and entries together in the
`recent-files` setting: `{ "version": 1, "files": [...] }`. Format 1 uses current
heading IDs. Bindars can convert the older array format; it reads the old
`config-version` first to determine whether heading IDs need conversion.
The old global version and annotation records are left unchanged.

Keeping the history and its version in one value prevents a failed upgrade
save from leaving converted headings paired with an old version marker.
It does not guarantee settings-file durability through a crash or power loss.
Failed reads leave recent history unavailable and prevent writes from an
empty startup state. A failed legacy conversion is not retried during that
session. Unsupported formats are preserved.

Older builds may not understand this history format. Builds with the guarded
history loader show it as unavailable; earlier builds may replace it with a
new list when opening a file. There is no second legacy copy or automatic
downgrade conversion. Back up settings before switching back to an older build
if you need to retain recent files and their saved sections. This history
format change does not alter document contents, annotations, or session
precedence.
