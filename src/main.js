import * as THREE from 'three';
import { HeadInput } from './head.js';
import { buildWorld, EYE_HEIGHT } from './world.js';
import { ContentLayer } from './content.js';
import { DisplayModel } from './display.js';
import { initXR } from './xr.js';
import { bindUI, toast } from './ui.js';
import { yprFromQuat, fmtDeg } from './math.js';

// ---------------------------------------------------------------------------
// Parameters (everything the panel edits lives here)

const params = {
  mode: 'world',
  content: 'workspace',
  fov: 20,          // Ray-Ban Display: ~20° diagonal, 600 × 600 px
  offsetH: 12,      // display centre, degrees right of straight ahead (approximate)
  offsetV: -8,      // degrees below straight ahead (approximate)
  roll: 0,
  distance: 2.0,    // perceived focal distance of the overlay, metres (virtual)
  brightness: 1.0,
  occlusion: 0.35,
  vignette: 0.6,
  showBounds: true,
  rightEyeOnly: true,
  lazyDeadzone: 8,
  lazySpeed: 5,
  demoMotion: false,
  eyeFov: 70,
};

// ---------------------------------------------------------------------------
// Renderer, scene, cameras

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.autoClear = true;

const scene = new THREE.Scene();
const eye = new THREE.PerspectiveCamera(params.eyeFov, 1, 0.05, 600);
eye.position.set(0, EYE_HEIGHT, 0);
scene.add(eye); // the overlay is a child of the eye camera

const world = buildWorld();
scene.add(world);

const content = new ContentLayer();
content.setPreset(params.content);

const display = new DisplayModel(params);
eye.add(display.overlay);

const head = new HeadInput(canvas);
head.onReset = () => display.recenter();

// ---------------------------------------------------------------------------
// Optional camera passthrough (phone / webcam) as the background

let video = null, videoTexture = null, videoStream = null;
async function toggleCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
    scene.background = null;
    videoTexture.dispose();
    videoTexture = null;
    world.visible = true;
    ui.setButtonActive('b-camera', false);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera needs a secure context (https or localhost).');
    return;
  }
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false });
  } catch (err) {
    toast(`Camera unavailable: ${err.name || err}`);
    return;
  }
  video = video || Object.assign(document.createElement('video'), { playsInline: true, muted: true, autoplay: true });
  video.srcObject = videoStream;
  await video.play().catch(() => {});
  videoTexture = new THREE.VideoTexture(video);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  scene.background = videoTexture;
  world.visible = false;
  ui.setButtonActive('b-camera', true);
  fitVideo();
}
function fitVideo() {
  if (!videoTexture || !video.videoWidth) return;
  const va = video.videoWidth / video.videoHeight;
  const ca = window.innerWidth / window.innerHeight;
  if (ca > va) { videoTexture.repeat.set(1, va / ca); videoTexture.offset.set(0, (1 - va / ca) / 2); }
  else { videoTexture.repeat.set(ca / va, 1); videoTexture.offset.set((1 - ca / va) / 2, 0); }
}

// ---------------------------------------------------------------------------
// UI

