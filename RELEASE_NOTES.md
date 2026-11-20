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

## Plasma torch height and Z moves

- With a Z axis enabled under Device, plasma jobs handle torch height: optional
  **touch-off** before every pierce (`G38.2`), **pierce height**, **cut height**, a
  **safe travel height**, and commands to switch your controller's torch height
  control on after the pierce and off before the torch stops.
- Lasers with a Z axis get a **Z offset** and **Z step per pass** on each layer.

## New laser tools

- **Sub-layers:** up to three extra operations on one layer's shapes.
- **Start the cut here** and **Reverse cut direction** in the right-click menu.
- **Variable text:** `{serial}`, `{serial:4}`, `{date}`, `{time}`, and `{csv:1}` from a
  list you load. Numbers and rows move on after each job.
- **Text on a path:** bend text along any line or shape.
- **Halftone** and **newsprint** image modes, and **image masks** (engrave only the
  part of a picture inside a shape).
- **Print and cut:** pick two registration marks, jog the laser to each, and the job
  is moved, turned, and optionally scaled to match the printed sheet.
- **Camera overlay:** take or load a photo of the bed, mark its four corners, and
  the flattened picture appears under your design.
- **Rotary attachment:** roller or chuck, driven by the Y motor or an A axis.
- **Open LightBurn projects** (`.lbrn2` and `.lbrn`) with their layer settings.
- **Auto-join open paths**, **Delete duplicates**, **Select everything on this layer**,
  and a **Cut order** dialog.

## 3D design

- **Box-select picks up whatever it touches.** Dragging a selection box used to select only
  shapes that were completely inside it.
- **A group shows its result while you edit it.** Opening a group used to draw its parts
  separately, so holes looked as if they had stopped cutting. Now the finished shape
  stays visible and the parts appear as faint ghosts you can still move.

## Not verified

Everything in this release was checked in software only. Generated G-code was replayed
to confirm, for example, that the torch is off and at safe height for every travel
move, that each ignition is followed by its pierce dwell, and that pierce points fall
on scrap. LightBurn import was tested against real project files. Nothing was run on a
plasma table, a laser, a rotary, or with a real camera.

Before trusting it: dry-run plasma jobs with the torch disabled and confirm how your
controller treats `M3`, `M5`, `G4`, `G38.2`, and `G92`; check rotary scaling with a
measured test; confirm camera and print-and-cut alignment with a test mark.

DSP (Ruida-type) and galvo controllers are still not supported.

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
