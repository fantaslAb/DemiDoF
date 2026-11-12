import * as THREE from 'three';

/**
 * Focus rule for the 20° window: a card is drawn only while at least half of it is inside
 * the display. A card that is mostly outside is not what the wearer is attending to, so it
 * is replaced by a location cue: a short, thin bar flush with the window edge, in the
 * card's colour, on the side where the card is.
 *
 * Cues stay out of the way: only the nearest hidden card per side gets one, and they fade
 * out while the wearer holds still on a card (reading) and come back when the head turns
 * (searching) or when no card is in view.
 *
 * "Half" is measured against the smaller of the card and the window, so a card wider than
 * the window still counts as in focus when it fills most of the window.
 */

const SHOW_AT = 0.5;   // fraction inside to appear
const HIDE_AT = 0.4;   // fraction inside to disappear (hysteresis: no flicker at the edge)
const FADE_S = 0.12;   // fade time for appear / disappear
const EDGE_INSET = 3;  // px from the window edge to the bar
const BAR_LEN = 34;    // px along the edge
const BAR_W = 4;       // px across the edge
const CUE_FADE_S = 0.3;   // cue fade time
const CUE_HOLD_S = 1.2;   // cues fade out after holding still this long with a card in view
const CUE_MOVE_DPS = 20;  // head speed that brings the cues back

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();

export class FocusCues {
  /**
   * @param {import('./content.js').ContentLayer} content
   * @param {THREE.Camera} camera  the display camera
   * @param {HTMLElement} layer    absolutely positioned container over the canvas
   * @param {number} size          canvas size in px
   */
  constructor(content, camera, layer, size = 600) {
    this.content = content;
    this.camera = camera;
    this.layer = layer;
    this.size = size;
    this.enabled = true;
    this.state = new Map(); // item -> { shown, opacity, frac }
    this.dots = [];
    this.shownCount = 0;
    this.cueAlpha = 1;
    this._still = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      for (const it of this.content.items) { it.mesh.material.opacity = 1; it.mesh.visible = true; }
      this.state.clear();
      this._place([]);
    }
  }

  /** Fraction of the item's on-screen box that lies inside the window (0..1). */
  _fraction(item) {
    const cam = this.camera;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      _v.set(sx * item.width / 2, sy * item.height / 2, 0).applyMatrix4(item.mesh.matrixWorld);
      _c.copy(_v).applyMatrix4(cam.matrixWorldInverse);
      if (_c.z > -1e-3) return 0; // a corner behind the eye: far outside
      _v.project(cam);
      x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x);
      y0 = Math.min(y0, _v.y); y1 = Math.max(y1, _v.y);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!(area > 0)) return 0;
    const ix = Math.max(0, Math.min(x1, 1) - Math.max(x0, -1));
    const iy = Math.max(0, Math.min(y1, 1) - Math.max(y0, -1));
    return (ix * iy) / Math.min(area, 4); // the window is 2 x 2 in NDC
  }

  /**
   * Updates visibility, fades and cues. `speed` is the head's angular speed in deg/s.
   * Returns true when the canvas must be redrawn.
   */
  update(dt, speed = 0) {
    if (!this.enabled) return false;
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.content.scene.updateMatrixWorld();
    let redraw = false, shown = 0;
    const cues = [];
    const half = this.size / 2;
    for (const item of this.content.items) {
      let st = this.state.get(item);
      if (!st) { st = { shown: false, opacity: item.mesh.material.opacity ?? 1, frac: 0 }; this.state.set(item, st); }
      st.frac = this._fraction(item);
      if (!st.shown && st.frac >= SHOW_AT) st.shown = true;
      else if (st.shown && st.frac < HIDE_AT) st.shown = false;
      const target = st.shown ? 1 : 0;
      if (st.opacity !== target) {
        const step = dt > 0 ? dt / FADE_S : 1;
        st.opacity = target > st.opacity ? Math.min(target, st.opacity + step) : Math.max(target, st.opacity - step);
        item.mesh.material.opacity = st.opacity;
        item.mesh.visible = st.opacity > 0.001;
        redraw = true;
      }
      if (st.shown) { shown++; continue; }
      // Cue: direction of the card centre as seen from the display centre.
      _c.setFromMatrixPosition(item.mesh.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
      const ang = Math.acos(Math.max(-1, Math.min(1, -_c.z / _c.length()))) / Math.PI * 180; // degrees off-axis
      let dx = _c.x, dy = -_c.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const t = (half - EDGE_INSET) / Math.max(Math.abs(dx), Math.abs(dy));
      const side = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
      cues.push({ x: half + dx * t, y: half + dy * t, ang, side, color: item.color });
    }
    this.shownCount = shown;
    // Cue visibility: away while reading, back when searching.
    this._still = speed > CUE_MOVE_DPS ? 0 : this._still + dt;
    const want = shown === 0 || this._still < CUE_HOLD_S ? 1 : 0;
    const k = dt > 0 ? dt / CUE_FADE_S : 1;
    this.cueAlpha = want > this.cueAlpha ? Math.min(1, this.cueAlpha + k) : Math.max(0, this.cueAlpha - k);
    this._place(cues);
    return redraw;
  }

  _place(cues) {
    // Nearest hidden card per side only.
    const best = {};
    for (const c of cues) if (!best[c.side] || c.ang < best[c.side].ang) best[c.side] = c;
    let n = 0;
    if (this.cueAlpha > 0.01) {
      for (const c of Object.values(best)) {
        const dot = this._dot(n++);
        const vertical = c.side === 'left' || c.side === 'right';
        const w = vertical ? BAR_W : BAR_LEN, h = vertical ? BAR_LEN : BAR_W;
        const max = this.size - EDGE_INSET;
        const x = c.side === 'left' ? EDGE_INSET : c.side === 'right' ? max - w : Math.min(max - w, Math.max(EDGE_INSET, c.x - w / 2));
        const y = c.side === 'top' ? EDGE_INSET : c.side === 'bottom' ? max - h : Math.min(max - h, Math.max(EDGE_INSET, c.y - h / 2));
        const alpha = Math.max(0.25, 0.75 - c.ang / 160) * this.cueAlpha; // nearer = brighter
        dot.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        dot.style.width = `${w}px`;
        dot.style.height = `${h}px`;
        dot.style.background = c.color;
        dot.style.opacity = alpha.toFixed(2);
        dot.style.display = 'block';
      }
    }
    for (let i = n; i < this.dots.length; i++) this.dots[i].style.display = 'none';
  }

  _dot(i) {
    while (this.dots.length <= i) {
      const d = document.createElement('div');
      d.className = 'cue';
      this.layer.appendChild(d);
      this.dots.push(d);
    }
    return this.dots[i];
  }
}