const ui = bindUI(params, {
  modeChanged(mode) {
    if (mode === 'world') display.recenter();
    display.lazyFollowing = false;
  },
  setContent(name) { content.setPreset(name); display.recenter(); },
  recenter() { display.recenter(); toast('Content recentred in the display'); },
  resetHead() { head.resetHead(); },
  demoMotion(on) { head.demoMotion = on; },
  async toggleGyro() {
    if (head.gyro.enabled) {
      head.disableGyro();
      ui.setButtonActive('b-gyro', false);
      return;
    }
    const ok = await head.enableGyro();
    ui.setButtonActive('b-gyro', ok);
    toast(ok ? 'Gyro on — hold the phone up like a viewfinder' : 'Gyro not available (needs https and a phone).');
  },
  toggleCamera,
  async savePNG() {
    const blob = await display.exportPNG(renderer);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `demidof-${params.mode}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Saved 600 × 600 device frame');
  },
});

// ---------------------------------------------------------------------------
// WebXR

let xrMode = null;
initXR(renderer, document.getElementById('b-xr'), document.getElementById('xr-note'), {
  onStart(mode) {
    xrMode = mode;
    if (mode === 'immersive-ar') {
      world.visible = false;
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    xrRecenter = true;
  },
  onEnd() {
    xrMode = null;
    world.visible = !videoTexture;
    eye.position.set(0, EYE_HEIGHT, 0);
    eye.quaternion.identity();
    display.overlay.layers.set(0);
    display.bounds.layers.set(0);
    resize();
  },
  onSelect() { display.recenter(); },
});
let xrRecenter = false;

// ---------------------------------------------------------------------------
// Resize

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  eye.aspect = w / h;
  eye.updateProjectionMatrix();
  fitVideo();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Readouts

const ro = {
  head: document.getElementById('ro-head'),
  display: document.getElementById('ro-display'),
  offset: document.getElementById('ro-offset'),
  fps: document.getElementById('ro-fps'),
};
let fps = 0, roTimer = 0;
function updateReadouts(headQuat, dt) {
  fps = fps ? fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 1 / Math.max(dt, 1e-3);
  roTimer += dt;
  if (roTimer < 0.1) return;
  roTimer = 0;
  const e = yprFromQuat(headQuat);
  ro.head.textContent = `${fmtDeg(-e.yaw, true)} / ${fmtDeg(e.pitch, true)} / ${fmtDeg(e.roll, true)}`;
  const d = yprFromQuat(display.camera.quaternion);
  ro.display.textContent = `${fmtDeg(-d.yaw, true)} / ${fmtDeg(d.pitch, true)}`;
  ro.offset.textContent = fmtDeg(display.contentOffset());
  ro.fps.textContent = fps.toFixed(0);
}

// ---------------------------------------------------------------------------
// Frame loop

const clock = new THREE.Clock();
const _headQuat = new THREE.Quaternion();
const PREVIEW_CSS = () => (window.innerWidth < 820 ? 150 : 240);

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const presenting = renderer.xr.isPresenting;

  // 1. Head orientation
  if (presenting) {
    renderer.xr.getCamera().getWorldQuaternion(_headQuat);
    if (xrRecenter) { xrRecenter = false; display.update(_headQuat, 0); display.recenter(); }
  } else {
    _headQuat.copy(head.update(dt));
    eye.quaternion.copy(_headQuat);
    if (eye.fov !== params.eyeFov) { eye.fov = params.eyeFov; eye.updateProjectionMatrix(); }
  }

  // 2. Display pose, anchoring, content
  display.update(_headQuat, dt);
  content.update(dt);

  // 3. Render the 600×600 device frame
  display.renderContent(renderer, content);

  // 4. Render the wearer's view with the overlay
  if (presenting) {
    const layer = params.rightEyeOnly ? 2 : 0;
    display.overlay.layers.set(layer);
    display.bounds.layers.set(layer);
    renderer.render(scene, eye);
    return;
  }
  const dpr = renderer.getPixelRatio();
  const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
  renderer.setViewport(0, 0, W, H);
  renderer.setClearColor(0x0b0d10, 1);
  renderer.render(scene, eye);

  // 5. Device-frame preview, bottom-left
  const s = Math.round(PREVIEW_CSS() * dpr), m = Math.round(16 * dpr);
  display.renderPreview(renderer, m, m, s, s);
  renderer.setViewport(0, 0, W, H);

  updateReadouts(_headQuat, dt);
}

renderer.setAnimationLoop(frame);
toast('Drag to look around · press 1–4 to switch anchoring modes', 4000);

// Expose for debugging / automated checks
window.__demidof = { params, display, content, head, renderer, scene, eye };
