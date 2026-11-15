# DabbleCAD 1.0.0

The first release of DabbleCAD: an offline, open-source alternative to Tinkercad for
3D design and 3D printing, with a laser workspace and depth-map tools alongside. It
runs locally, and no account or internet connection is needed to use it.

DabbleCAD is an independent project, not affiliated with or endorsed by Autodesk.
Tinkercad is a trademark of Autodesk, Inc.

> I'm a tinkerer. I kept jumping between different apps for the things I like to
> do, and I wanted those tools together in one place. This is just the start.
> More to come.
>
> — DJMcNewgent

## What's included

- Parametric 3D shapes, text, solid/hole operations, groups, transforms, and Scribble.
- Local design library, auto-save, explicit save controls, and unsaved-change prompts.
- 3D printing and sharing formats, including STL, OBJ, GLB, 3MF, SVG, and `.dabble`.
- A 2D laser workspace with layers, image engraving, path tools, preview, G-code
  export, and GRBL-compatible USB serial controls.
- Depth Map Studio with relief preview, levels, and PNG/slice-mask export.
- Blocks and Bricks views, dark/light themes, and software rendering fallback.

## Downloads

- `DabbleCAD-1.0.0-win-x64-setup.exe`: Windows installer.
- `DabbleCAD-1.0.0-win-x64.zip`: portable/no-install Windows app; extract everything.
- `DabbleCAD-1.0.0-mac-arm64.dmg` / `.zip`: Apple Silicon Mac.
- `DabbleCAD-1.0.0-mac-x64.dmg` / `.zip`: Intel Mac.
- `SHA256SUMS.txt`: checksums for these six files.

**All desktop variants work offline once downloaded.** Normal editing, local
saving, import/export, depth maps, and local USB serial use need no account or
cloud connection. Downloads, external links, and development setup need internet.
The Windows ZIP uses the normal application-data folder; it does not carry the
design library with the app.

## Important before using

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
