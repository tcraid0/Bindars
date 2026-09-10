## Changes in 1.4.4

- Preserve saved preferences and recent files when startup reads fail or finish late.
- Prevent interrupted history upgrades from changing saved sections again after restart.
- Preserve reading position when leaving the editor and restore keyboard focus after editing or search.
- Keep restored drafts protected as unsaved work and show clearer snapshot-recovery guidance.
- Respect IME input and presentation controls, keep focused mode controls visible, and avoid unnecessary annotation writes.

## Recent-history compatibility

Recent-file history now stores its format version with its entries. Bindars converts the older format automatically when it can read and save it successfully. Documents and annotations are unchanged.

Older builds may not read this new history format; some earlier builds may replace the list when opening a file. Back up settings before downgrading if you need to preserve recent files and saved sections. This change does not guarantee settings-file durability through a crash or power loss.

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
