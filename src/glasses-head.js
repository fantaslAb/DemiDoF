import * as THREE from 'three';
import { DEG, quatFromYPR, yprFromQuat, clamp } from './math.js';

/**
 * Head orientation for the on-glasses build.
 *
 * Sources, in order of preference:
 *   - 'sensor' : the glasses' IMU. Either orientation events (`deviceorientation` /
 *                `deviceorientationabsolute`) or the gyroscope from `devicemotion`
 *                (rotationRate) integrated over time and levelled with gravity.
 *   - 'demo'   : scripted motion, so the page visibly works in Meta's simulator and on desktop
 *   - 'manual' : pointer drag only (desktop / Neural Band drag)
 *
 * Frames. Raw sensor values are in the W3C device frame D (X right, Y top, Z out of the
 * screen). Orientation events and the integrated gyro both give q_WD: D → Earth frame W
 * (X east, Y north, Z up). `_qScreen` relabels W to the three.js world (Y up, -Z forward).
 * `fix` maps the camera's local axes into D and decides which sensor axis is the wearer's
 * yaw, pitch and roll. The sensor frame inside the glasses is not documented, so `axes`
 * lets the wearer pick which device axis points UP and which points RIGHT; UP can also
 * be taken from gravity when the head is recentred ('auto').
 */

const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qDemo = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();
const _qCorr = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _zee = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _qScreen = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° about X: Earth (Z up) → three.js (Y up)

/** Device-axis choices for the UP and RIGHT directions, in the W3C device frame. */
export const AXIS_VECTORS = {
  '+X': new THREE.Vector3(1, 0, 0), '-X': new THREE.Vector3(-1, 0, 0),
  '+Y': new THREE.Vector3(0, 1, 0), '-Y': new THREE.Vector3(0, -1, 0),
  '+Z': new THREE.Vector3(0, 0, 1), '-Z': new THREE.Vector3(0, 0, -1),
};
export const AXIS_NAMES = Object.keys(AXIS_VECTORS);
export const UP_CHOICES = ['auto', ...AXIS_NAMES];

/** Seconds of silence after which orientation events are considered gone. */
const ORIENT_STALE_S = 1.0;
/** Per-sample gain of the gravity correction on the integrated gyro (≈ 4 s time constant at 50 Hz). */
const GRAVITY_GAIN = 0.005;

