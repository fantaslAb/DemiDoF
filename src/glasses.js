import * as THREE from 'three';
import { ContentLayer } from './content.js';
import { DisplayModel } from './display.js';
import { HeadTracker } from './glasses-head.js';
import { RemoteLog } from './glasses-log.js';
import { yprFromQuat, fmtDeg, angleBetween } from './math.js';

/**
 * DemiDoF on the Ray-Ban Display: world-locked content only.
 *
 * The page is the 600 × 600 display. The content layer is rendered straight to the canvas
 * through the display camera; the head pose comes from the HeadTracker. Controls:
 *   Select / tap   recenter (the way you look becomes "forward")
 *   ← →            switch the content preset
 *   ↑ ↓            readout on / off
 */

const $ = (id) => document.getElementById(id);
const SIZE = 600;
const CONTENT_ORDER = ['workspace', 'hud', 'grid'];
const CONTENT_SHORT = { workspace: 'Workspace · cards across 120°', hud: 'HUD demo', grid: 'Angular grid' };

const STORE_KEY = 'demidof.glasses.v3';
function loadSettings() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; } }
function saveSettings(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage may be unavailable */ } }
const settings = Object.assign({ content: 'workspace', hud: false }, loadSettings());

const rlog = new RemoteLog({ enabled: new URLSearchParams(location.search).get('log') !== '0' });
rlog.log('load', { ua: navigator.userAgent, w: innerWidth, h: innerHeight, url: location.href });

const params = {
  mode: 'world',
  content: CONTENT_ORDER.includes(settings.content) ? settings.content : 'workspace',
  fov: 20, offsetH: 12, offsetV: -8, roll: 0, distance: 2.0,
  brightness: 1, occlusion: 0, vignette: 0, showBounds: false, lazyDeadzone: 8, lazySpeed: 5,
};

// ---------------------------------------------------------------------------
// Renderer, content, display, tracker

const canvas = $('gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
} catch (err) {
  $('fatal').textContent = `WebGL is not available in this browser: ${err.message || err}`;
  $('fatal').classList.add('show');
  $('start').classList.add('hidden');
  throw err;
}
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 1);

const content = new ContentLayer();
content.setPreset(params.content);
const display = new DisplayModel(params);
const head = new HeadTracker(canvas);
// Recenter: apply the new yaw offset to the display camera first, then anchor the content there.
head.onReset = () => { display.update(head.update(0), 0); display.recenter(); };

// ---------------------------------------------------------------------------
// UI

const hud = $('hud');
const edge = $('edge');
let toastTimer = 0;
function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function persist() { settings.content = params.content; settings.hud = !hud.classList.contains('hidden'); saveSettings(settings); }

function setContent(name) {
  params.content = name;
  content.setPreset(name);
  display.recenter();
  toast(CONTENT_SHORT[name]);
  rlog.log('content', { name });
  persist();
}
function setHud(on) { hud.classList.toggle('hidden', !on); persist(); }
function recenter(why) {
  head.resetHead();
  toast('Recentred: this way is forward');
  rlog.log('recenter', { why, ...rawSample() });
}

// ---------------------------------------------------------------------------
// Start (the sensor permission must come from a user gesture)

let started = false;
let watchdog = 0;
async function start() {
  if (started) return;
  started = true;
  $('start').classList.add('hidden');
  rlog.log('start', { settings });
  if (!HeadTracker.sensorAvailable()) { toast('No motion sensors here: drag to look around.', 3500); return; }
  // Fall back to drag when permission is refused, hangs, or no samples ever arrive.
  const t0 = performance.now();
  const check = () => {
    if (head.sensor.has) { toast('Head tracking on. Select = recenter · ← → content · ↑ ↓ readout', 3500); return; }
    const waited = (performance.now() - t0) / 1000;
    const pending = head.sensor.permission === 'pending' && waited < 30;
    if (pending || waited < 6) { watchdog = setTimeout(check, 250); return; }
    toast('No head-sensor data. Drag to look around; Select asks again.', 4000);
  };
  watchdog = setTimeout(check, 250);
  const ok = await head.enableSensor();
  const s = head.sensor;
  rlog.log('perm', { ok, permission: s.permission, fn: s.permFn, asked: s.asked, result: s.lastResult, ms: Math.round(s.askMs) });
  if (!ok) { clearTimeout(watchdog); toast(`Sensor permission: ${s.lastResult || 'refused'}. Drag to look around; Select asks again.`, 4000); }
}
$('b-start').addEventListener('click', start);

