// Static WebP → JPEG via Canvas. Quality 0.92 per spec.

const JPEG_QUALITY = 0.92;
const MSG_DECODE_FAIL = '이미지를 디코딩하지 못했습니다';
const MSG_ENCODE_FAIL = 'JPEG으로 변환하지 못했습니다';

// iOS Safari can fail to allocate a canvas above ~16,777,216 pixels (4096²) on
// older devices and ~33,554,432 (≈8192×4096) on recent ones. We pick a
// conservative bound that should encode safely on every iPhone from 8 onward
// while still preserving plenty of detail for photo-quality WebPs.
const MAX_PIXELS = 33_177_600; // ~6048×5408

function fitWithin(width, height, maxPixels) {
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height, scaled: false };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scaled: true,
  };
}

async function decodeBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch (_) {
      // Fall through to <img> path.
    }
  }
  return decodeViaImage(file);
}

function decodeViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = async () => {
      try {
        if (typeof img.decode === 'function') await img.decode();
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          source: img,
          revoke: () => URL.revokeObjectURL(url),
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(MSG_DECODE_FAIL));
    };
    img.src = url;
  });
}

function drawAndEncode(bitmap, srcWidth, srcHeight, dstWidth, dstHeight) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(dstWidth, dstHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(MSG_ENCODE_FAIL);
    ctx.drawImage(bitmap, 0, 0, srcWidth, srcHeight, 0, 0, dstWidth, dstHeight);
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = dstWidth;
  canvas.height = dstHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(MSG_ENCODE_FAIL);
  ctx.drawImage(bitmap, 0, 0, srcWidth, srcHeight, 0, 0, dstWidth, dstHeight);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(MSG_ENCODE_FAIL))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

export async function convertStaticToJpeg(file) {
  let bitmap = null;
  let srcWidth = 0;
  let srcHeight = 0;
  let revoke = null;
  let source = null;

  try {
    const decoded = await decodeBitmap(file);
    if (decoded && typeof decoded.width === 'number' && decoded.source) {
      // Image-element path.
      srcWidth = decoded.width;
      srcHeight = decoded.height;
      source = decoded.source;
      revoke = decoded.revoke;
    } else {
      bitmap = decoded;
      srcWidth = bitmap.width;
      srcHeight = bitmap.height;
      source = bitmap;
    }

    if (!srcWidth || !srcHeight) throw new Error(MSG_DECODE_FAIL);

    const fit = fitWithin(srcWidth, srcHeight, MAX_PIXELS);
    const blob = await drawAndEncode(source, srcWidth, srcHeight, fit.width, fit.height);
    if (!blob) throw new Error(MSG_ENCODE_FAIL);
    return blob;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (typeof revoke === 'function') revoke();
  }
}
