import * as THREE from 'three';
import { DEG, quatFromYPR, angularSize } from './math.js';
import { FONT, makeCanvas, canvasTexture, roundRect, textSprite } from './textures.js';

/**
 * Content that the glasses would draw, placed on a sphere around the wearer.
 * Positions are given as azimuth (az, + = right) and elevation (el, + = up) in degrees,
 * sizes as angular width/height in degrees, so they read the same regardless of distance.
 *
 * `anchor` is the group the DisplayModel rotates according to the anchoring mode.
 */
export class ContentLayer {
  constructor() {
    this.scene = new THREE.Scene();
    this.anchor = new THREE.Group();
    this.scene.add(this.anchor);
    this.radius = 2.0; // metres; purely virtual (angular sizes are what matter)
    this.pxPerDeg = 48; // canvas resolution (display itself is 30 px/deg)
    this.preset = null;
    this._live = []; // widgets with per-frame redraw
    this._clockSec = -1;
  }

  setPreset(name) {
    this._dispose();
    this.preset = name;
    const b = { hud: buildHUD, workspace: buildWorkspace, grid: buildGrid }[name] || buildWorkspace;
    b(this);
  }

  /** Redraws live widgets once a second. Returns true when something was redrawn. */
  update(dt) {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec === this._clockSec) return false;
    this._clockSec = sec;
    for (const w of this._live) w.redraw(now);
    return this._live.length > 0;
  }

  _dispose() {
    this._live.length = 0;
    const kill = (o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    };
    this.anchor.traverse(kill);
    this.anchor.clear();
  }

  /** Create a card at (az, el) with angular size, drawn by `draw(ctx, w, h, now)`. */
  card({ az = 0, el = 0, wDeg = 10, hDeg = 6, draw, live = false, radius = 32 }) {
    const w = Math.round(wDeg * this.pxPerDeg);
    const h = Math.round(hDeg * this.pxPerDeg);
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const tex = canvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(angularSize(wDeg, this.radius), angularSize(hDeg, this.radius)),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
    );
    this.place(mesh, az, el);
    this.anchor.add(mesh);
    const widget = {
      mesh,
      redraw: (now = new Date()) => {
        ctx.clearRect(0, 0, w, h);
        draw(ctx, w, h, now, radius);
        tex.needsUpdate = true;
      },
    };
    widget.redraw();
    if (live) this._live.push(widget);
    return widget;
  }

  place(obj, az, el) {
    quatFromYPR(obj.quaternion, -az, el, 0);
    obj.position.set(0, 0, -this.radius).applyQuaternion(obj.quaternion);
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers (canvas units: 48 px per degree)

const PX = 48;
function frame(ctx, w, h, r, { fill = 'rgba(255,255,255,0.07)', stroke = 'rgba(255,255,255,0.38)', lw = 3 } = {}) {
  roundRect(ctx, lw, lw, w - lw * 2, h - lw * 2, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}
function text(ctx, str, x, y, { size = 1, weight = 500, color = '#ffffff', align = 'left', baseline = 'alphabetic' } = {}) {
  ctx.font = `${weight} ${Math.round(size * PX)}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
}
function pill(ctx, str, x, y, color) {
  ctx.font = `600 ${Math.round(0.62 * PX)}px ${FONT}`;
  const tw = ctx.measureText(str).width;
  roundRect(ctx, x, y, tw + 24, 0.95 * PX, 14);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x + 12, y + 0.48 * PX);
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// Presets

/** A compact HUD that fits inside a 20° display: status, notification, navigation. */
function buildHUD(layer) {
  layer.card({
    az: 0, el: 6.8, wDeg: 17, hDeg: 2.8, live: true,
    draw(ctx, w, h, now) {
      frame(ctx, w, h, 26);
      text(ctx, hhmm(now), 0.55 * PX, h / 2, { size: 1.5, weight: 600, baseline: 'middle' });
      text(ctx, '●', w - 3.9 * PX, h / 2, { size: 0.55, color: '#7bffb0', baseline: 'middle' });
      text(ctx, '86%', w - 3.2 * PX, h / 2, { size: 1.0, baseline: 'middle' });
      text(ctx, '▲', w - 1.2 * PX, h / 2, { size: 0.7, color: '#5ad1ff', baseline: 'middle' });
    },
  });
  layer.card({
    az: 0, el: 0.6, wDeg: 17, hDeg: 7.2,
    draw(ctx, w, h) {
      frame(ctx, w, h, 34);
      ctx.beginPath();
      ctx.arc(1.9 * PX, 2.2 * PX, 1.1 * PX, 0, Math.PI * 2);
      ctx.fillStyle = '#ff7ba6';
      ctx.fill();
      text(ctx, 'M', 1.9 * PX, 2.25 * PX, { size: 1.2, weight: 700, color: '#1b1016', align: 'center', baseline: 'middle' });
      text(ctx, 'Mina', 3.5 * PX, 1.85 * PX, { size: 1.15, weight: 600 });
      text(ctx, 'Messages · now', 3.5 * PX, 2.85 * PX, { size: 0.72, color: 'rgba(255,255,255,0.65)' });
      text(ctx, 'Running 5 min late — order me', 0.9 * PX, 4.7 * PX, { size: 1.0 });
      text(ctx, 'a flat white? ☕', 0.9 * PX, 5.95 * PX, { size: 1.0 });
      pill(ctx, 'Reply', w - 4.6 * PX, 1.3 * PX, '#5ad1ff');
    },
  });
  layer.card({
    az: 0, el: -6.2, wDeg: 17, hDeg: 4.6,
    draw(ctx, w, h) {
      frame(ctx, w, h, 30);
      text(ctx, '↱', 0.7 * PX, h / 2 + 0.1 * PX, { size: 2.6, weight: 700, color: '#7bffb0', baseline: 'middle' });
      text(ctx, 'Turn right · 120 m', 3.3 * PX, 1.9 * PX, { size: 1.15, weight: 600 });
      text(ctx, 'Shibuya Stream · 7 min · 550 m', 3.3 * PX, 3.3 * PX, { size: 0.8, color: 'rgba(255,255,255,0.65)' });
    },
  });
}

/** Cards spread across 120° of azimuth, so only ~one fits in the display at a time. */
function buildWorkspace(layer) {
  const apps = [
    { az: -60, title: 'Timer', glyph: '◷', color: '#8ef1ff', body: ['12:00 remaining', 'Pasta · al dente'] },
    { az: -40, title: 'Notes', glyph: '✎', color: '#ffb86b', body: ['Demo script', '1. Head-locked  2. World-locked'] },
    { az: -20, title: 'Maps', glyph: '◎', color: '#7bffb0', body: ['↱ Turn right · 120 m', 'Shibuya Stream · 7 min'] },
    { az: 0, title: 'Messages', glyph: '✉', color: '#5ad1ff', body: ['Mina: Running 5 min late —', 'order me a flat white?'] },
    { az: 20, title: 'Music', glyph: '♪', color: '#ff7ba6', body: ['Plastic Love', 'Mariya Takeuchi · 2:14 / 4:52'] },
    { az: 40, title: 'Calendar', glyph: '▦', color: '#b48cff', body: ['14:00 Design review', 'Room 3F-B · 3 attendees'] },
    { az: 60, title: 'Camera', glyph: '◉', color: '#ffd166', body: ['Ready · 12 MP', 'Tap band to capture'] },
  ];
  for (const a of apps) {
    layer.card({
      az: a.az, el: 0, wDeg: 15, hDeg: 10,
      draw(ctx, w, h) {
        frame(ctx, w, h, 36, { stroke: a.color + '99' });
        text(ctx, a.glyph, 0.9 * PX, 2.3 * PX, { size: 2.2, color: a.color, baseline: 'middle' });
        text(ctx, a.title, 3.6 * PX, 2.35 * PX, { size: 1.5, weight: 600, baseline: 'middle' });
        text(ctx, a.body[0], 0.9 * PX, 5.3 * PX, { size: 1.0 });
        text(ctx, a.body[1], 0.9 * PX, 6.7 * PX, { size: 0.85, color: 'rgba(255,255,255,0.65)' });
        const tag = a.az === 0 ? 'center' : a.az > 0 ? `${a.az}° right` : `${-a.az}° left`;
        text(ctx, `az ${tag}`, w - 0.9 * PX, h - 0.85 * PX, { size: 0.7, color: 'rgba(255,255,255,0.45)', align: 'right' });
      },
    });
  }
  // Row above: small pinned widgets
  layer.card({
    az: -9, el: 14, wDeg: 9, hDeg: 4.5, live: true,
    draw(ctx, w, h, now) {
      frame(ctx, w, h, 26);
      text(ctx, hhmm(now), 0.7 * PX, h / 2 + 0.05 * PX, { size: 1.9, weight: 600, baseline: 'middle' });
      text(ctx, 'el +14°', w - 0.7 * PX, h - 0.6 * PX, { size: 0.6, color: 'rgba(255,255,255,0.45)', align: 'right' });
    },
  });
  layer.card({
    az: 9, el: 14, wDeg: 9, hDeg: 4.5,
    draw(ctx, w, h) {
      frame(ctx, w, h, 26);
      text(ctx, '☀', 0.7 * PX, h / 2, { size: 1.8, color: '#ffd166', baseline: 'middle' });
      text(ctx, '23°C', 2.7 * PX, h / 2 - 0.35 * PX, { size: 1.2, weight: 600, baseline: 'middle' });
      text(ctx, 'Shibuya · clear', 2.7 * PX, h / 2 + 0.85 * PX, { size: 0.7, color: 'rgba(255,255,255,0.65)', baseline: 'middle' });
    },
  });
  // Row below: wide now-playing strip
  layer.card({
    az: 0, el: -13, wDeg: 26, hDeg: 4.2,
    draw(ctx, w, h) {
      frame(ctx, w, h, 28);
      text(ctx, '▶', 0.9 * PX, h / 2, { size: 1.1, color: '#ff7ba6', baseline: 'middle' });
      text(ctx, 'Plastic Love — Mariya Takeuchi', 2.5 * PX, h / 2, { size: 1.0, weight: 600, baseline: 'middle' });
      const x0 = 15.5 * PX, x1 = w - 1.0 * PX, y = h / 2;
      ctx.lineCap = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.strokeStyle = '#ff7ba6';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (x1 - x0) * 0.46, y); ctx.stroke();
    },
  });
  // Hints to the left/right edges of the center card
  const hint = (az, str) => {
    const s = textSprite(str, { size: angularSize(1.6, layer.radius), color: 'rgba(255,255,255,0.7)', font: `500 40px ${FONT}` });
    layer.place(s, az, -7.2);
    layer.anchor.add(s);
  };
  hint(-10, '← Maps · Notes · Timer');
  hint(10, 'Music · Calendar · Camera →');
}

/** Angular reference grid: 5° lines, 10° labels, over ±60° azimuth / ±40° elevation. */
function buildGrid(layer) {
  const R = layer.radius;
  const dir = (az, el) => new THREE.Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG)).multiplyScalar(R);
  const pts = [], cols = [];
  const push = (a, b, c) => { pts.push(a, b); cols.push(c.r, c.g, c.b, c.r, c.g, c.b); };
  const cMinor = new THREE.Color(0.32, 0.34, 0.38), cMajor = new THREE.Color(0.75, 0.78, 0.85), cAxis = new THREE.Color('#5ad1ff');
  for (let az = -60; az <= 60; az += 5) {
    const c = az === 0 ? cAxis : az % 10 === 0 ? cMajor : cMinor;
    for (let el = -40; el < 40; el += 2) push(dir(az, el), dir(az, el + 2), c);
  }
  for (let el = -40; el <= 40; el += 5) {
    const c = el === 0 ? cAxis : el % 10 === 0 ? cMajor : cMinor;
    for (let az = -60; az < 60; az += 2) push(dir(az, el), dir(az + 2, el), c);
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  layer.anchor.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true })));

  const label = (str, az, el, color = '#e8ebf0') => {
    const s = textSprite(str, { size: angularSize(1.7, R), color, bg: 'rgba(0,0,0,0.9)', font: `600 44px ${FONT}` });
    s.position.copy(dir(az, el));
    layer.anchor.add(s);
  };
  for (let az = -60; az <= 60; az += 10) if (az !== 0) label(`${az > 0 ? '+' : '−'}${Math.abs(az)}°`, az, 0.0);
  for (let el = -40; el <= 40; el += 10) if (el !== 0) label(`${el > 0 ? '+' : '−'}${Math.abs(el)}°`, 0, el);
  label('0°', 0, 0, '#5ad1ff');

  // A reticle showing the stock 20° window, for comparison with other FOVs.
  const ring = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    ring.push(dir(Math.cos(a) * 10, Math.sin(a) * 10));
  }
  layer.anchor.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: '#ffb86b' })));
}