export class GlassesHead {
  constructor(element) {
    this.element = element;
    this.quaternion = new THREE.Quaternion();
    this.motion = 'manual'; // 'sensor' | 'demo' | 'manual'
    this.preferGyro = false; // in 'sensor': integrate the gyroscope even when orientation events exist
    this.smoothing = 0.045;  // seconds; time constant of the pose filter (0 = off)

    // Which device axes are the wearer's UP and RIGHT. Defaults = an upright phone.
    this.axes = { up: 'auto', right: '+X' };
    this._fix = new THREE.Quaternion();  // camera → device
    this._upMeasured = new THREE.Vector3(0, 1, 0); // last gravity "up" captured at recenter (device frame)
    this.fixId = 'up:auto right:+X';

    // manual (drag) orientation
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.sensitivity = 0.12; // degrees per CSS pixel

    this.sensor = {
      listening: false,
      permission: 'unknown', // 'unknown' | 'pending' | 'granted' | 'denied' | 'none' (no API to ask)
      permFn: null,          // which requestPermission() exists on the glasses: 'orientation' | 'motion' | 'none'
      asked: 0, askMs: 0, lastResult: '',
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
    this._qWD = new THREE.Quaternion(); // integrated gyro: device → Earth
    this._gyroSeeded = false;
    this._target = new THREE.Quaternion();
    this.onReset = null;
    this._time = 0;
    this._drag = null;
    this._bind();
    this._rebuildFix();
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

  // ---------------------------------------------------------------------------
  // Axes

  get fix() { return this._fix; }

  /** Set which device axes are UP ('auto' = gravity at recenter) and RIGHT, then recenter. */
  setAxes(up, right) {
    if (up !== undefined && UP_CHOICES.includes(up)) this.axes.up = up;
    if (right !== undefined && AXIS_NAMES.includes(right)) this.axes.right = right;
    this._rebuildFix();
    this.resetHead();
  }

  /** True when the chosen UP and RIGHT are parallel, which cannot form a frame. */
  axesConflict() {
    const up = this._upVector(_v2);
    return Math.abs(up.dot(AXIS_VECTORS[this.axes.right])) > 0.9;
  }

  _upVector(target) {
    if (this.axes.up === 'auto') return target.copy(this._upMeasured);
    return target.copy(AXIS_VECTORS[this.axes.up]);
  }

  /** fix = basis [X_cam = right, Y_cam = up, Z_cam = right × up] expressed in D. */
  _rebuildFix() {
    const Y = this._upVector(new THREE.Vector3()).normalize();
    const X = AXIS_VECTORS[this.axes.right].clone();
    X.addScaledVector(Y, -Y.dot(X));
    if (X.lengthSq() < 0.05) {
      // Parallel choice: fall back to any axis perpendicular to up so the app keeps running.
      X.copy(Math.abs(Y.x) < 0.9 ? AXIS_VECTORS['+X'] : AXIS_VECTORS['+Y']);
      X.addScaledVector(Y, -Y.dot(X));
    }
    X.normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y);
    _m.makeBasis(X, Y, Z);
    this._fix.setFromRotationMatrix(_m);
    this.fixId = `up:${this.axes.up}${this.axes.up === 'auto' ? `(${fmtAxis(Y)})` : ''} right:${this.axes.right}`;
  }

  // ---------------------------------------------------------------------------
  // Sensors

  /** True when any motion-sensor API exists at all. */
  static sensorAvailable() {
    return typeof DeviceOrientationEvent !== 'undefined' || typeof DeviceMotionEvent !== 'undefined';
  }

  /**
   * Ask for sensor permission and start listening. Follows Meta's Web App guidance:
   * the request must come from a user gesture (Enter on a button), only one of the two
   * requestPermission() functions is needed, and listeners are attached once it resolves
   * 'granted'. Browsers without requestPermission() get the listeners immediately.
   * Resolves to false when the APIs are missing or permission was refused.
   */
  async enableSensor() {
    if (!GlassesHead.sensorAvailable()) return false;
    const s = this.sensor;
    if (s.listening) return true;
    this._makeHandlers();

    const hasDO = typeof DeviceOrientationEvent !== 'undefined';
    const hasDM = typeof DeviceMotionEvent !== 'undefined';
    const ask = hasDO && typeof DeviceOrientationEvent.requestPermission === 'function'
      ? { fn: 'orientation', call: () => DeviceOrientationEvent.requestPermission() }
      : hasDM && typeof DeviceMotionEvent.requestPermission === 'function'
        ? { fn: 'motion', call: () => DeviceMotionEvent.requestPermission() }
        : null;
    s.permFn = ask ? ask.fn : 'none';

    if (ask) {
      s.permission = 'pending';
      s.asked++;
      const t0 = performance.now();
      let result;
      try { result = await ask.call(); } catch (err) { console.warn('sensor permission', err); result = `error: ${err && err.message || err}`; }
      s.askMs = performance.now() - t0;
      s.lastResult = String(result);
      s.permission = result === 'granted' ? 'granted' : 'denied';
      if (s.permission !== 'granted') return false;
    } else {
      s.permission = 'none';
    }
    if (hasDO) {
      window.addEventListener('deviceorientation', this._onOrient, true);
      window.addEventListener('deviceorientationabsolute', this._onOrient, true);
    }
    if (hasDM) window.addEventListener('devicemotion', this._onMotion, true);
    s.listening = true;
    return true;
  }

  _makeHandlers() {
    if (this._onOrient) return;
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
      if (this.preferGyro) return; // orientation is recorded for the readout only
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
      // Gyro integration is used while orientation events are absent, or when preferred.
      const orientFresh = s.lastAt && (now - s.lastAt) / 1000 < ORIENT_STALE_S;
      if ((orientFresh && !this.preferGyro) || !hasRR) return;
      this._integrateGyro(dt);
      if (s.source !== 'gyro') { s.source = 'gyro'; this.resetHead(); }
      if (!s.has) { s.has = true; this.resetHead(); }
    };
  }

