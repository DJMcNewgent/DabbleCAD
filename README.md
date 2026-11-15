<p align="center"><img src="build/icon.png" alt="DabbleCAD icon" width="112"></p>

# DabbleCAD

**Easy 3D design for 3D printing, on your own computer.**

If you've used the popular beginner 3D design tools that only run in a web browser,
this will feel familiar: drag shapes onto a workplane, stretch and rotate them, turn
some into holes, group them into one part, and export an STL or 3MF for your slicer.
The difference is that DabbleCAD is a desktop app. It runs locally, your designs stay
on your computer, and it needs no account and no internet connection.

It also includes a laser workspace and depth-map tools, so you can keep making
without switching apps.

[Releases](https://github.com/DJMcNewgent/DabbleCAD/releases) ·
[Report a bug](https://github.com/DJMcNewgent/DabbleCAD/issues) ·
[Contribute](CONTRIBUTING.md)

## Why I built this

I'm a tinkerer. I kept jumping between different apps for the things I like to do,
and I wanted those tools together in one place.

DabbleCAD is my start at building that workspace. Right now, it brings together
3D design, laser work, and depth-map tools. The goal is to spend less time switching
apps and more time making things.

**This is just the start. More to come.**

— [DJMcNewgent](https://github.com/DJMcNewgent)

## Works offline

**The desktop app works without an internet connection**, including the installed
Windows app, the extracted portable ZIP, and the Mac app.

- Create and edit 3D and laser designs locally.
- Save your design library on your computer.
- Import and export local files, generate G-code, and use Depth Map Studio.
- Use bundled fonts or supported fonts already installed on your computer.
- Connect to a compatible laser over local USB serial; no cloud service is required.

No account or cloud service is required for these workflows. Internet is needed to
download the app or a new version, visit external links, and initially install
development dependencies or any device drivers your computer needs. There is no
automatic updater or cloud sync.

## Download and install

Published builds are attached to [GitHub Releases](https://github.com/DJMcNewgent/DabbleCAD/releases),
not GitHub's automatically generated **Source code** archives. Until the first
release is published, use the source instructions below.

Each release is configured to provide:

- **Windows x64 installer:** `DabbleCAD-VERSION-win-x64-setup.exe`.
  Run the installer and choose the installation folder.
- **Windows x64 portable ZIP:** `DabbleCAD-VERSION-win-x64.zip`.
  Extract the entire archive, then run `DabbleCAD.exe`. No installation is required;
  keep the other extracted files beside the executable.
- **Mac, Apple Silicon:** `DabbleCAD-VERSION-mac-arm64.dmg` and `.zip`.
- **Mac, Intel:** `DabbleCAD-VERSION-mac-x64.dmg` and `.zip`.
  Open the DMG and drag DabbleCAD to Applications, or extract the ZIP and move the
  `.app` bundle to Applications. Choose the build matching **About This Mac**.
- **Checksums:** `SHA256SUMS.txt` for verifying the six downloads.

These initial builds do **not** have a trusted publisher signature or Apple
notarization. Windows SmartScreen and macOS Gatekeeper may warn or block launch.
Mac builds use an ad-hoc signature, not a verified Developer ID. Only use downloads
from this repository and compare their checksums. Do not disable your computer's
security protections globally; see [release guidance](RELEASING.md#unsigned-builds).

### Where designs live

Desktop designs and settings are stored in your operating system's application-data
folder. Open **Your designs → Library folder** to locate your saved designs.
Export `.dabble` files for backups or moving work to another computer.

**Portable means no installer**, not portable storage: the Windows ZIP still uses
the computer's application-data folder. Copying only the app folder does not copy
your design library. In browser development mode, designs use that browser's local
storage instead and are separate from the desktop library.

## What you can do

### 3D design

- 60+ parametric shapes, text, letters, numbers, starter models, and saved creations.
- Solid, hole, transparent, and multicolor objects.
- Union, intersection, bundles, and ungrouping.
- Resize, rotate, lift, mirror, align, and type exact dimensions.
- Workplanes on faces, a ruler, notes, patterns, duplicate-and-repeat, and Cruise.
- Freehand Scribble shapes with extrusion.
- Blocks and Bricks views.
- Size, volume, and weight estimates.

**Import:** STL, OBJ, GLB/glTF, 3MF, PLY meshes, SVG, PNG/JPG, and `.dabble`.
**Export:** STL, 3MF, OBJ, GLB, SVG outlines, PNG pictures, and `.dabble`.
Some complex file features may not be preserved; inspect imported geometry.

### Laser workspace

Switch to **Laser** at the top of the app. The laser workspace is saved with the
same design as your 3D work.

- Draw and edit lines, curves, rectangles, ellipses, polygons, text, and images.
- 30 color layers plus two tool layers; Line, Fill, and Offset Fill modes.
- Speed, power, passes, interval, scan angle, cross-hatch, overscan, kerf, tabs,
  and air-assist settings.
- Weld, subtract, intersect, exclude, offset, arrays, trace, align, distribute,
  flip, and rotate.
- Image engraving with threshold, dithering, and grayscale options.
- QR codes, material tests, interval tests, and outlines from the 3D workspace.
- Preview, estimated job time, G-code export, and USB serial controls for
  GRBL-compatible machines.
- SVG, DXF, and image import; SVG, DXF, and G-code export.

Set the work area, origin, and controller under **Device**. Software tests do not
certify compatibility with every controller or machine. Inspect generated paths
and settings, follow your laser manufacturer's safety instructions, and never
leave an operating laser unattended.

### Depth Map Studio

Create a height map from an STL, an image, or the current 3D design. Adjust levels,
gamma, output range, smoothing, and inversion; inspect a 3D relief preview; get
slice/spot-size guidance; and export 16-bit PNG, 8-bit PNG, or slice masks.
Suggested material settings are starting points, not calibrated guarantees.

## Saving

`Ctrl+S` (or `Cmd+S` on Mac) saves the design and its laser workspace, even with
auto-save off.

With auto-save off and unsaved changes, DabbleCAD asks **Save / Don't save / Cancel**
before opening the dashboard, switching or creating designs, deleting the current
design, restarting from Settings, or closing the desktop app. Cancel preserves your
current edits; a failed save stops the transition. Don't save leaves the saved copy
unchanged, except that deleting a design still removes that copy.

## Navigation

- **Orbit:** right-drag, or Ctrl + left-drag.
- **Pan:** middle-drag, or Shift + right-drag.
- **Zoom:** scroll wheel, `+`, or `-`.
- **Fit / Home:** `F` / `Home`.
- **Perspective / orthographic:** `O`.
- **View cube:** click a face or drag it.

Press `?` for the full shortcut list. Dark and light themes, graphics settings,
shadows, and edge display are available in Settings. If the graphics driver crashes
repeatedly, the app can fall back to software rendering.

## Run from source

Requires **Node.js 24.x**, npm, and a desktop session. Node.js is not needed to run
a downloaded release.

```sh
git clone https://github.com/DJMcNewgent/DabbleCAD.git
cd DabbleCAD
npm ci
npm start
```

- `npm run dev`: browser development at `http://localhost:5183`.
- `npm run build`: build the renderer.
- `npm run test:all`: run all five functional suites with HTTP/WebSocket requests blocked.
- `npm run package:win`: Windows installer and portable ZIP; run on Windows.
- `npm run package:mac`: Intel and Apple Silicon DMG/ZIP builds; run on macOS.
- `npm run test:packaged`: run the same offline suites against the packaged app
  for the host architecture.

Build output goes in `release/VERSION/`. See [RELEASING.md](RELEASING.md) for CI,
checksums, unsigned builds, and the public-release checklist.

## Project status and limitations

DabbleCAD is an early project, not a claim of production certification.

- Beveled text can produce non-manifold meshes. Avoid beveling text for printable
  solids and inspect exported meshes in a slicer.
- Complex imported geometry and advanced SVG/DXF/3MF features need inspection.
- Estimates and suggested laser settings are not material-specific calibration.
- Real laser hardware, native close dialogs, installation, and operating-system
  trust prompts need manual testing in addition to automated tests.
- Mac release builds must pass the macOS CI jobs and manual launch checks before
  being treated as verified downloads.

Bug reports, reproducible examples, documentation improvements, and feature ideas
are welcome. Please remove private designs and personal information before sharing
files publicly. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License and credits

Created by [DJMcNewgent](https://github.com/DJMcNewgent).
Licensed under the [MIT License](LICENSE).

Built with Electron, Three.js, three-mesh-bvh, three-bvh-csg, OpenType.js,
Clipper, QR Code Generator, and Roboto. See
[third-party notices](THIRD_PARTY_NOTICES.md) for component licenses.
