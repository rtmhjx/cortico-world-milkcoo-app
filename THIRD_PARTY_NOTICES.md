# Third-party notices

The Android 0.5.0 full-workbench variant additionally embeds the Tina workbench runtime
(the companion-only APK excludes it):
Node.js 24 for ARM64 Android, libc++ and Cortico 0.2.8 at commit
`ee6fb3e0b71d0c947942d855929f21eb08448ddd` (MIT), with a mobile Chat
provider and JavaScript module adaptation. Original license texts, source commit,
module hashes and adaptation details are included in the APK under
`assets/notices/`, `assets/runtime/UPSTREAM-MANIFEST.json` and the embedded
packages' license files. AndroidX Compose/Material and Kotlin notices are also
available in the offline handbook. No Coopanion desktop application, desktop
pet resources or third-party APK payload is copied into this distribution.

The locally generated pairing QR uses the `vendor/QRCode` component from
[`qrcode-terminal` 0.12.0](https://github.com/gtanner/qrcode-terminal),
distributed under Apache License 2.0. Its underlying QRCode for JavaScript
implementation is copyright Kazuhiko Arase and licensed under the MIT license.
Both license texts and source notices are included under
`src/vendor/qrcode-terminal/`. No pairing information is sent to a QR service.


## Starpost native Android frontend (0.6.0-dev.1)

The preloaded Android Starpost frontend is adapted from hth768/cortico-world-starpost, commit eff2d7704e33d7ffacca5406065f1c495daef134 (Android 1.10.3), under MIT. Original copyright and license are retained at Android assets/licenses/starpost-MIT.txt and in the source starpost/LICENSE.starpost.txt. Source mapping is in starpost/UPSTREAM-SOURCES.json.

Project Bloom game artwork and server data are not redistributed. Its entry is an author-supplied native frontend slot. The Bottle native module calls the existing Bottle World API; coverage is documented in the author guide.
