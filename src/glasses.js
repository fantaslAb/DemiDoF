import * as THREE from 'three';
import { ContentLayer } from './content.js';
import { DisplayModel } from './display.js';
import { GlassesHead, AXIS_NAMES, UP_CHOICES } from './glasses-head.js';
import { RemoteLog } from './glasses-log.js';
import { yprFromQuat, quatFromYPR, fmtDeg, angleBetween } from './math.js';

/**
 * DemiDoF on the glasses themselves (Meta Ray-Ban Display Web App).
 *
 * The page IS the 600 × 600 display. There is no wearer's view, no room, no sliders:
 * the content layer is rendered straight to the canvas through the display camera,
 * the head pose comes from the glasses' IMU, and a six-button bar at the bottom is
 * driven with the arrow keys and Enter that the glasses deliver.
 */

const $ = (id) => document.getElementById(id);
const SIZE = 600;

const MODE_ORDER = ['world', 'snap', 'locked', 'lazy', 'level'];
const MODE_SHORT = { world: 'World-locked', snap: 'Snap · world-locked in detents', locked: 'Head-locked', lazy: 'Lazy follow', level: 'Horizon-level' };
const MODE_BTN = { world: 'World', snap: 'Snap', locked: 'Head', lazy: 'Lazy', level: 'Level' };
/** Detent size per content preset (degrees of yaw / pitch): one card, one row. */
const SNAP_STEP = { workspace: { yaw: 20, pitch: 13.5 }, hud: { yaw: 20, pitch: 6.5 }, grid: { yaw: 10, pitch: 10 } };
const CONTENT_ORDER = ['workspace', 'hud', 'grid'];
const CONTENT_SHORT = { workspace: 'Workspace', hud: 'HUD demo', grid: 'Angular grid' };
const CONTENT_BTN = { workspace: 'Cards', hud: 'HUD', grid: 'Grid' };
const MOTION_ORDER = ['sensor', 'orient', 'gyro', 'demo', 'manual'];
const MOTION_SHORT = { sensor: 'Fused', orient: 'Orient', gyro: 'Gyro', demo: 'Demo', manual: 'Drag' };
const SOURCE_MODE = { sensor: 'auto', orient: 'orient', gyro: 'gyro' };
let motionChoice = 'sensor'; // what the Head button shows; the first three are head.motion 'sensor' with a sourceMode

// Remote log (serve.py appends it to logs/<date>.jsonl). `?log=0` turns it off.
const rlog = new RemoteLog({ enabled: new URLSearchParams(location.search).get('log') !== '0' });
rlog.log('load', { ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, url: location.href });

// ---------------------------------------------------------------------------
// Persisted settings

const STORE_KEY = 'demidof.glasses.v2'; // v1 held axis presets that no longer exist
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage may be unavailable */ }
}
const settings = Object.assign({ mode: 'world', content: 'workspace', axes: { up: '+Y', right: '+X' }, hud: false, motion: 'sensor' }, loadSettings());

const params = {
  mode: MODE_ORDER.includes(settings.mode) ? settings.mode : 'world',
  content: CONTENT_ORDER.includes(settings.content) ? settings.content : 'workspace',
  fov: 20,
  offsetH: 12,
  offsetV: -8,
  roll: 0,
  distance: 2.0,
  brightness: 1,
  occlusion: 0,
  vignette: 0,
  showBounds: false,
  lazyDeadzone: 8,
  lazySpeed: 5,
};

// ---------------------------------------------------------------------------
// Renderer

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
const head = new GlassesHead(canvas);
head.onReset = () => display.recenter();
head.motion = 'manual';
if (settings.axes && typeof settings.axes === 'object') head.setAxes(settings.axes.up, settings.axes.right);

// ---------------------------------------------------------------------------
// UI helpers

let started = false;
const bar = $('bar');
const barAxes = $('bar-axes');
const hud = $('hud');
let activeBar = bar;
let buttons = [...bar.querySelectorAll('button')];
let focusIndex = 0;

