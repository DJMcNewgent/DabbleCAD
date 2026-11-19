# DabbleCAD 1.2.0

## New: update from inside the app

**Settings → Updates → Check for updates** (also in the About dialog) looks for a newer
release on GitHub, downloads the build for your computer, verifies it against the
release's SHA-256 list, and installs it. Your designs and settings are kept.

- **Windows, installed:** installs over the current copy and restarts the app.
- **Windows, portable ZIP:** downloads the new ZIP and shows it in its folder.
- **Mac:** opens the disk image so you can drag the new app into Applications.
- **Linux AppImage:** replaces the AppImage and restarts.

The start-up notice about new versions now offers "Update now".

This is the first version with the updater, so it can only update to versions
released after it. If you are on 1.1.0 or older, download this release by hand once.

## Also in this release

- Bevelled text that would leave invalid mesh edges is reduced automatically, and
  collapsed facets are left out of STL files (thanks to @swpswpswp).

## How this was tested

On Windows, the full path was run for real against a published release: an installed
copy found the newer version, downloaded it, verified its checksum, installed it
silently, and restarted on the new version with settings and designs untouched.

The Mac, Linux, and portable-ZIP paths share the same check, download, and verify
steps, but their final step has not been exercised. If an update does not complete,
download the new version from the release page; your designs and settings are unaffected.

DabbleCAD is an offline, open-source alternative to Tinkercad for 3D design and 3D
printing, with a laser workspace and depth-map tools alongside. It is an independent
project, not affiliated with or endorsed by Autodesk. Tinkercad is a trademark of
Autodesk, Inc.

## Downloads

- `DabbleCAD-1.2.0-win-x64-setup.exe`: Windows installer.
- `DabbleCAD-1.2.0-win-x64.zip`: portable/no-install Windows app; extract everything.
- `DabbleCAD-1.2.0-mac-arm64.dmg` / `.zip`: Apple Silicon Mac.
- `DabbleCAD-1.2.0-mac-x64.dmg` / `.zip`: Intel Mac.
- `DabbleCAD-1.2.0-linux-x64.AppImage`: Linux x64.
- `SHA256SUMS.txt`: checksums for these seven files.

**All desktop variants work offline once downloaded.** Normal editing, local
saving, import/export, depth maps, and local USB serial use need no account or
cloud connection. Downloads, external links, and development setup need internet.
The Windows ZIP uses the normal application-data folder; it does not carry the
design library with the app.

## Important before using

The Intel Mac build is untested: the automated checks could not run on an Intel Mac,
and it has not been launched on one. The Windows and Apple Silicon builds pass the
automated checks. Turning off GPU acceleration in Settings is supported on Windows
only; on a Mac the app needs a working GPU.

These builds are unsigned by a trusted publisher and are not Apple-notarized.
Mac bundles use an ad-hoc signature. Windows/macOS may show trust warnings or block
launch. Use only the official release and verify checksums; do not globally disable
security protections.

This is an early release. Advanced import features may need adjustment, and estimates are not calibrated material
settings. Inspect geometry in a slicer and laser paths/settings before use.
Follow your machine's safety instructions and never leave an operating laser
unattended.

Automated checks run offline against source and packaged apps. These checks do not
replace manual installation/launch checks, native window-close testing, or testing
on real laser hardware.

Please report reproducible bugs and share ideas through
[GitHub Issues](https://github.com/DJMcNewgent/DabbleCAD/issues).
