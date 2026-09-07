# Vendored libraries

These are bundled into the repo instead of loaded from a CDN, on purpose:
two-phone pairing depends on all three, and a CDN script tag can be silently
blocked by a content blocker, a school/corporate/carrier network filter, or a
browser privacy mode — which would break pairing completely with no visible
error to debug from. Vendoring removes that failure mode entirely.

| File | Package | Version | Notes |
|---|---|---|---|
| `pako.min.js` | [pako](https://www.npmjs.com/package/pako) | 1.0.11 | Compresses the WebRTC offer/answer so it fits a denser, more scannable QR code. Optional at runtime — `js/sync.js` falls back to uncompressed if `window.pako` is missing. |
| `qrcode.min.js` | [qrcode-generator](https://www.npmjs.com/package/qrcode-generator) | 2.0.4 | Draws the pairing QR codes. **Patched**: the published UMD wrapper only handles AMD and CommonJS, so loaded via a plain `<script>` tag (no module system) it silently defines nothing at all — `window.qrcode` would never exist. A browser-global fallback branch was added to the wrapper; the library code itself is untouched. |
| `jsQR.min.js` | [jsqr](https://www.npmjs.com/package/jsqr) | 1.4.0 | Reads a QR code from a camera frame, for the in-app scanner. Unmodified — its UMD wrapper already handles a plain `<script>` tag correctly. |

To update one: `npm view <package> version` to check the latest, install it
into a scratch directory (`npm i <package>` there, not in this repo — these
are not npm dependencies of the app), and copy the browser build back over
the matching file here.