function setLabel(id, text) { $(id).querySelector('b').textContent = text; }
function focusButton(i) {
  focusIndex = (i + buttons.length) % buttons.length;
  buttons[focusIndex].focus({ preventScroll: true });
}
/** Switch between the main bar and the axes bar; focus the first button of the new one. */
function setBar(el) {
  if (activeBar === el) return;
  activeBar.classList.add('hidden');
  activeBar = el;
  buttons = [...el.querySelectorAll('button')];
  el.classList.remove('hidden');
  focusButton(0);
}
function showBar(on) { activeBar.classList.toggle('hidden', !on); }
function barVisible() { return !activeBar.classList.contains('hidden'); }

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function persist() {
  settings.mode = params.mode;
  settings.content = params.content;
  settings.axes = { ...head.axes };
  settings.hud = !hud.classList.contains('hidden');
  if (started) settings.motion = motionChoice; // before Start the head is still in its initial state
  saveSettings(settings);
}

// ---------------------------------------------------------------------------
// Actions

function setMode(mode) {
  params.mode = mode;
  display.lazyFollowing = false;
  detent.reset();
  if (mode === 'world' || mode === 'snap') display.recenter();
  setLabel('b-mode', MODE_BTN[mode]);
  toast(MODE_SHORT[mode]);
  rlog.log('mode', { mode });
  persist();
}
function setContent(name) {
  params.content = name;
  content.setPreset(name);
  detent.reset();
  display.recenter();
  setLabel('b-content', CONTENT_BTN[name]);
  toast(CONTENT_SHORT[name]);
  rlog.log('content', { name });
  persist();
}
function setHud(on) {
  hud.classList.toggle('hidden', !on);
  setLabel('b-hud', on ? 'On' : 'Off');
  persist();
}
function setAxesLabels() {
  setLabel('b-frame', `${head.axes.up} / ${head.axes.right}`);
  setLabel('b-ax-up', head.axes.up);
  setLabel('b-ax-right', head.axes.right);
}
function cycleAxis(which) {
  const list = which === 'up' ? UP_CHOICES : AXIS_NAMES;
  const next = list[(list.indexOf(head.axes[which]) + 1) % list.length];
  if (which === 'up') head.setAxes(next, undefined); else head.setAxes(undefined, next);
  setAxesLabels();
  persist();
  rlog.log('axes', { ...head.axes, fixId: head.fixId });
  if (head.axesConflict()) toast(`Up ${head.axes.up} and right ${head.axes.right} are the same axis. Pick another.`, 3000);
  else toast(`Up ${head.axes.up} · right ${head.axes.right}. Look ahead, press Center, then turn your head.`, 3000);
}

let sensorWatchdog = 0;
let autoDemo = false;         // demo motion chosen by the watchdog, not by the wearer
const SENSOR_GRACE_S = 6;     // seconds without samples after permission before falling back
const SENSOR_PROMPT_S = 30;   // longest we wait on a permission prompt before falling back
async function setMotion(mode, { announce = true, keepListening = false } = {}) {
  clearTimeout(sensorWatchdog);
  autoDemo = false;
  rlog.log('motion', { mode });
  if (SOURCE_MODE[mode]) {
    motionChoice = mode;
    head.sourceMode = SOURCE_MODE[mode];
    if (head.sensor.listening) { head.sensor.has = false; head.sensor.source = 'none'; }
    mode = 'sensor';
  } else {
    motionChoice = mode;
    head.sourceMode = 'auto';
  }
  if (mode === 'sensor') {
    if (!GlassesHead.sensorAvailable()) {
      if (announce) toast('No motion-sensor API in this browser. Using demo motion.');
      return setMotion('demo', { announce: false });
    }
    head.motion = 'sensor';
    head.resetHead();
    setLabel('b-motion', MOTION_SHORT[motionChoice]);
    persist();
    // Permission can hang, be refused, or be granted while no samples arrive (desktop,
    // Meta's simulator). Fall back to demo motion, but keep listening: if samples start
    // later, the frame loop switches back to the sensor by itself.
    const t0 = performance.now();
    const check = () => {
      if (head.motion !== 'sensor' || head.sensor.has) return;
      const waited = (performance.now() - t0) / 1000;
      const pending = head.sensor.permission === 'pending' && waited < SENSOR_PROMPT_S;
      if (pending || waited < SENSOR_GRACE_S) { sensorWatchdog = setTimeout(check, 250); return; }
      toast('Permission OK but no sensor data yet. Demo motion until it arrives; Head button asks again.', 4000);
      setMotion('demo', { announce: false, keepListening: true });
      autoDemo = true;
    };
    sensorWatchdog = setTimeout(check, 250);
    const ok = await head.enableSensor();
    const s = head.sensor;
    rlog.log('perm', { ok, permission: s.permission, fn: s.permFn, asked: s.asked, result: s.lastResult, ms: Math.round(s.askMs) });
    if (!ok && head.motion === 'sensor') {
      clearTimeout(sensorWatchdog);
      if (announce) toast(`Sensor permission: ${head.sensor.lastResult || 'refused'}. Demo motion; Head button asks again.`, 4000);
      return setMotion('demo', { announce: false });
    }
    return;
  }
  if (!keepListening) head.disableSensor();
  head.motion = mode;
  head.resetHead();
  setLabel('b-motion', MOTION_SHORT[mode]);
  persist();
}

