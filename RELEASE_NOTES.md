# DabbleCAD 1.1.0

A feature release: more reliable solids for 3D printing, new modelling tools, and
new laser tools.

## 3D design

- **Watertight groups.** Grouping now runs on a solid-modelling kernel (Manifold), so
  combined shapes are closed, printable meshes. Large groups are several times faster.
- **Edit inside a group.** Double-click a group, change or add parts, press Done.
- **Round or bevel edges** of any shape or group from the Edges section.
- **Sketch.** Draw rectangles, circles, and polygons with typed sizes and cut-outs,
  then pull the outline into 3D.
- **Generators** in real millimetres: bolt, nut, standoff, hinge, snap clip, and a
  box with a fitted lid.
- **Print check.** Finds open meshes, floating parts, thin walls, overhangs, and
  designs that do not fit your printer bed.
- **Open in slicer**, and STL export that fuses overlapping shapes into one solid.
- Bevelled text is now a closed solid (previously it could export broken meshes).
- A getting-started guide on first launch.

## Laser

- **Box maker** for finger-jointed boxes.
- **Material library** for your own saved speed and power settings.
- **Depth-map slice passes:** engrave a relief pass by pass, one layer per slice.

## Other

- Icon buttons, dialogs, menus, and the shape panel now work with the keyboard and
  announce themselves to screen readers.
- The app can tell you when a newer release exists. This is one anonymous request to
  GitHub at start-up; turn it off under Settings → Updates to stay fully offline.

## Not verified

The new tools pass automated checks only. Nothing here has been printed or laser-cut:
test generator fits, box-maker kerf, and slice-pass settings on scrap material first.
"Open in slicer" has not been tried against a real slicer install.

DabbleCAD is an offline, open-source alternative to Tinkercad for 3D design and 3D
printing, with a laser workspace and depth-map tools alongside. It is an independent
project, not affiliated with or endorsed by Autodesk. Tinkercad is a trademark of
Autodesk, Inc.

## Downloads

- `DabbleCAD-1.1.0-win-x64-setup.exe`: Windows installer.
- `DabbleCAD-1.1.0-win-x64.zip`: portable/no-install Windows app; extract everything.
- `DabbleCAD-1.1.0-mac-arm64.dmg` / `.zip`: Apple Silicon Mac.
- `DabbleCAD-1.1.0-mac-x64.dmg` / `.zip`: Intel Mac.
- `DabbleCAD-1.1.0-linux-x64.AppImage`: Linux x64.
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
