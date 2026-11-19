# DabbleCAD 1.0.1

A bug-fix release.

## Fixed

- **Grouping could freeze and crash the app.** Combining a shape with two or more
  overlapping holes of the same height (for example, two default cylinder holes on a
  stretched box) never finished and closed the window. Grouping now completes in a
  fraction of a second and produces a much lighter mesh.

## Changed

- DabbleCAD is now licensed under the Apache License 2.0. Version 1.0.0 remains
  available under the MIT License.
- A Linux x64 AppImage is now built alongside the Windows and Mac downloads.

DabbleCAD is an offline, open-source alternative to Tinkercad for 3D design and 3D
printing, with a laser workspace and depth-map tools alongside. It is an independent
project, not affiliated with or endorsed by Autodesk. Tinkercad is a trademark of
Autodesk, Inc.

## What's included

- Parametric 3D shapes, text, solid/hole operations, groups, transforms, and Scribble.
- Local design library, auto-save, explicit save controls, and unsaved-change prompts.
- 3D printing and sharing formats, including STL, OBJ, GLB, 3MF, SVG, and `.dabble`.
- A 2D laser workspace with layers, image engraving, path tools, preview, G-code
  export, and GRBL-compatible USB serial controls.
- Depth Map Studio with relief preview, levels, and PNG/slice-mask export.
- Blocks and Bricks views, dark/light themes, and software rendering fallback.

## Downloads

- `DabbleCAD-1.0.1-win-x64-setup.exe`: Windows installer.
- `DabbleCAD-1.0.1-win-x64.zip`: portable/no-install Windows app; extract everything.
- `DabbleCAD-1.0.1-mac-arm64.dmg` / `.zip`: Apple Silicon Mac.
- `DabbleCAD-1.0.1-mac-x64.dmg` / `.zip`: Intel Mac.
- `DabbleCAD-1.0.1-linux-x64.AppImage`: Linux x64.
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

This is an early release. Beveled text can produce non-manifold meshes, advanced
import features may need adjustment, and estimates are not calibrated material
settings. Inspect geometry in a slicer and laser paths/settings before use.
Follow your machine's safety instructions and never leave an operating laser
unattended.

Automated checks run offline against source and packaged apps. These checks do not
replace manual installation/launch checks, native window-close testing, or testing
on real laser hardware.

Please report reproducible bugs and share ideas through
[GitHub Issues](https://github.com/DJMcNewgent/DabbleCAD/issues).