$('b-mode').addEventListener('click', () => setMode(MODE_ORDER[(MODE_ORDER.indexOf(params.mode) + 1) % MODE_ORDER.length]));
$('b-content').addEventListener('click', () => setContent(CONTENT_ORDER[(CONTENT_ORDER.indexOf(params.content) + 1) % CONTENT_ORDER.length]));
$('b-recenter').addEventListener('click', () => { detent.reset(); head.resetHead(); toast('Recentred: this way is forward'); rlog.log('recenter', rawSample()); });
$('b-motion').addEventListener('click', () => {
  // From the automatic fallback, one press re-requests the sensor (a user gesture is required).
  if (autoDemo) { head.disableSensor(); return setMotion(SOURCE_MODE[motionChoice] ? motionChoice : 'sensor'); }
  setMotion(MOTION_ORDER[(MOTION_ORDER.indexOf(motionChoice) + 1) % MOTION_ORDER.length]);
});
// Axes: a second bar where the wearer picks which device axis is UP and which is RIGHT.
$('b-frame').addEventListener('click', () => { setBar(barAxes); toast('Pick the device axis that points UP and the one that points RIGHT', 3200); });
$('b-ax-up').addEventListener('click', () => cycleAxis('up'));
$('b-ax-right').addEventListener('click', () => cycleAxis('right'));
$('b-ax-center').addEventListener('click', () => { detent.reset(); head.resetHead(); toast('Recentred: this way is forward'); rlog.log('recenter', rawSample()); });
$('b-ax-back').addEventListener('click', () => setBar(bar));

/** Raw sensor state plus the resulting head pose, for the remote log. */
function rawSample() {
  const s = head.sensor;
  const e = yprFromQuat(head.quaternion);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    src: head.motion === 'sensor' ? s.source : head.motion,
    ev: s.events, mev: s.motionEvents, rate: r1(s.rate), mrate: r1(s.motionRate),
    a: r1(s.alpha), b: r1(s.beta), g: r1(s.gamma), abs: s.absolute, et: s.eventType,
    rr: s.hasGyro ? [r1(s.rr.a), r1(s.rr.b), r1(s.rr.g)] : null,
    grav: s.hasGravity ? [r1(s.grav.x), r1(s.grav.y), r1(s.grav.z)] : null,
    yaw: r1(-e.yaw), pitch: r1(e.pitch), roll: r1(e.roll), off: r1(display.contentOffset()),
    bias: [r1(head.bias.x), r1(head.bias.y), r1(head.bias.z)], mode: params.mode,
    so: (screen.orientation && screen.orientation.angle) || 0, axes: head.fixId,
  };
}
$('b-hud').addEventListener('click', () => setHud(hud.classList.contains('hidden')));

// ---------------------------------------------------------------------------
// Start (the sensor permission must come from a user gesture)

async function start() {
  if (started) return;
  started = true;
  $('start').classList.add('hidden');
  showBar(true);
  focusButton(0);
  rlog.log('start', { settings });
  await setMotion(MOTION_ORDER.includes(settings.motion) && settings.motion !== 'demo' ? settings.motion : 'sensor', { announce: true });
  toast('← → choose · Select activates · ↑ hides the bar', 3200);
}
$('b-start').addEventListener('click', start);

// ---------------------------------------------------------------------------
// Keys: the glasses deliver arrows and Enter; the app owns focus.

/**
 * Activate the current button (Enter / Select / tap). On the glasses a touchpad tap is also
 * delivered as a click on the canvas, which blurs the focused button, so the app's own
 * focusIndex is the source of truth, not document.activeElement. Debounced so keydown,
 * keyup and click for one tap never fire twice.
 */