// ---------------------------------------------------------------------------
// Input: Select / tap = start or recenter; arrows = content and readout

let lastActivate = 0;
function activate(why) {
  const now = performance.now();
  if (now - lastActivate < 250) return; // one tap arrives as keydown + keyup + click
  lastActivate = now;
  rlog.log('activate', { why });
  if (!started) { start(); return; }
  if (!head.sensor.listening && HeadTracker.sensorAvailable()) { head.enableSensor(); }
  recenter(why);
}
const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Select', 'OK', 'Accept', 'NumpadEnter']);
const isActivateKey = (e) => ACTIVATE_KEYS.has(e.key) || e.keyCode === 13 || e.keyCode === 32 || e.code === 'Enter';

for (const type of ['keydown', 'keyup']) {
  document.addEventListener(type, (e) => rlog.log('key', { type, key: e.key, code: e.code, keyCode: e.keyCode, trusted: e.isTrusted }), true);
}
// A click that ends a drag is not a tap.
let pointerStart = null, pointerMoved = 0;
canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); pointerStart = { x: e.clientX, y: e.clientY }; pointerMoved = 0; }); // keep focus where it is
canvas.addEventListener('pointermove', (e) => { if (pointerStart) pointerMoved = Math.max(pointerMoved, Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y)); });
document.addEventListener('click', (e) => {
  rlog.log('click', { target: e.target && (e.target.id || e.target.tagName), trusted: e.isTrusted, moved: Math.round(pointerMoved) });
  if (e.target && e.target.closest && e.target.closest('button')) return;
  if (pointerMoved > 12) { pointerMoved = 0; return; }
  activate('click');
}, true);
document.addEventListener('keyup', (e) => { if (isActivateKey(e)) { e.preventDefault(); activate(`keyup:${e.key}`); } });
document.addEventListener('keydown', (e) => {
  if (isActivateKey(e)) { e.preventDefault(); activate(`keydown:${e.key}`); return; }
  if (!started) return;
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); setContent(CONTENT_ORDER[(CONTENT_ORDER.indexOf(params.content) + CONTENT_ORDER.length - 1) % CONTENT_ORDER.length]); break;
    case 'ArrowRight': e.preventDefault(); setContent(CONTENT_ORDER[(CONTENT_ORDER.indexOf(params.content) + 1) % CONTENT_ORDER.length]); break;
    case 'ArrowUp': e.preventDefault(); setHud(true); break;
    case 'ArrowDown': e.preventDefault(); setHud(false); break;
    case 'c': case 'C': recenter('key-c'); break;
  }
});
document.addEventListener('visibilitychange', () => {
  if (!started) return;
  if (document.hidden) head.disableSensor(); else head.enableSensor();
});

// ---------------------------------------------------------------------------
// Readout, edge indicator, remote log

function rawSample() {
  const s = head.sensor;
  const e = yprFromQuat(head.quaternion);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    src: s.source, ev: s.events, mev: s.motionEvents, rate: r1(s.rate), mrate: r1(s.motionRate),
    a: r1(s.alpha), b: r1(s.beta), g: r1(s.gamma), abs: s.absolute,
    rr: s.hasGyro ? [r1(s.rr.a), r1(s.rr.b), r1(s.rr.g)] : null,
    grav: s.hasGravity ? [r1(s.grav.x), r1(s.grav.y), r1(s.grav.z)] : null,
    bias: [r1(head.bias.x), r1(head.bias.y), r1(head.bias.z)], speed: r1(head.speed), tau: Math.round(head.tau * 1000),
    yaw: r1(-e.yaw), pitch: r1(e.pitch), roll: r1(e.roll), off: r1(display.contentOffset()),
  };
}

