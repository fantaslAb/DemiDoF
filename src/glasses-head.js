import * as THREE from 'three';
import { DEG, quatFromYPR, yprFromQuat, clamp } from './math.js';

/**
 * Head orientation for the on-glasses build.
 *
 * Sources, in order of preference:
 *   - 'sensor' : DeviceOrientationEvent from the glasses' IMU (or a phone, for testing)
 *   - 'demo'   : scripted motion, so the page visibly works in Meta's simulator and on desktop
 *   - 'manual' : pointer drag only (desktop / Neural Band drag)
 *
 * The W3C orientation frame is defined for a phone screen; the sensor frame inside the
 * glasses is not documented. `FRAMES` lists corrections for the plausible mountings and the
 * menu lets the wearer cycle them until yaw / pitch / roll respond correctly.
 */

const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qDemo = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _zee = new THREE.Vector3(0, 0, 1);
const _xee = new THREE.Vector3(1, 0, 0);
const _yee = new THREE.Vector3(0, 1, 0);
const _q0 = new THREE.Quaternion();
const _qScreen = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° about X (three.js DeviceOrientationControls)

const rx = (deg) => new THREE.Quaternion().setFromAxisAngle(_xee, deg * DEG);
const ry = (deg) => new THREE.Quaternion().setFromAxisAngle(_yee, deg * DEG);

export const FRAMES = [
  { id: 'upright', label: 'Upright · screen faces wearer', fix: new THREE.Quaternion() },
  { id: 'upright-flipped', label: 'Upright · screen faces away', fix: ry(180) },
  { id: 'flat-forward', label: 'Flat · top edge forward', fix: rx(90) },
  { id: 'flat-back', label: 'Flat · top edge backward', fix: rx(90).multiply(ry(180)) },
  { id: 'flat-left', label: 'Flat · top edge left', fix: rx(90).multiply(ry(90)) },
  { id: 'flat-right', label: 'Flat · top edge right', fix: rx(90).multiply(ry(-90)) },
];

export class GlassesHead {
  constructor(element) {
    this.element = element;
    this.quaternion = new THREE.Quaternion();
    this.motion = 'manual'; // 'sensor' | 'demo' | 'manual'
    this.frameIndex = 0;

    // manual (drag) orientation
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.sensitivity = 0.12; // degrees per CSS pixel

    this.sensor = { listening: false, has: false, permission: 'unknown', alpha: 0, beta: 0, gamma: 0, yawOffset: 0, events: 0, lastAt: 0 };
    this.onReset = null;
    this._time = 0;
    this._drag = null;
    this._bind();
  }

  _bind() {
    const el = this.element;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      try { el.setPointerCapture(e.pointerId); } catch { /* not all browsers */ }
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      this.yaw -= dx * this.sensitivity;
      this.pitch = clamp(this.pitch - dy * this.sensitivity, -85, 85);
    });
    const up = (e) => { if (this._drag && e.pointerId === this._drag.id) this._drag = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  get frame() { return FRAMES[this.frameIndex]; }
  setFrame(i) { this.frameIndex = ((i % FRAMES.length) + FRAMES.length) % FRAMES.length; this.resetHead(); }
  nextFrame() { this.setFrame(this.frameIndex + 1); }

  /** True when DeviceOrientationEvent exists at all. */
  static sensorAvailable() { return typeof DeviceOrientationEvent !== 'undefined'; }

  /**
   * Start listening for orientation events and, where the browser requires it, ask for
   * permission (the call must come from a user gesture on the glasses and on iOS).
   *
   * The listener is attached immediately: events only flow once permission exists, so
   * attaching early is harmless and keeps a slow or hanging prompt from blocking the app.
   * Resolves to false only when the API is missing or permission was refused.
   */
  async enableSensor() {
    if (!GlassesHead.sensorAvailable()) return false;
    if (this.sensor.listening) return true;
    this._onOrient = (e) => {
      if (e.alpha === null || e.alpha === undefined) return;
      const s = this.sensor;
      s.alpha = e.alpha; s.beta = e.beta || 0; s.gamma = e.gamma || 0;
      s.events++;
      s.lastAt = performance.now();
      if (!s.has) { s.has = true; this.resetHead(); }
    };
    window.addEventListener('deviceorientation', this._onOrient, true);
    this.sensor.listening = true;
    this.sensor.permission = 'granted';
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      this.sensor.permission = 'pending';
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        this.sensor.permission = res === 'granted' ? 'granted' : 'denied';
      } catch (err) {
        console.warn('sensor permission', err);
        this.sensor.permission = 'denied';
      }
      if (this.sensor.permission === 'denied') { this.disableSensor(); return false; }
    }
    return true;
  }

  disableSensor() {
    if (!this.sensor.listening) return;
    window.removeEventListener('deviceorientation', this._onOrient, true);
    this.sensor.listening = false;
    this.sensor.has = false;
  }

  /** Seconds since the last sensor event, or Infinity. */
  sensorAge() { return this.sensor.has ? (performance.now() - this.sensor.lastAt) / 1000 : Infinity; }

  /** Make the current heading the new forward direction. */
  resetHead() {
    if (this.motion === 'sensor' && this.sensor.has) {
      this._sensorQuat(_q);
      this.sensor.yawOffset = -yprFromQuat(_q).yaw;
    } else {
      this.yaw = 0; this.pitch = 0; this.roll = 0;
    }
    this._time = 0;
    if (this.onReset) this.onReset();
  }

  _sensorQuat(target) {
    const s = this.sensor;
    const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    _euler.set(s.beta * DEG, s.alpha * DEG, -s.gamma * DEG, 'YXZ');
    target.setFromEuler(_euler);
    target.multiply(_qScreen);
    target.multiply(_q0.setFromAxisAngle(_zee, -orient * DEG));
    target.multiply(this.frame.fix);
    return target;
  }

  update(dt) {
    this._time += dt;
    if (this.motion === 'sensor' && this.sensor.has) {
      this._sensorQuat(_q);
      quatFromYPR(_qYaw, this.sensor.yawOffset, 0, 0);
      this.quaternion.copy(_qYaw).multiply(_q);
    } else {
      quatFromYPR(this.quaternion, this.yaw, this.pitch, this.roll);
    }
    if (this.motion === 'demo') {
      const t = this._time;
      quatFromYPR(_qDemo, 28 * Math.sin(t * 0.45), 7 * Math.sin(t * 0.9 + 1), 5 * Math.sin(t * 0.7));
      this.quaternion.multiply(_qDemo);
    }
    return this.quaternion;
  }
}