let lastActivate = 0;
function activate(why) {
  const now = performance.now();
  if (now - lastActivate < 250) return;
  lastActivate = now;
  rlog.log('activate', { why, focus: document.activeElement && document.activeElement.id, index: focusIndex });
  if (!started) { start(); return; }
  const el = document.activeElement;
  if (el && el.matches('[data-focusable]')) el.click();
  else { focusButton(focusIndex); buttons[focusIndex].click(); }
}
// Clicking the canvas must not steal focus from the bar (preventDefault on pointerdown).
canvas.addEventListener('pointerdown', (e) => e.preventDefault());
const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Select', 'OK', 'Accept', 'NumpadEnter']);
const isActivateKey = (e) => ACTIVATE_KEYS.has(e.key) || e.keyCode === 13 || e.keyCode === 32 || e.code === 'Enter' || e.code === 'NumpadEnter';

// Every input event goes to the remote log so the glasses' key names can be read later.
for (const type of ['keydown', 'keyup']) {
  document.addEventListener(type, (e) => rlog.log('key', { type, key: e.key, code: e.code, keyCode: e.keyCode, trusted: e.isTrusted, target: e.target && e.target.id }), true);
}
document.addEventListener('click', (e) => {
  rlog.log('click', { target: e.target && (e.target.id || e.target.tagName), trusted: e.isTrusted, focus: document.activeElement && document.activeElement.id });
  // A tap that the shell delivers as a click outside the buttons still means "select".
  if (!(e.target && e.target.closest && e.target.closest('button'))) activate('click-elsewhere');
}, true);
for (const type of ['pointerdown', 'pointerup']) {
  document.addEventListener(type, (e) => rlog.log('pointer', { type, pt: e.pointerType, x: Math.round(e.clientX), y: Math.round(e.clientY), trusted: e.isTrusted, target: e.target && (e.target.id || e.target.tagName) }), true);
}
// A tap on the canvas (pointer down + up without moving) also selects.
let tapStart = null;
canvas.addEventListener('pointerdown', (e) => { tapStart = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener('pointerup', (e) => {
  if (!tapStart) return;
  const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  if (moved < 12 && performance.now() - tapStart.t < 400) activate('canvas-tap');
  tapStart = null;
});
// Some shells only send keyup for the select key.
document.addEventListener('keyup', (e) => { if (isActivateKey(e)) { e.preventDefault(); activate(`keyup:${e.key}`); } });

document.addEventListener('keydown', (e) => {
  const inStart = !started;
  if (isActivateKey(e)) { e.preventDefault(); activate(`keydown:${e.key}`); return; }
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      if (!inStart) { if (!barVisible()) showBar(true); focusButton(focusIndex - 1); }
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (!inStart) { if (!barVisible()) showBar(true); focusButton(focusIndex + 1); }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (!inStart) showBar(false);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (!inStart) { showBar(true); focusButton(focusIndex); }
      break;
    case 'Escape':
    case 'Backspace':
      // No history entries of our own, so the shell shows its system menu on Back.
      if (!inStart && barVisible()) { e.preventDefault(); showBar(false); }
      break;
    // Desktop conveniences (never produced by the glasses)
    case '1': case '2': case '3': case '4':
      if (!inStart) setMode(['locked', 'world', 'lazy', 'level'][Number(e.key) - 1]);
      break;
    case 'c': case 'C':
      if (!inStart) head.resetHead();
      break;
  }
});

// Keep sensors off while the app is in the background; re-attach when it returns.
document.addEventListener('visibilitychange', () => {
  if (head.motion !== 'sensor') return;
  if (document.hidden) head.disableSensor();
  else head.enableSensor();
});

// ---------------------------------------------------------------------------
// Frame loop

const clock = new THREE.Clock();
let fps = 0, hudTimer = 0;
function updateHud(q, dt) {
  fps = fps ? fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 1 / Math.max(dt, 1e-3);
  hudTimer += dt;
  if (hudTimer < 0.15 || hud.classList.contains('hidden')) return;
  hudTimer = 0;
  const e = yprFromQuat(q);
  const s = head.sensor;
  const src = head.motion === 'sensor'
    ? (s.has ? `${s.source}${s.hasYaw || s.source === 'gyro' ? '' : ' (no yaw)'}` : `waiting · perm ${s.permission}`)
    : head.motion + (autoDemo ? ' (auto)' : '');
  const f1 = (v) => (v === null || v === undefined ? '—' : v.toFixed(0));
  hud.innerHTML =
    `<b>${MODE_SHORT[params.mode]}</b> · ${CONTENT_SHORT[params.content]}
` +
    `head  <b>${fmtDeg(-e.yaw, true)}</b> / <b>${fmtDeg(e.pitch, true)}</b> / <b>${fmtDeg(e.roll, true)}</b>
` +
    `offset ${fmtDeg(display.contentOffset())} · ${src} · axes ${head.fixId}
` +
    `perm ${s.permission} · ask fn ${s.permFn || '?'} ×${s.asked}${s.lastResult ? ` → ${s.lastResult} ${(s.askMs / 1000).toFixed(1)}s` : ''} · listen ${s.listening ? 'yes' : 'no'}
` +
    `orient ${s.events} ev · ${s.rate.toFixed(0)}/s · αβγ ${f1(s.alpha)} ${f1(s.beta)} ${f1(s.gamma)}${s.absolute ? ' abs' : ''}
` +
    `motion ${s.motionEvents} ev · ${s.motionRate.toFixed(0)}/s · gyro ${s.hasGyro ? 'yes' : 'no'} · grav ${s.hasGravity ? 'yes' : 'no'}
` +
    `${fps.toFixed(0)} fps`;
}

/**
 * Rotary-encoder style detents: the head pose is quantised to the content grid with
 * hysteresis, so sensor jitter never moves the content and a deliberate turn clicks one
 * card over. The detent changes when the continuous angle is ENTER (65 %) of a step past
 * the current detent centre; it takes a 30 % back-swing to return, so the edge cannot chatter.
 */
const detent = {
  yaw: 0, pitch: 0, // current detent indices
  reset() { this.yaw = 0; this.pitch = 0; },
  step(axis, value, size) {
    const centre = this[axis] * size;
    const d = value - centre;
    if (Math.abs(d) > 0.65 * size) this[axis] += Math.sign(d) * Math.max(1, Math.floor((Math.abs(d) - 0.65 * size) / size) + 1);
    return this[axis] * size;
  },
};
const _qSnap = new THREE.Quaternion();
function snapPose(q) {
  const e = yprFromQuat(q);
  const size = SNAP_STEP[params.content] || SNAP_STEP.workspace;
  return quatFromYPR(_qSnap, detent.step('yaw', e.yaw, size.yaw), detent.step('pitch', e.pitch, size.pitch), 0);
}

const _prevQ = new THREE.Quaternion();
let logTimer = 0, lastSource = 'none', hadPrev = false;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (autoDemo && head.sensor.has) {
    autoDemo = false;
    setMotion(SOURCE_MODE[motionChoice] ? motionChoice : 'sensor', { announce: false });
    toast(`Head sensor connected (${head.sensor.source})`);
  }
  const q = head.update(dt);
  // Remote log: source changes, pose jumps, and a 5 Hz sample stream
  if (head.sensor.source !== lastSource) { lastSource = head.sensor.source; rlog.log('source', rawSample()); }
  if (hadPrev) {
    const jump = angleBetween(_prevQ, q);
    if (jump > 20) rlog.log('jump', { deg: Math.round(jump), dt: Math.round(dt * 1000), ...rawSample() });
  }
  _prevQ.copy(q); hadPrev = true;
  logTimer += dt;
  if (logTimer >= 0.2) { logTimer = 0; rlog.log('s', { fps: Math.round(fps), ...rawSample() }); }
  display.update(params.mode === 'snap' ? snapPose(q) : q, dt);
  content.update(dt);
  content.anchor.quaternion.copy(display.anchor);
  renderer.setViewport(0, 0, SIZE, SIZE);
  renderer.render(content.scene, display.camera);
  updateHud(q, dt);
}

setLabel('b-mode', MODE_BTN[params.mode]);
setLabel('b-content', CONTENT_BTN[params.content]);
setAxesLabels();
setHud(!!settings.hud);
display.recenter();
renderer.setAnimationLoop(frame);
$('b-start').focus({ preventScroll: true });

// Exposed for the smoke test
window.__glasses = { params, display, content, head, renderer, start, setMode, setContent, setMotion };
