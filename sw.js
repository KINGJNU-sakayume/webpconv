// Service Worker for the WebP converter.
//
// Strategy:
// - PRECACHE: app shell + all vendor assets (FFmpeg core/wrapper/worker, JSZip).
//   This lets the page work offline AFTER the first successful install,
//   AND survives the user closing the tab — which is the part the previous
//   in-memory-only approach got wrong.
// - Cache-first for same-origin GETs, falling back to network.
// - Network-only for cross-origin (we don't want to cache CDN fallbacks; they
//   should only be tried when local is missing, and the local is always
//   pre-cached on install).
//
// To force clients to pick up new vendor files: bump CACHE_VERSION below.
// The activate handler purges old caches.

const CACHE_VERSION = 'v1';
const CACHE = `webp-converter-${CACHE_VERSION}`;

// Files needed for the app to RUN (small, must succeed atomically).
const SHELL_PRECACHE = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './lib/convertAnimated.js',
  './lib/convertStatic.js',
  './lib/detect.js',
  './lib/ui.js',
  './lib/zip.js',
  './vendor/ffmpeg/util.js',
  './vendor/ffmpeg/ffmpeg.js',
  './vendor/ffmpeg/814.ffmpeg.js',
  './vendor/jszip/jszip.min.js',
];

// Heavyweight engine files. Best-effort precache: if either of these fails on
// install (e.g., user is on a flaky connection), the SW activation should
// still succeed — the page will fall back to a network XHR when an animated
// file is dropped, and the runtime fetch handler below will cache it on the
// way through.
const VENDOR_PRECACHE = [
  './vendor/ffmpeg/ffmpeg-core.js',
  './vendor/ffmpeg/ffmpeg-core.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Shell is atomic — if any of these fail, the whole install fails and
    // the browser will retry it. We genuinely cannot run without them.
    await cache.addAll(SHELL_PRECACHE);
    // Vendor (the 31 MB wasm) is best-effort.
    await Promise.all(VENDOR_PRECACHE.map((url) =>
      cache.add(url).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[sw] vendor precache failed (will be cached on demand):', url, err && err.message);
      })
    ));
  })());
  // Take over from any previous SW immediately so the next page load uses
  // the freshly precached assets without a manual reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GETs.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — let cross-origin (CDN fallbacks, analytics, …) go
  // straight to the network without being cached.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      // Only cache successful, basic (same-origin) responses.
      if (fresh && fresh.ok && fresh.type === 'basic') {
        // clone() before consuming — Response bodies are single-use.
        cache.put(req, fresh.clone()).catch(() => { /* quota etc. */ });
      }
      return fresh;
    } catch (err) {
      // Truly offline AND not in cache — let the browser surface the error.
      throw err;
    }
  })());
});