let fps = 0, hudTimer = 0;
function updateHud(q, dt) {
  fps = fps ? fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 1 / Math.max(dt, 1e-3);
  hudTimer += dt;
  if (hudTimer < 0.15 || hud.classList.contains('hidden')) return;
  hudTimer = 0;
  const e = yprFromQuat(q);
  const s = head.sensor;
  const f1 = (v) => v.toFixed(0);
  const lines = [
    `<b>World-locked</b> · ${CONTENT_SHORT[params.content]}`,
    `head  <b>${fmtDeg(-e.yaw, true)}</b> / <b>${fmtDeg(e.pitch, true)}</b> / <b>${fmtDeg(e.roll, true)}</b> · offset ${fmtDeg(display.contentOffset())}`,
    `source ${s.source} · perm ${s.permission} (${s.permFn || '?'} ×${s.asked}${s.lastResult ? ` → ${s.lastResult}` : ''})`,
    `orient ${s.events} ev ${f1(s.rate)}/s · αβγ ${f1(s.alpha)} ${f1(s.beta)} ${f1(s.gamma)}${s.absolute ? ' abs' : ''}`,
    `motion ${s.motionEvents} ev ${f1(s.motionRate)}/s · gyro ${s.hasGyro ? 'yes' : 'no'} · grav ${s.hasGravity ? 'yes' : 'no'}`,
    `bias ${head.bias.x.toFixed(1)} ${head.bias.y.toFixed(1)} ${head.bias.z.toFixed(1)} °/s · speed ${f1(head.speed)} °/s · τ ${Math.round(head.tau * 1000)} ms`,
    `${fps.toFixed(0)} fps`,
  ];
  hud.innerHTML = lines.join('\n');
}

/** Show an arrow at the window edge when the content centre is outside the 20° window. */
const _rel = new THREE.Quaternion();
function updateEdge() {
  _rel.copy(display.camera.quaternion).invert().multiply(display.anchor); // content relative to the display
  const e = yprFromQuat(_rel);
  const dx = -e.yaw, dy = e.pitch; // + = content is to the right / above
  const half = params.fov / 2;
  if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) { edge.classList.remove('show'); return; }
  const arrow = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? '→' : '←') : (dy > 0 ? '↑' : '↓');
  edge.textContent = `${arrow} ${Math.round(Math.hypot(dx, dy))}°`;
  edge.classList.add('show');
  const px = (v) => Math.round(300 + Math.max(-250, Math.min(250, v * (300 / half))));
  edge.style.left = `${px(dx) - 40}px`;
  edge.style.top = `${px(-dy) - 20}px`;
}

// ---------------------------------------------------------------------------
// Frame loop

const clock = new THREE.Clock();
const _prevQ = new THREE.Quaternion();
let logTimer = 0, lastSource = 'none', hadPrev = false;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const q = head.update(dt);
  if (head.sensor.source !== lastSource) { lastSource = head.sensor.source; rlog.log('source', rawSample()); }
  if (hadPrev) {
    const jump = angleBetween(_prevQ, q);
    if (jump > 20) rlog.log('jump', { deg: Math.round(jump), dt: Math.round(dt * 1000), ...rawSample() });
  }
  _prevQ.copy(q); hadPrev = true;
  logTimer += dt;
  if (logTimer >= 0.2) { logTimer = 0; rlog.log('s', { fps: Math.round(fps), ...rawSample() }); }

  display.update(q, dt);
  content.update(dt);
  content.anchor.quaternion.copy(display.anchor);
  renderer.setViewport(0, 0, SIZE, SIZE);
  renderer.render(content.scene, display.camera);
  updateEdge();
  updateHud(q, dt);
}

setHud(!!settings.hud);
display.recenter();
renderer.setAnimationLoop(frame);
$('b-start').focus({ preventScroll: true });

// Exposed for the smoke test
window.__glasses = { params, display, content, head, renderer, start, setContent, recenter };
