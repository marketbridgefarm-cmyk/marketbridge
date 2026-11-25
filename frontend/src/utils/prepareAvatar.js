// Prepares a profile photo in the browser BEFORE upload: centre-crops to a square and shrinks to 512px WebP
// (about 30-80 KB instead of several MB) so it uploads quickly on mobile data. The server crops/validates again.
export const SERVER_MAX_BYTES = 5 * 1024 * 1024;   // must match AVATAR_MAX_FILE_BYTES on the API
export const PICK_MAX_BYTES = 20 * 1024 * 1024;    // largest original we will even try to read
const OUT = 512;
const PASS_THROUGH = /^image\/(jpeg|png|webp|heic|heif)$/i;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareAvatar(file) {
  if (!file) throw new Error('Choose a photo first.');
  const looksLikeImage = /^image\//i.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
  if (!looksLikeImage) throw new Error('Please choose a photo (JPG, PNG or WebP).');
  if (file.size > PICK_MAX_BYTES) throw new Error('That photo is too large. Please choose one under 20 MB.');

  try {
    const src = await decode(file);
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    const side = Math.min(w, h);
    const out = Math.min(OUT, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
    if (typeof src.close === 'function') src.close();

    const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
    let blob = await toBlob('image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.88);   // older Safari
    if (!blob) throw new Error('encode failed');
    return new File([blob], blob.type === 'image/webp' ? 'avatar.webp' : 'avatar.jpg', { type: blob.type });
  } catch {
    // The browser could not read it (typically HEIC outside Safari). Let the server try, if it is small enough.
    if (PASS_THROUGH.test(file.type) && file.size <= SERVER_MAX_BYTES) return file;
    throw new Error('Your browser cannot read that photo format. Please choose a JPG or PNG.');
  }
}
