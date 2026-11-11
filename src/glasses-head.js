import * as THREE from 'three';
import { DEG, quatFromYPR, yprFromQuat, clamp } from './math.js';

/**
 * Head orientation for the on-glasses build.
 *
 * Sources, in order of preference:
 *   - 'sensor' : the glasses' IMU. Orientation events (`deviceorientation` /
 *                `deviceorientationabsolute`) when they arrive; otherwise the gyroscope from
 *                `devicemotion` (rotationRate) integrated over time, levelled with gravity.
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
const _qStep = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _v = new THREE.Vector3();
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

/** Seconds of silence after which orientation events are considered gone. */
const ORIENT_STALE_S = 1.0;

export class GlassesHead {
  constructor(element) {
    this.element = element;
    this.quaternion = new THREE.Quaternion();
    this.motion = 'manual'; // 'sensor' | 'demo' | 'manual'
    this.frameIndex = 0;
    this.smoothing = 0.045; // seconds; time constant of the pose filter (0 = off)

    // manual (drag) orientation
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.sensitivity = 0.12; // degrees per CSS pixel

    this.sensor = {
      listening: false,
      permission: 'unknown', // 'unknown' | 'pending' | 'granted' | 'denied'
      has: false,            // at least one usable sample (orientation or gyro) has arrived
      source: 'none',        // 'orientation' | 'gyro' | 'none'
      yawOffset: 0,
      // orientation events
      alpha: 0, beta: 0, gamma: 0, hasYaw: false, absolute: false,
      events: 0, lastAt: 0, rate: 0, eventType: null,
      // devicemotion events
      motionEvents: 0, motionLastAt: 0, motionRate: 0, hasGyro: false, hasGravity: false,
      rr: { a: 0, b: 0, g: 0 }, grav: { x: 0, y: 0, z: 0 },
    };
    this._gyroQuat = new THREE.Quaternion(); // integrated device orientation (device → world)
    this._gyroSeeded = false;
    this._target = new THREE.Quaternion();
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

  /** True when any motion-sensor API exists at all. */
  static sensorAvailable() {
    return typeof DeviceOrientationEvent !== 'undefined' || typeof DeviceMotionEvent !== 'undefined';
  }

  /**
   * Start listening for orientation + motion events and, where the browser requires it, ask
   * for permission (the call must come from a user gesture on the glasses and on iOS).
   *
   * Listeners are attached immediately: events only flow once permission exists, so attaching
   * early is harmless and keeps a slow or hanging prompt from blocking the app. Resolves to
   * false only when the APIs are missing or permission was refused.
   */
  async enableSensor() {
    if (!GlassesHead.sensorAvailable()) return false;
    if (this.sensor.listening) return true;
    const s = this.sensor;

    this._onOrient = (e) => {
      // Prefer whichever event type fired first; ignore the other to avoid double samples.
      if (s.eventType && s.eventType !== e.type && (performance.now() - s.lastAt) / 1000 < ORIENT_STALE_S) return;
      s.eventType = e.type;
      const hasAlpha = e.alpha !== null && e.alpha !== undefined;
      const hasBeta = e.beta !== null && e.beta !== undefined;
      if (!hasAlpha && !hasBeta) return; // an empty event: the sensor is not actually delivering
      s.hasYaw = hasAlpha;
      s.alpha = hasAlpha ? e.alpha : 0;
      s.beta = hasBeta ? e.beta : 0;
      s.gamma = e.gamma === null || e.gamma === undefined ? 0 : e.gamma;
      s.absolute = !!e.absolute || e.type === 'deviceorientationabsolute';
      const now = performance.now();
      if (s.lastAt) s.rate = s.rate * 0.9 + (1000 / Math.max(now - s.lastAt, 1)) * 0.1;
      s.lastAt = now;
      s.events++;
      if (s.source !== 'orientation') { s.source = 'orientation'; this.resetHead(); }
      if (!s.has) { s.has = true; this.resetHead(); }
    };
    this._onMotion = (e) => {
      const now = performance.now();
      const rr = e.rotationRate, g = e.accelerationIncludingGravity;
      const hasRR = rr && rr.alpha !== null && rr.alpha !== undefined;
      const hasG = g && g.x !== null && g.x !== undefined;
      if (!hasRR && !hasG) return;
      if (s.motionLastAt) s.motionRate = s.motionRate * 0.9 + (1000 / Math.max(now - s.motionLastAt, 1)) * 0.1;
      const dt = s.motionLastAt ? Math.min((now - s.motionLastAt) / 1000, 0.1) : 0;
      s.motionLastAt = now;
      s.motionEvents++;
      if (hasG) { s.hasGravity = true; s.grav.x = g.x; s.grav.y = g.y; s.grav.z = g.z; }
      if (hasRR) { s.hasGyro = true; s.rr.a = rr.alpha; s.rr.b = rr.beta; s.rr.g = rr.gamma; }
      // Gyro integration is only used while orientation events are absent.
      const orientFresh = s.lastAt && (now - s.lastAt) / 1000 < ORIENT_STALE_S;
      if (orientFresh || !hasRR) return;
      this._integrateGyro(dt);
      if (s.source !== 'gyro') { s.source = 'gyro'; this.resetHead(); }
      if (!s.has) { s.has = true; this.resetHead(); }
    };
    if (typeof DeviceOrientationEvent !== 'undefined') {
      window.addEventListener('deviceorientation', this._onOrient, true);
      window.addEventListener('deviceorientationabsolute', this._onOrient, true);
    }
    if (typeof DeviceMotionEvent !== 'undefined') window.addEventListener('devicemotion', this._onMotion, true);
    s.listening = true;
    s.permission = 'granted';

    const asks = [];
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      asks.push(DeviceOrientationEvent.requestPermission());
    }
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      asks.push(DeviceMotionEvent.requestPermission());
    }
    if (asks.length) {
      s.permission = 'pending';
      let granted = false;
      for (const ask of asks) {
        try { if ((await ask) === 'granted') granted = true; } catch (err) { console.warn('sensor permission', err); }
      }
      s.permission = granted ? 'granted' : 'denied';
      if (!granted) { this.disableSensor(); return false; }
    }
    return true;
  }

  disableSensor() {
    const s = this.sensor;
    if (!s.listening) return;
    window.removeEventListener('deviceorientation', this._onOrient, true);
    window.removeEventListener('deviceorientationabsolute', this._onOrient, true);
    window.removeEventListener('devicemotion', this._onMotion, true);
    s.listening = false;
    s.has = false;
    s.source = 'none';
    s.eventType = null;
    s.lastAt = 0; s.motionLastAt = 0; s.rate = 0; s.motionRate = 0;
    this._gyroSeeded = false;
  }

  /** Seconds since the last usable sensor sample, or Infinity. */
  sensorAge() {
    const s = this.sensor;
    if (!s.has) return Infinity;
    return (performance.now() - Math.max(s.lastAt, s.motionLastAt)) / 1000;
  }

  /**
   * Integrate rotationRate (deg/s about the device x/y/z axes = beta/gamma/alpha) into a
   * device→world quaternion in the same convention the orientation events use. On the
   * first sample the attitude is levelled from gravity so pitch and roll start correct.
   */
  _integrateGyro(dt) {
    const s = this.sensor;
    if (!this._gyroSeeded) {
      if (s.hasGravity) {
        // Gravity in device axes gives beta / gamma (same formulas as the W3C spec's examples).
        const { x, y, z } = s.grav;
        const beta = Math.atan2(y, z) / DEG;              // front-back tilt
        const gamma = Math.atan2(-x, Math.hypot(y, z)) / DEG; // left-right tilt
        _euler.set(beta * DEG, 0, -gamma * DEG, 'YXZ');
      } else {
        _euler.set(90 * DEG, 0, 0, 'YXZ'); // assume upright
      }
      this._gyroQuat.setFromEuler(_euler);
      this._gyroSeeded = true;
      return;
    }
    if (!(dt > 0)) return;
    // Body-frame angular velocity: x = beta, y = gamma, z = alpha (deg/s)
    _v.set(s.rr.b * DEG, s.rr.g * DEG, s.rr.a * DEG);
    const w = _v.length();
    if (w < 1e-6) return;
    _qStep.setFromAxisAngle(_v.multiplyScalar(1 / w), w * dt);
    this._gyroQuat.multiply(_qStep).normalize();
  }

  /** Make the current heading the new forward direction. */
  resetHead() {
    if (this.motion === 'sensor' && this.sensor.has) {
      this._sensorQuat(_q);
      this.sensor.yawOffset = -yprFromQuat(_q).yaw;
    } else {
      this.yaw = 0; this.pitch = 0; this.roll = 0;
    }
    this._time = 0;
    this._snap = true;
    if (this.onReset) this.onReset();
  }

  _sensorQuat(target) {
    const s = this.sensor;
    const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (s.source === 'gyro') {
      target.copy(this._gyroQuat);
    } else {
      _euler.set(s.beta * DEG, s.alpha * DEG, -s.gamma * DEG, 'YXZ');
      target.setFromEuler(_euler);
    }
    target.multiply(_qScreen);
    target.multiply(_q0.setFromAxisAngle(_zee, -orient * DEG));
    target.multiply(this.frame.fix);
    return target;
  }

  update(dt) {
    this._time += dt;
    const t = this._target;
    if (this.motion === 'sensor' && this.sensor.has) {
      this._sensorQuat(_q);
      quatFromYPR(_qYaw, this.sensor.yawOffset, 0, 0);
      t.copy(_qYaw).multiply(_q);
    } else {
      quatFromYPR(t, this.yaw, this.pitch, this.roll);
    }
    if (this.motion === 'demo') {
      const tt = this._time;
      quatFromYPR(_qDemo, 28 * Math.sin(tt * 0.45), 7 * Math.sin(tt * 0.9 + 1), 5 * Math.sin(tt * 0.7));
      t.multiply(_qDemo);
    }
    // Low-pass the pose: sensor events arrive at their own rate and may be noisy.
    if (this._snap || this.smoothing <= 0) { this.quaternion.copy(t); this._snap = false; }
    else this.quaternion.slerp(t, 1 - Math.exp(-dt / this.smoothing));
    return this.quaternion;
  }
}
