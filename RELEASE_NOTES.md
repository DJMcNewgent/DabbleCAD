# DabbleCAD 1.3.0

## Plasma cutting and better cut starts

Line layers in the laser workspace gain the settings that plasma cutting and thick
material need:

- **Lead-in and lead-out.** Each closed cut starts and ends on the scrap side: outside
  a part, inside a hole. Leads can be arcs that meet the outline smoothly or straight
  lines at 45°. A lead that will not fit (for example inside a very small hole) is
  shortened, or left out with a warning. Cuts with leads start mid-edge, not on a corner.
- **Pierce delay.** The beam or torch fires in place for the time you set before moving.
- **Overcut** past the start point, and **perforation** (cut / skip lengths).
- **Plasma cutter controller** under Device: torch on (`M3`), pierce dwell (`G4`), cut
  moves with no power words, torch off (`M5`) before every travel move.

Leads show in blue in the job preview. All of these are saved with material presets.

## New laser tools

- **Auto-join open paths:** joins pieces whose ends touch, for example lines from a DXF.
- **Delete duplicates:** removes shapes stacked on identical shapes, which would be cut twice.
- **Select everything on this layer**, and a **Cut order** dialog (inner shapes first,
  reduce travel, finish one layer before the next).

## Not verified

The plasma and lead-in output was checked by replaying the generated G-code in
software: the torch is off for every travel move, each ignition is followed by its
pierce dwell, and pierce points fall on scrap. It has not been run on a plasma table or
a laser. There is no torch height control or touch-off. Dry-run a job with the torch
disabled first, and confirm how your controller treats `M3`, `M5`, and `G4`.

Update from 1.2.0 with **Settings → Updates → Check for updates**.

DabbleCAD is an offline, open-source alternative to Tinkercad for 3D design and 3D
printing, with a laser workspace and depth-map tools alongside. It is an independent
project, not affiliated with or endorsed by Autodesk. Tinkercad is a trademark of
Autodesk, Inc.

## Downloads

- `DabbleCAD-1.3.0-win-x64-setup.exe`: Windows installer.
- `DabbleCAD-1.3.0-win-x64.zip`: portable/no-install Windows app; extract everything.
- `DabbleCAD-1.3.0-mac-arm64.dmg` / `.zip`: Apple Silicon Mac.
- `DabbleCAD-1.3.0-mac-x64.dmg` / `.zip`: Intel Mac.
- `DabbleCAD-1.3.0-linux-x64.AppImage`: Linux x64.
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
