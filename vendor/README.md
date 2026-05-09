# Vendored third-party assets

This directory contains pre-built artifacts copied verbatim from the listed
upstream packages. They are bundled here (rather than fetched from a public
CDN at runtime) for reliability on iOS Safari mobile, where third-party CDN
hiccups historically caused the conversion engine to stall during loading.

| File | Source package | Version | Upstream URL |
|---|---|---|---|
| `ffmpeg/util.js` | `@ffmpeg/util` | `0.12.1` | https://www.npmjs.com/package/@ffmpeg/util |
| `ffmpeg/ffmpeg.js` | `@ffmpeg/ffmpeg` | `0.12.10` | https://www.npmjs.com/package/@ffmpeg/ffmpeg |
| `ffmpeg/814.ffmpeg.js` | `@ffmpeg/ffmpeg` | `0.12.10` | (worker chunk inside the package) |
| `ffmpeg/ffmpeg-core.js` | `@ffmpeg/core` | `0.12.10` | https://www.npmjs.com/package/@ffmpeg/core |
| `ffmpeg/ffmpeg-core.wasm` | `@ffmpeg/core` | `0.12.10` | (compiled WebAssembly) |
| `jszip/jszip.min.js` | `jszip` | `3.10.1` | https://www.npmjs.com/package/jszip |

## Licenses

- **`@ffmpeg/util`**, **`@ffmpeg/ffmpeg`**: MIT.
- **`@ffmpeg/core`** (which compiles FFmpeg to WebAssembly):
  LGPL-2.1-or-later, inheriting from FFmpeg and its bundled libraries
  (libx264 is GPL-2.0-or-later — we are NOT redistributing libx264 source
  here, only the compiled WASM, which is permitted under FFmpeg's standard
  build configuration).
- **`jszip`**: dual-licensed under MIT and GPL-3.0-or-later.

The full license texts are reproduced inside each upstream package's
`package.json` / `LICENSE` files; we keep redistributing under the same
terms. If you fork this repository, retain this notice.

## How to refresh these files

```sh
npm pack @ffmpeg/ffmpeg@0.12.10
npm pack @ffmpeg/util@0.12.1
npm pack @ffmpeg/core@0.12.10
npm pack jszip@3.10.1

# Then extract the dist/umd/* files into vendor/ffmpeg/ and the dist/jszip.min.js
# into vendor/jszip/. After updating, bump CACHE_VERSION in sw.js so existing
# clients pick up the new bytes.
```
