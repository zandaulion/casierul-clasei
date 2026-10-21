# Third-party components

This source kit is based on the public Casierul clasei source at commit
`3ecd2d2e4bf5f2e41c9dfffe217a2f401d6488bc`. Its original application
code and release documentation are licensed GPL-3.0-or-later; see `LICENSE`.

`web/vendor/pdfjs/` contains PDF.js 4.10.38 browser modules, under Apache
License 2.0. Its complete license is in `web/vendor/pdfjs/LICENSE`.

`assets/fonts/` contains DejaVu Sans fonts. Their complete terms and upstream
copyright notices are in `assets/fonts/DejaVu-LICENSE.txt`.

Docker builds fetch the dependencies pinned by `package-lock.json` from the
npm registry. They retain their separate licenses and are not inside this
source archive. `web/pwa-update.js` and `web/sw-update.js` adapt the original
[pwa-kit](https://github.com/zandaulion/pwa-kit) update mechanism, whose
[v0.1.0 release](https://github.com/zandaulion/pwa-kit/releases/tag/v0.1.0)
documents GPL-3.0-or-later for that code.
