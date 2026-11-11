import * as THREE from 'three';
import { ContentLayer } from './content.js';
import { DisplayModel } from './display.js';
import { GlassesHead, FRAMES } from './glasses-head.js';
import { RemoteLog } from './glasses-log.js';
import { yprFromQuat, fmtDeg, angleBetween } from './math.js';

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

const MODE_ORDER = ['world', 'locked', 'lazy', 'level'];
const MODE_SHORT = { world: 'World-locked', locked: 'Head-locked', lazy: 'Lazy follow', level: 'Horizon-level' };
const MODE_BTN = { world: 'World', locked: 'Head', lazy: 'Lazy', level: 'Level' };
const CONTENT_ORDER = ['workspace', 'hud', 'grid'];
const CONTENT_SHORT = { workspace: 'Workspace', hud: 'HUD demo', grid: 'Angular grid' };
const CONTENT_BTN = { workspace: 'Cards', hud: 'HUD', grid: 'Grid' };
const MOTION_ORDER = ['sensor', 'gyro', 'demo', 'manual'];
const MOTION_SHORT = { sensor: 'Sensor', gyro: 'Gyro', demo: 'Demo', manual: 'Drag' };
let motionChoice = 'sensor'; // what the Head button shows; 'gyro' is 'sensor' with head.preferGyro

// Remote log (serve.py appends it to logs/<date>.jsonl). `?log=0` turns it off.
const rlog = new RemoteLog({ enabled: new URLSearchParams(location.search).get('log') !== '0' });
rlog.log('load', { ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, url: location.href });

// ---------------------------------------------------------------------------
// Persisted settings

const STORE_KEY = 'demidof.glasses.v1';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage may be unavailable */ }
}
const settings = Object.assign({ mode: 'world', content: 'workspace', frame: 0, hud: false, motion: 'sensor' }, loadSettings());

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
head.frameIndex = Number.isInteger(settings.frame) ? settings.frame % FRAMES.length : 0;
head.onReset = () => display.recenter();
head.motion = 'manual';

// ---------------------------------------------------------------------------
// UI helpers

let started = false;
const bar = $('bar');
const hud = $('hud');
const buttons = [...bar.querySelectorAll('button')];
let focusIndex = 0;

function setLabel(id, text) { $(id).querySelector('b').textContent = text; }
function focusButton(i) {
  focusIndex = (i + buttons.length) % buttons.length;
  buttons[focusIndex].focus({ preventScroll: true });
}
function showBar(on) { bar.classList.toggle('hidden', !on); }
function barVisible() { return !bar.classList.contains('hidden'); }

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
  settings.frame = head.frameIndex;
  settings.hud = !hud.classList.contains('hidden');
  if (started) settings.motion = motionChoice; // before Start the head is still in its initial state
  saveSettings(settings);
}

// ---------------------------------------------------------------------------
// Actions

function setMode(mode) {
  params.mode = mode;
  display.lazyFollowing = false;
  if (mode === 'world') display.recenter();
  setLabel('b-mode', MODE_BTN[mode]);
  toast(MODE_SHORT[mode]);
  rlog.log('mode', { mode });
  persist();
}
function setContent(name) {
  params.content = name;
  content.setPreset(name);
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
function setFrameLabel() {
  setLabel('b-frame', `${head.frameIndex + 1} / ${FRAMES.length}`);
}

let sensorWatchdog = 0;
let autoDemo = false;         // demo motion chosen by the watchdog, not by the wearer
const SENSOR_GRACE_S = 6;     // seconds without samples after permission before falling back
const SENSOR_PROMPT_S = 30;   // longest we wait on a permission prompt before falling back
async function setMotion(mode, { announce = true, keepListening = false } = {}) {
  clearTimeout(sensorWatchdog);
  autoDemo = false;
  rlog.log('motion', { mode });
  if (mode === 'gyro' || mode === 'sensor') {
    motionChoice = mode;
    head.preferGyro = mode === 'gyro';
    if (head.sensor.listening) { head.sensor.has = false; head.sensor.source = 'none'; }
    mode = 'sensor';
  } else {
    motionChoice = mode;
    head.preferGyro = false;
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
$('b-recenter').addEventListener('click', () => { head.resetHead(); toast('Recentred: this way is forward'); rlog.log('recenter', rawSample()); });
$('b-motion').addEventListener('click', () => {
  // From the automatic fallback, one press re-requests the sensor (a user gesture is required).
  if (autoDemo) { head.disableSensor(); return setMotion(motionChoice === 'gyro' ? 'gyro' : 'sensor'); }
  setMotion(MOTION_ORDER[(MOTION_ORDER.indexOf(motionChoice) + 1) % MOTION_ORDER.length]);
});
$('b-frame').addEventListener('click', () => {
  head.nextFrame();
  setFrameLabel();
  persist();
  toast(`Sensor axes: ${FRAMES[head.frameIndex].label}`);
  rlog.log('axes', { index: head.frameIndex, id: FRAMES[head.frameIndex].id });
});

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
    so: (screen.orientation && screen.orientation.angle) || 0, axes: FRAMES[head.frameIndex].id,
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
  await setMotion(settings.motion === 'manual' || settings.motion === 'gyro' ? settings.motion : 'sensor', { announce: true });
  toast('← → choose · Select activates · ↑ hides the bar', 3200);
}
$('b-start').addEventListener('click', start);

// ---------------------------------------------------------------------------
// Keys: the glasses deliver arrows and Enter; the app owns focus.

document.addEventListener('keydown', (e) => {
  const inStart = !started;
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
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (inStart) { start(); break; }
      if (document.activeElement && document.activeElement.matches('[data-focusable]')) document.activeElement.click();
      else focusButton(focusIndex);
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
    `offset ${fmtDeg(display.contentOffset())} · ${src} · axes ${FRAMES[head.frameIndex].id}
` +
    `perm ${s.permission} · ask fn ${s.permFn || '?'} ×${s.asked}${s.lastResult ? ` → ${s.lastResult} ${(s.askMs / 1000).toFixed(1)}s` : ''} · listen ${s.listening ? 'yes' : 'no'}
` +
    `orient ${s.events} ev · ${s.rate.toFixed(0)}/s · αβγ ${f1(s.alpha)} ${f1(s.beta)} ${f1(s.gamma)}${s.absolute ? ' abs' : ''}
` +
    `motion ${s.motionEvents} ev · ${s.motionRate.toFixed(0)}/s · gyro ${s.hasGyro ? 'yes' : 'no'} · grav ${s.hasGravity ? 'yes' : 'no'}
` +
    `${fps.toFixed(0)} fps`;
}

const _prevQ = new THREE.Quaternion();
let logTimer = 0, lastSource = 'none', hadPrev = false;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (autoDemo && head.sensor.has) {
    autoDemo = false;
    setMotion(motionChoice === 'gyro' ? 'gyro' : 'sensor', { announce: false });
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
  display.update(q, dt);
  content.update(dt);
  content.anchor.quaternion.copy(display.anchor);
  renderer.setViewport(0, 0, SIZE, SIZE);
  renderer.render(content.scene, display.camera);
  updateHud(q, dt);
}

setLabel('b-mode', MODE_BTN[params.mode]);
setLabel('b-content', CONTENT_BTN[params.content]);
setFrameLabel();
setHud(!!settings.hud);
display.recenter();
renderer.setAnimationLoop(frame);
$('b-start').focus({ preventScroll: true });

// Exposed for the smoke test
window.__glasses = { params, display, content, head, renderer, start, setMode, setContent, setMotion };
