# Installing Bindars

[Back to the README](../README.md) · [Using Bindars](usage.md)

## macOS (Apple Silicon)

Download [Bindars 1.6.4 for Mac](https://github.com/tcraid0/Bindars/releases/download/v1.6.4/Bindars_1.6.4_aarch64.dmg),
open the DMG, and drag **Bindars** into **Applications**. Open Bindars from there;
macOS may show its normal first-open confirmation for an internet download.
Do not disable Gatekeeper or bypass a security block to install it.

- Apple Silicon only; Intel Macs are not supported by this download.
- Requires macOS 15.0 or newer. The signed app was tested interactively on
  macOS 26.6.2. macOS 15 has automated source/build coverage; its signed-app GUI
  behavior has not been verified.
- Updates are manual: quit Bindars, download the new DMG, and replace the app
  in Applications. Keep a backup of your documents and [Bindars data](recovery-and-privacy.md)
  before upgrading. This update introduces no new document or annotation format.
- Clean-account, first-use folder-permission, and logout/shutdown tests remain
  pending. The release notes record the tested scope and known limitations.
- At extreme interface zoom with the sidebar open, the reading pane can require
  horizontal scrolling. This existing behavior was reproduced at 300% in both
  1.6.3 and 1.6.4; Recent details stay within the window.

The [release](https://github.com/tcraid0/Bindars/releases/tag/v1.6.4) includes
`SHA256SUMS-macos.txt` for checking the download. Save it beside the DMG, open
Terminal in that folder, and run:

```bash
shasum -a 256 -c SHA256SUMS-macos.txt
```

Notarization is Apple's automated security check, not a Mac App Store review.

## Linux support

Bindars currently publishes an x86_64 Debian package. Before publication, the
release workflow inspects the package, installs it, and launches it on Ubuntu
22.04. Debian 12 or newer and current Linux Mint releases are expected to work
but do not receive the same automated test.

## Debian / Ubuntu / Linux Mint

Download the `.deb` from the [latest release](https://github.com/tcraid0/Bindars/releases/latest) and install:

```bash
sudo apt install ./Bindars_*_amd64.deb
```

## Other Linux distributions

AppImage and Arch package distribution are paused while the project adds a
repeatable compliance check for bundled native libraries. Other Linux users
may build from source, but those builds are not official release artifacts.

Windows downloads remain pending native testing and code signing.

For a local build, see [Build from source](../README.md#build-from-source).
