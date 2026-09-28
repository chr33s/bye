# Third-party notices

Bye is released under the MIT License (see [`LICENSE`](./LICENSE)). It depends on third-party packages that keep their own licenses; their notices ship inside each package in `node_modules` and are not reproduced here.

## Code copied into this repository

- `demo-reel/src/components/remocn/` is adapted from [Remocn/remocn](https://github.com/Remocn/remocn) (MIT). The full notice is in [`demo-reel/THIRD_PARTY_NOTICES.md`](./demo-reel/THIRD_PARTY_NOTICES.md).

## Dependency license review

Reviewed 2026-09-28 with `pnpm licenses list` (workspace) and `license-checker` (`apps/mobile`, `apps/desktop`). Every dependency is under a license compatible with distributing Bye under MIT:

- **Permissive:** MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, MIT-0, BlueOak-1.0.0, Python-2.0, CC0-1.0, CC-BY-4.0 (data only).
- **Weak copyleft, build and test tooling only, not shipped in Bye's bundles:** MPL-2.0 (`axe-core`, `lightningcss`) and LGPL-3.0-or-later (`@img/sharp-libvips-*`, a native binary loaded by `sharp`).

Rerun the review when dependencies change, and record any new copyleft license here before release.

## Trademarks and assets

HEY is a trademark of 37signals. Bye is an independent project inspired by HEY's public feature set. The MIT License covers Bye's own code and assets only. It grants no rights to HEY or 37signals trademarks, branding, trade dress or proprietary assets, and the repository contains none of them. App icons, `apps/web/public/icon*`, and `design.pdf` ("Bye logo & site") are Bye's own designs.