  disableSensor() {
    const s = this.sensor;
    if (!s.listening) { s.has = false; s.source = 'none'; return; }
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

  // ---------------------------------------------------------------------------
  // Gyro integration (device frame D → Earth frame W, both W3C)

  /** Body-frame angular velocity in D, radians per second. */
  _omega(target) {
    const r = this.sensor.rr;
    return target.set(r.b * DEG, r.g * DEG, r.a * DEG); // beta about X, gamma about Y, alpha about Z
  }

  /** Measured "up" in D from accelerationIncludingGravity (flat device at rest → +Z). */
  _upD(target) {
    const g = this.sensor.grav;
    target.set(g.x, g.y, g.z);
    return target.lengthSq() > 1 ? target.normalize() : target.set(0, 0, 1);
  }

  _integrateGyro(dt) {
    const s = this.sensor;
    if (!this._gyroSeeded) {
      // Level the attitude from gravity; heading is arbitrary until the first recenter.
      if (s.hasGravity) this._qWD.setFromUnitVectors(this._upD(_v), _zee);
      else this._qWD.identity();
      this._gyroSeeded = true;
      return;
    }
    if (!(dt > 0)) return;
    this._omega(_v);
    const w = _v.length();
    if (w > 1e-6) {
      _qStep.setFromAxisAngle(_v.multiplyScalar(1 / w), w * dt);
      this._qWD.multiply(_qStep).normalize(); // q ← q ⊗ Δq (body-frame rates)
    }
    if (s.hasGravity && GRAVITY_GAIN > 0) {
      // Pull the predicted up towards the measured up, slowly, so tilt does not drift.
      _v2.copy(_zee).applyQuaternion(_q0.copy(this._qWD).invert()); // predicted up in D
      this._upD(_v3);
      _qCorr.setFromUnitVectors(_v2, _v3);
      _q0.identity().slerp(_qCorr, GRAVITY_GAIN);
      this._qWD.multiply(_q0).normalize();
    }
  }

  // ---------------------------------------------------------------------------

  /** Make the current heading the new forward direction (and, with up:auto, capture gravity as UP). */
  resetHead() {
    if (this.axes.up === 'auto' && this.sensor.hasGravity) {
      this._upD(this._upMeasured);
      this._rebuildFix();
    }
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

  /** Camera orientation in the three.js world, before the yaw offset. */
  _sensorQuat(target) {
    const s = this.sensor;
    const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (s.source === 'gyro') {
      target.copy(_qScreen).multiply(this._qWD);               // three ← W ← D
    } else {
      _euler.set(s.beta * DEG, s.alpha * DEG, -s.gamma * DEG, 'YXZ');
      target.setFromEuler(_euler);                              // = _qScreen ⊗ q_WD ⊗ _qScreen⁻¹
      target.multiply(_qScreen);                                // three ← D
    }
    target.multiply(_q0.setFromAxisAngle(_zee, -orient * DEG)); // screen rotation (phones)
    target.multiply(this._fix);                                 // D ← camera
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

/** Nearest signed device axis of a vector, for the readout (e.g. "+Y"). */
function fmtAxis(v) {
  let best = '+X', bestDot = -2;
  for (const name of AXIS_NAMES) {
    const d = v.dot(AXIS_VECTORS[name]);
    if (d > bestDot) { bestDot = d; best = name; }
  }
  return best;
}
