## Changes in 1.5.1

A reliability release. It changes no document or settings formats.

### Saving your work

- If another program changes a document while Bindars is saving it, Bindars keeps both versions and tells you. Previously one could silently replace the other.
- Saving no longer writes somewhere else if the document's file or folder is replaced or moved while the document is open. Bindars asks you to reopen the document or use **Save As**.
- New drafts and **Save As** never overwrite a file that already exists at the chosen name.
- On drives that cannot swap in a saved file in one step, Bindars now uses a safe fallback instead of failing to save. See Known limitations.
- Fewer false "changed outside Bindars" warnings right after your own saves.

### Highlights, notes, and bookmarks

- Saving a draft somewhere else no longer loses its highlights, notes, or bookmarks. Bindars keeps the original draft with them and tells you so.
- A new draft never picks up notes left behind by an older draft of the same name.

### Starting up

- If the settings file cannot be read, Bindars no longer replaces your preferences and recent files with defaults.
- A damaged saved session no longer stops the window from opening.
- If loading recent files or the last session is slow, the window becomes usable within a few seconds instead of staying blank.

### Reading

- Very long paragraphs and very large tables no longer freeze the app when you open them or index a folder that contains them. A 500 KB paragraph that took many seconds now opens in well under a second.
- Unusual screenplay (Fountain) files can no longer freeze the app, and screenplay passages containing lines with two spaces are no longer dropped.
- Links written in capitals, such as `HTTP://` or `MAILTO:`, now open. The same link safety rules still apply.
- Footnote and heading links whose names contain accented or special characters go to the right place.

## Known limitations

- Saving to drives formatted as exFAT (common on USB sticks and SD cards) and to network shares uses the fallback method above. It has had limited testing on real drives.
- A heading whose text matches a footnote's internal link name (for example `user-content-fn-1`) can capture that footnote's link.
- A quote block followed by tens of thousands of unmarked lines is still slow to open.

## Upgrading from 1.4.x

Read the [1.5.0 notes](https://github.com/tcraid0/Bindars/releases/tag/v1.5.0) about the new recent-history format and the removed recovery copies.

## Supported package

Linux is the currently supported release platform. This release contains an
x86_64 Debian package only.

The release workflow built, inspected, installed, and launched this package on
Ubuntu 22.04 before publication. Debian 12 or newer and current Linux Mint
releases are expected to work but have not received the same automated test.

AppImage and Arch package distribution remain paused until the AppImage's
bundled native libraries and corresponding-source requirements have a
repeatable compliance check. Windows and macOS binaries remain unpublished
while native release testing and code signing are pending.
