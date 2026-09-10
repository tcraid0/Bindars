# Recovery snapshots and privacy

This is the canonical description of what Bindars' crash-recovery system
stores, where it lives, and how to remove it.

## What is stored, and where

While you edit, Bindars periodically writes recovery snapshots to help recover
work after a crash or power loss. Changes since the last successful snapshot
can still be lost; snapshots do not replace saving your document or backups.

- Snapshots stay on this device. They are written over Tauri IPC into the
  app-data directory, and the production content-security policy contains
  `connect-src 'none'`: there is no upload, sync, or telemetry path.
- Each snapshot file is a **complete plaintext copy** of the document at that
  moment. Snapshots are not encrypted.
- Each document's snapshot stream contains an `identity.json` with the document
  name and, for saved files, its **absolute path**. Anyone who can read your
  app-data directory can learn what you write and where your files live.

The snapshot tree lives under the OS-specific per-user app-data directory,
using the configured application identifier `io.github.tcraid0.bindars`:

- Linux: typically `~/.local/share/io.github.tcraid0.bindars/snapshots/v1/`
  (or under `$XDG_DATA_HOME` when configured).
- macOS: `~/Library/Application Support/io.github.tcraid0.bindars/snapshots/v1/`.
- Windows: `%APPDATA%\io.github.tcraid0.bindars\snapshots\v1\`.

Older builds using `dev.bindars.app` may retain recovery data under that older
identifier. Clearing history in the current app targets its current app-data
directory. Builds configured with an isolated test identifier use their own
directory instead.

## File permissions

On Unix-like systems Bindars creates snapshot directories owner-only (`0700`)
and snapshot/identity files owner-only (`0600`). Directories are created and
repaired one component at a time, each set to exactly `0700` immediately, so
an unusual umask at creation time cannot leave the chain owner-unreadable or
permanently untraversable — a later write heals it. The first time recovery
data is touched in a session (a snapshot write, list, or read), Bindars also
opportunistically tightens permissions on the `snapshots` directory tree
written by older versions; that pass is best-effort, runs at most once per
launch, and a failure there never blocks a new recovery write. If the
`snapshots` directory or its `v1` child has been replaced with a symlink,
Bindars leaves the link's target alone: snapshot writes, draft-stream
retirement, permission tightening, and "Clear recovery history" all refuse to
operate through it. Automatic snapshots show one visible warning, then retry
after 30 seconds with an exponential cooldown capped at 5 minutes rather than
writing through the link. A later successful snapshot resets the cooldown. A
symlink higher up — for example an app-data directory relocated to another
disk — is respected as usual. Windows relies on the operating system's per-user
app-data ACLs instead of Unix mode bits.

These permissions apply only to recovery data. Your real documents and exports
keep whatever permissions your system gives them.

## Retention and thinning

Within one document's stream, snapshots are thinned by age when a new snapshot
is written:

- everything from the last 10 minutes is kept;
- then one snapshot per 10-minute slot up to 1 hour old;
- then one per hour up to 1 day;
- then one per day up to 30 days;
- then one per week up to 90 days.

Two hard caps apply after thinning: at most 100 snapshots and at most 256 MiB
per stream (newest kept first).

**Age cleanup is opportunistic, not scheduled.** The 90-day rule runs only when
a later snapshot is written to the same stream. A stream you stop writing to —
for example, a document you never open again — can physically remain on disk
beyond 90 days, even though expired drafts are hidden from the recovery UI.
This is deliberate: Bindars prioritizes never destroying recovery history over
punctual expiry, and a background deleter that misfires (for example after a
forward clock jump) could silently delete useful history. Use the control below
when you want the data gone.

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

## Clearing recovery history

**Reader settings → Recovery** shows the logical size and stream count of
recovery data. It reads those totals only when settings opens, never follows
symlinks while counting, and says when skipped entries may make the total
incomplete. **"Clear recovery history…"** permanently deletes the entire
`snapshots/v1` tree for all documents, after an explicit confirmation. It never
touches your original documents, exports, or any other app data, and Cancel
changes nothing.

Clearing existing history does not disable recovery: if you keep editing, new
snapshots are created again — normally at the next automatic snapshot pass,
within about 10 seconds of continued typing — including for the document
currently open. A successful clear also resumes automatic snapshots that an
earlier write failure had placed in cooldown. The deletion is serialized with
the snapshot writer, so it cannot race an in-flight snapshot write; a snapshot
requested after the clear always observes the cleared state. On failure Bindars
reports the error and does not claim the history was cleared — some snapshots
may remain.

To remove recovery data for a machine you are decommissioning, clear the
history from the app or delete `snapshots/v1` yourself while Bindars is not
running. Note that deleted plaintext may still be recoverable from the storage
medium by forensic means; Bindars does not perform secure erasure.
