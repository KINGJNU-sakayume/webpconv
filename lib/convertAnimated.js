// Animated WebP → MP4 (H.264) via ffmpeg.wasm single-thread.
// Uses CDN-loaded UMD globals: window.FFmpegWASM, window.FFmpegUtil.
//
// Loading strategy:
// 1. Self-hosted assets in ./vendor/ffmpeg/ are tried FIRST. Same-origin, cached
//    by the Service Worker, brotli-compressed by GitHub Pages. No CDN flakiness.
// 2. Public CDNs (jsdelivr, unpkg) remain only as last-resort fallbacks for
//    the unlikely case that vendor files were not deployed.
//
// iOS Safari quirks handled:
// 1. Default worker resolution can construct a cross-origin classic Worker
//    which iOS sometimes silently rejects → we pre-fetch 814.ffmpeg.js as a
//    Blob URL and pass it as classWorkerURL.
// 2. fetch() + ReadableStream progress is flaky on iOS → XHR has battle-tested
//    progress events.
// 3. Mobile networks can be very slow OR briefly stall → we use a STALL
//    timeout (resets on every progress event), not an absolute one. A normal
//    25–31 MB download on slow LTE is no longer killed at 60 s.
// 4. When the response is gzip/br-encoded, lengthComputable can be false →
//    we still show a meaningful "X.Y MB received" text in the detail line.

const ASSET_BASES = {
  ffmpeg: [
    './vendor/ffmpeg',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd',
    'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd',
  ],
  core: [
    './vendor/ffmpeg',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd',
    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd',
  ],
};
const FFMPEG_WORKER_CHUNK = '814.ffmpeg.js';

// Wall-clock cap for the entire ffmpeg.load() call — generous; we mostly rely on stall.
const LOAD_TIMEOUT_MS = 600_000; // 10 minutes
// "Stall" = no progress event received for this long. Resets on every chunk.
const XHR_STALL_MS = 30_000;
// Absolute per-XHR cap (defense in depth).
const XHR_HARD_LIMIT_MS = 600_000;
const FETCH_ATTEMPTS = 2; // per source; each source already retried via the list
const FETCH_RETRY_DELAY_MS = 1500;

const MSG_NO_FFMPEG = '변환 엔진을 사용할 수 없습니다';
const MSG_LOAD_FAIL = '변환 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요';
const MSG_LOAD_TIMEOUT = '변환 엔진 초기화 시간이 너무 오래 걸립니다. 페이지를 새로고침한 뒤 다시 시도해주세요';
const MSG_CONVERT_FAIL = '변환에 실패했습니다';
const MSG_STALLED = '진행이 멈췄습니다 (네트워크가 느리거나 끊긴 것 같습니다)';

const STATUS = {
  workerDownloading: '워커 다운로드 중',
  coreDownloading: '코어 다운로드 중',
  wasmDownloading: '엔진 다운로드 중',
  initializing: '초기화 중 (최대 1~2분 소요)',
  ready: '준비 완료',
};

let ffmpegInstance = null;
let loadPromise = null;
let loadProgressCb = null;
let loadStatusCb = null;
let loadDetailCb = null;
let createdBlobURLs = [];

function getGlobals() {
  const wasm = window.FFmpegWASM;
  const util = window.FFmpegUtil;
  if (!wasm || !util || !wasm.FFmpeg) {
    throw new Error(MSG_NO_FFMPEG);
  }
  return { wasm, util };
}

export function isFFmpegReady() {
  return Boolean(ffmpegInstance);
}

export function onLoadProgress(cb) { loadProgressCb = cb; }
export function onLoadStatus(cb) { loadStatusCb = cb; }
export function onLoadDetail(cb) { loadDetailCb = cb; }

function reportLoad(value) {
  if (loadProgressCb) loadProgressCb(Math.max(0, Math.min(1, value)));
}

function reportStatus(text) {
  if (loadStatusCb) loadStatusCb(text);
}

function reportDetail(text) {
  if (loadDetailCb) loadDetailCb(text || '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// XHR fetcher with stall-timeout (resets on every onprogress) and a hard cap.
// Reports received bytes in detail line so the user can tell that something
// is happening even when lengthComputable === false.
function xhrFetchBlobURL(url, mime, fromPct, toPct, label) {
  return new Promise((resolve, reject) => {
    let xhr;
    try {
      xhr = new XMLHttpRequest();
    } catch (err) {
      reject(new Error('XMLHttpRequest 생성 실패'));
      return;
    }
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';

    let stallTimer = null;
    let hardTimer = null;
    let settled = false;

    const cleanup = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (hardTimer)  { clearTimeout(hardTimer);  hardTimer = null;  }
    };
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { xhr.abort(); } catch (_) { /* ignore */ }
        reject(new Error(MSG_STALLED));
      }, XHR_STALL_MS);
    };

    armStall();
    hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try { xhr.abort(); } catch (_) { /* ignore */ }
      reject(new Error('전체 다운로드 시간 초과'));
    }, XHR_HARD_LIMIT_MS);

    xhr.onprogress = (event) => {
      armStall();
      if (event.lengthComputable && loadProgressCb && toPct > fromPct && event.total > 0) {
        const slice = fromPct + (event.loaded / event.total) * (toPct - fromPct);
        reportLoad(slice);
        reportDetail(`${label} ${formatMB(event.loaded)} / ${formatMB(event.total)}`);
      } else {
        // gzip/br responses can hide total — still surface the bytes received.
        reportDetail(`${label} ${formatMB(event.loaded)} 받는 중`);
      }
    };

    xhr.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        const blob = new Blob([xhr.response], { type: mime });
        const blobURL = URL.createObjectURL(blob);
        createdBlobURLs.push(blobURL);
        reportLoad(toPct);
        reportDetail('');
        resolve(blobURL);
      } else {
        reject(new Error(`HTTP ${xhr.status || 'error'}`));
      }
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('네트워크 오류'));
    };
    xhr.onabort = () => {
      // Settled by the timer that triggered the abort. Nothing to do here.
    };

    try {
      xhr.send();
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`전송 실패: ${err && err.message ? err.message : err}`));
    }
  });
}

