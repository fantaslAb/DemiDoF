import * as THREE from 'three';

export const FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Roboto, sans-serif';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  return c;
}

export function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * A billboard text label. `size` is the world height of the sprite.
 */
export function textSprite(text, { size = 0.3, color = '#ffffff', bg = null, font = `600 48px ${FONT}`, pad = 14 } = {}) {
  const measure = makeCanvas(8, 8).getContext('2d');
  measure.font = font;
  const m = measure.measureText(text);
  const textH = (m.actualBoundingBoxAscent || 36) + (m.actualBoundingBoxDescent || 10);
  const w = Math.ceil(m.width + pad * 2);
  const h = Math.ceil(textH + pad * 2);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, w, h, 10);
    ctx.fill();
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = canvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size * (w / h), size, 1);
  return sprite;
}
