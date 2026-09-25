# Arch Linux packaging

Official Arch Linux packaging is paused. The previous `PKGBUILD` repackaged the
AppImage, which the release workflow no longer publishes.

Do not restore that package until the AppImage release gate inventories every
bundled native library and verifies the applicable source-access requirements.
Git history retains the old recipe for reference.