async function fetchWithFallback(urls, mime, fromPct, toPct, label) {
  let lastErr = null;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const isLocal = url.startsWith('./') || url.startsWith('/') || url.startsWith(window.location.origin);
      try {
        return await xhrFetchBlobURL(url, mime, fromPct, toPct, label);
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(`[ffmpeg load] ${label} fetch failed (attempt ${attempt + 1}, ${isLocal ? 'local' : 'cdn'}): ${url}`, err && err.message);
        // After local fails, immediately try CDN — don't wait the retry delay.
        if (isLocal) continue;
      }
    }
    if (attempt < FETCH_ATTEMPTS - 1) {
      reportDetail(`${label} 재시도 중 (${attempt + 2}/${FETCH_ATTEMPTS})`);
      await delay(FETCH_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  reportDetail('');
  throw lastErr || new Error('fetch failed');
}

function revokeBlobURLs() {
  for (const url of createdBlobURLs) {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  }
  createdBlobURLs = [];
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (timer !== null) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

export async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { wasm } = getGlobals();
    const ffmpeg = new wasm.FFmpeg();

    try {
      reportDetail('');

      reportStatus(STATUS.workerDownloading);
      let classWorkerURL = null;
      try {
        const workerPaths = ASSET_BASES.ffmpeg.map((b) => `${b}/${FFMPEG_WORKER_CHUNK}`);
        classWorkerURL = await fetchWithFallback(workerPaths, 'text/javascript', 0, 0.03, '워커');
      } catch (err) {
        // Worker chunk is optional — fall back to ffmpeg default resolution.
        // eslint-disable-next-line no-console
        console.warn('[ffmpeg load] worker chunk fetch failed; falling back', err);
        classWorkerURL = null;
      }

      reportStatus(STATUS.coreDownloading);
      const corePaths = ASSET_BASES.core.map((b) => `${b}/ffmpeg-core.js`);
      const coreURL = await fetchWithFallback(corePaths, 'text/javascript', 0.03, 0.08, '코어');

      reportStatus(STATUS.wasmDownloading);
      const wasmPaths = ASSET_BASES.core.map((b) => `${b}/ffmpeg-core.wasm`);
      const wasmURL = await fetchWithFallback(wasmPaths, 'application/wasm', 0.08, 0.93, 'WASM');

      reportStatus(STATUS.initializing);
      reportLoad(0.95);

      const config = classWorkerURL
        ? { classWorkerURL, coreURL, wasmURL }
        : { coreURL, wasmURL };

      await withTimeout(ffmpeg.load(config), LOAD_TIMEOUT_MS, MSG_LOAD_TIMEOUT);

      ffmpegInstance = ffmpeg;
      reportLoad(1);
      reportStatus(STATUS.ready);
      reportDetail('');
      return ffmpeg;
    } catch (err) {
      loadPromise = null;
      revokeBlobURLs();
      try { ffmpeg.terminate?.(); } catch (_) { /* ignore */ }
      // eslint-disable-next-line no-console
      console.error('[ffmpeg load] failed', err);
      const detail = err && err.message ? err.message : '';
      reportDetail(detail);
      if (err && err.message === MSG_LOAD_TIMEOUT) {
        throw err;
      }
      const wrapped = new Error(MSG_LOAD_FAIL);
      wrapped.detail = detail;
      throw wrapped;
    }
  })();

  return loadPromise;
}

export async function resetFFmpeg() {
  if (ffmpegInstance) {
    try { ffmpegInstance.terminate(); } catch (_) { /* ignore */ }
    ffmpegInstance = null;
  }
  revokeBlobURLs();
  loadPromise = null;
}

export async function convertAnimatedToMp4(file, { onProgress } = {}) {
  const ffmpeg = await loadFFmpeg();

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputName = `input_${stamp}.webp`;
  const outputName = `output_${stamp}.mp4`;

  const progressHandler = ({ progress }) => {
    if (typeof progress === 'number' && onProgress) {
      const clamped = Math.max(0, Math.min(1, progress));
      onProgress(clamped);
    }
  };
  ffmpeg.on('progress', progressHandler);

  try {
    const buffer = await file.arrayBuffer();
    await ffmpeg.writeFile(inputName, new Uint8Array(buffer));

    const code = await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-movflags', '+faststart',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-an',
      outputName,
    ]);

    if (code !== 0 && code !== undefined && code !== null) {
      throw new Error(MSG_CONVERT_FAIL);
    }

    const data = await ffmpeg.readFile(outputName);
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    const blob = new Blob(
      [view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)],
      { type: 'video/mp4' },
    );
    if (onProgress) onProgress(1);

    try { await ffmpeg.deleteFile(inputName); } catch (_) { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch (_) { /* ignore */ }

    return blob;
  } catch (err) {
    await resetFFmpeg();
    throw err instanceof Error ? err : new Error(MSG_CONVERT_FAIL);
  } finally {
    try {
      if (typeof ffmpeg.off === 'function') ffmpeg.off('progress', progressHandler);
    } catch (_) {
      // ignore
    }
  }
}
