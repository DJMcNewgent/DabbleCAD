# Contributing to DabbleCAD

Thanks for helping make this a useful workspace for tinkerers. Bug fixes,
documentation, accessibility improvements, and practical feature ideas are welcome.
Keep discussion constructive and respectful.

## Report a bug

Use the GitHub bug-report template. Include the app version, operating system and
CPU architecture, installed/ZIP/source build, steps to reproduce, expected result,
and actual result. For geometry or import bugs, a small example is especially useful.

Only attach files you are allowed to share. Remove personal information, private
designs, local paths, and secrets from screenshots and logs. Do not put security
vulnerability details in a public issue; see [SECURITY.md](SECURITY.md).

For laser issues, include the controller/firmware and relevant settings, but do
not reproduce unsafe machine behavior just to collect a report.

## Suggest a feature

Describe the thing you are trying to make and the friction in your current workflow.
Explain how it fits the goal of bringing tinkering tools together. For substantial
changes, discuss the approach in an issue before writing a large pull request.

## Development

Use Node.js 24.x and the committed npm lockfile:

```sh
npm ci
npm start
npm run test:all
```

The functional tests use isolated temporary design libraries, software rendering,
and blocked HTTP/WebSocket requests. They do not operate real laser hardware. The save
suite deliberately logs simulated save failures while checking that edits survive.
Failures must produce a nonzero process exit code.

Targeted commands are `npm test`, `npm run test:laser`, `npm run test:depth`, and
`npm run test:save`. For release-related changes, also build and test the packaged app:

```sh
npm run package:win
npm run test:packaged
```

Use `npm run package:mac` on a Mac. See [RELEASING.md](RELEASING.md) for both architectures.

## Code layout

- `electron/`: desktop main process, persistence, native dialogs, preload bridge.
- `src/renderer/core/`: document model, geometry, shapes, fonts, import/export.
- `src/renderer/view/`: viewport, gizmos, view cube, voxel views.
- `src/renderer/ui/`: panels and dialogs.
- `src/renderer/laser/`: 2D editor, planning, laser device support, depth maps.
- `tools/`: launcher and functional tests.

Keep patches focused. Follow surrounding JavaScript conventions, preserve existing
designs and save behavior, and add a regression test when fixing a behavior bug.
Do not introduce network requirements for normal desktop editing. Update the README
or release notes when user-visible behavior changes.

Commit source, build configuration, small original assets, and the lockfile.
Do not commit generated release binaries, dependencies, personal designs,
credentials, certificates, or local configuration.

## Pull requests

Explain the problem, the change, and the checks you ran. For UI changes, screenshots
can help; for platform-specific work, state which OS/architecture you actually tested.
Do not describe a build as tested on a platform you did not run.

By contributing, you agree that your contributions may be distributed under this
project's MIT license. Preserve third-party notices and update them when adding or
changing bundled components.
