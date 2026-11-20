# Installing Bindars

[Back to the README](../README.md) · [Using Bindars](usage.md)

## macOS (Apple Silicon)

Download [Bindars 1.7.1 for Mac](https://github.com/tcraid0/Bindars/releases/download/v1.7.1/Bindars_1.7.1_aarch64.dmg),
open the DMG, and drag **Bindars** into **Applications**. Open Bindars from there;
macOS may show its normal first-open confirmation for an internet download.
Do not disable Gatekeeper or bypass a security block to install it.

- Apple Silicon only; Intel Macs are not supported by this download.
- Requires macOS 15.0 or newer. The signed app was tested interactively on
  macOS 26.6.2. macOS 15 has automated source/build coverage; its signed-app GUI
  behavior has not been verified.
- Bindars 1.7.1 introduces no new document or annotation format.
- Clean-account, first-use folder-permission, and logout/shutdown tests remain
  pending. The release notes record the tested scope and known limitations.
- At extreme interface zoom with the sidebar open, the reading pane can require
  horizontal scrolling. This existing behavior was reproduced at 300% in both
  1.6.3 and 1.6.4; Recent details stay within the window.

The [release](https://github.com/tcraid0/Bindars/releases/tag/v1.7.1) includes
`SHA256SUMS-macos.txt` for checking the download. Save it beside the DMG, open
Terminal in that folder, and run:

```bash
shasum -a 256 -c SHA256SUMS-macos.txt
```

Notarization is Apple's automated security check, not a Mac App Store review.

### Updating on Mac

If you're on 1.7.x, download the first version with in-app updates from the
[download page](https://github.com/tcraid0/Bindars/releases/latest). Quit Bindars
and replace it in Applications with the copy from the new DMG. You can still
update this way later. Back up your documents and [Bindars data](recovery-and-privacy.md)
before upgrading.

In a version with in-app updates, choose **Bindars → Check for Updates…** any
time. If an update is ready, choose **Install and Restart**. If you're running
Bindars from the DMG, move it to Applications to update from inside the app.

Automatic checks are off by default. On a later launch, Bindars asks once if
you'd like it to check about once a day. You can change your answer in the
Updates dialog. Checks and downloads contact only GitHub. Your documents are
never sent.

## Linux support

Bindars currently publishes an x86_64 Debian package. Before publication, the
release workflow inspects the package, installs it, and launches it on Ubuntu
22.04. Debian 12 or newer and current Linux Mint releases are expected to work
but do not receive the same automated test.

## Debian / Ubuntu / Linux Mint

To install or update on Linux, download the `.deb` from the
[download page](https://github.com/tcraid0/Bindars/releases/latest) and run:

```bash
sudo apt install ./Bindars_*_amd64.deb
```

## Other Linux distributions

AppImage and Arch package distribution are paused while the project adds a
repeatable compliance check for bundled native libraries. Other Linux users
may build from source, but those builds are not official release artifacts.

Windows downloads remain pending native testing and code signing.

For a local build, see [Build from source](../README.md#build-from-source).
