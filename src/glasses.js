import * as THREE from 'three';
import { ContentLayer } from './content.js';
import { DisplayModel } from './display.js';
import { GlassesHead, FRAMES } from './glasses-head.js';
import { yprFromQuat, fmtDeg } from './math.js';

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
const MOTION_ORDER = ['sensor', 'demo', 'manual'];
const MOTION_SHORT = { sensor: 'Sensor', demo: 'Demo', manual: 'Drag' };

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
  if (started) settings.motion = head.motion; // before Start the head is still in its initial state
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
  persist();
}
function setContent(name) {
  params.content = name;
  content.setPreset(name);
  display.recenter();
  setLabel('b-content', CONTENT_BTN[name]);
  toast(CONTENT_SHORT[name]);
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
const SENSOR_GRACE_S = 2.5;   // seconds without events after permission before falling back
const SENSOR_PROMPT_S = 20;   // longest we wait on a permission prompt before falling back
async function setMotion(mode, { announce = true } = {}) {
  clearTimeout(sensorWatchdog);
  if (mode === 'sensor') {
    if (!GlassesHead.sensorAvailable()) {
      if (announce) toast('Head sensor not available here. Using demo motion.');
      return setMotion('demo', { announce: false });
    }
    head.motion = 'sensor';
    setLabel('b-motion', MOTION_SHORT.sensor);
    persist();
    // Permission can hang (headless), be refused, or be granted while no events ever arrive
    // (desktop, Meta's simulator). Fall back to demo motion in all three cases.
    const t0 = performance.now();
    const check = () => {
      if (head.motion !== 'sensor' || head.sensor.has) return;
      const waited = (performance.now() - t0) / 1000;
      const pending = head.sensor.permission === 'pending' && waited < SENSOR_PROMPT_S;
      if (pending || waited < SENSOR_GRACE_S) { sensorWatchdog = setTimeout(check, 250); return; }
      toast('No head-sensor data. Using demo motion. Head button switches back.');
      setMotion('demo', { announce: false });
    };
    sensorWatchdog = setTimeout(check, 250);
    const ok = await head.enableSensor();
    if (!ok && head.motion === 'sensor') {
      clearTimeout(sensorWatchdog);
      if (announce) toast('Sensor permission refused. Using demo motion.');
      return setMotion('demo', { announce: false });
    }
    return;
  }
  head.disableSensor();
  head.motion = mode;
  head.resetHead();
  setLabel('b-motion', MOTION_SHORT[mode]);
  persist();
}

$('b-mode').addEventListener('click', () => setMode(MODE_ORDER[(MODE_ORDER.indexOf(params.mode) + 1) % MODE_ORDER.length]));
$('b-content').addEventListener('click', () => setContent(CONTENT_ORDER[(CONTENT_ORDER.indexOf(params.content) + 1) % CONTENT_ORDER.length]));
$('b-recenter').addEventListener('click', () => { head.resetHead(); toast('Recentred: this way is forward'); });
$('b-motion').addEventListener('click', () => setMotion(MOTION_ORDER[(MOTION_ORDER.indexOf(head.motion) + 1) % MOTION_ORDER.length]));
$('b-frame').addEventListener('click', () => {
  head.nextFrame();
  setFrameLabel();
  persist();
  toast(`Sensor axes: ${FRAMES[head.frameIndex].label}`);
});
$('b-hud').addEventListener('click', () => setHud(hud.classList.contains('hidden')));

// ---------------------------------------------------------------------------
// Start (the sensor permission must come from a user gesture)

async function start() {
  if (started) return;
  started = true;
  $('start').classList.add('hidden');
  showBar(true);
  focusButton(0);
  await setMotion(settings.motion === 'manual' ? 'manual' : 'sensor', { announce: true });
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
  const src = head.motion === 'sensor' ? (head.sensor.has ? `sensor ${head.sensor.events}` : 'sensor · waiting') : head.motion;
  hud.innerHTML =
    `<b>${MODE_SHORT[params.mode]}</b> · ${CONTENT_SHORT[params.content]}\n` +
    `head  <b>${fmtDeg(-e.yaw, true)}</b> / <b>${fmtDeg(e.pitch, true)}</b> / <b>${fmtDeg(e.roll, true)}</b>\n` +
    `offset ${fmtDeg(display.contentOffset())} · ${src}\n` +
    `${fps.toFixed(0)} fps · ${FRAMES[head.frameIndex].id}`;
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const q = head.update(dt);
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
