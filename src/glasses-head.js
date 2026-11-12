import * as THREE from 'three';
import { DEG, quatFromYPR, yprFromQuat, clamp } from './math.js';

/**
 * Head tracker for the on-glasses build: the wearer's head orientation, as stable and as
 * immediate as the glasses' sensors allow.
 *
 * Signal chain (device frame D: X right, Y up, Z towards the wearer; gaze is -Z):
 *
 *   gyroscope (devicemotion.rotationRate, ~60 Hz)
 *     -> channels mapped to device axes (GYRO_AXES, measured on the glasses)
 *     -> bias removed (estimated while the head is still)
 *     -> integrated into q_WD (device -> Earth)
 *     -> tilt pulled towards measured gravity (slow, only while |a| is close to g)
 *   per frame:
 *     -> predicted forward by the display latency (omega * predict)
 *     -> yaw offset from the last recenter
 *     -> adaptive low-pass: heavy when still (no jitter), light when moving (no lag)
 *
 * Heading comes from the gyroscope alone. The orientation events are NOT fused: on the
 * Ray-Ban Display their heading turns the opposite way to the gyroscope and jumps near
 * beta = 90, which made the content spin. A tap (recenter) removes the slow yaw drift.
 *
 * Without a gyroscope the orientation events are used directly; without any sensor the
 * pose comes from pointer drag (desktop testing).
 */

const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();
const _qCorr = new THREE.Quaternion();
const _q0 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _zee = new THREE.Vector3(0, 0, 1);
const _qScreen = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90 deg about X: Earth (Z up) -> three.js (Y up)

/** Seconds of silence after which a sensor stream is considered gone. */
const STALE_S = 1.0;
const G = 9.81;

/**
 * Which rotationRate field is the rate about device X, Y, Z (and its sign).
 * The W3C spec says alpha = Z, beta = X, gamma = Y. The Ray-Ban Display's WebView delivers
 * alpha = X, beta = Y, gamma = Z (measured: nodding shows in alpha and matches the change
 * of gravity; turning shows in beta; tilting the head sideways shows in gamma).
 * `?gyro=spec` in the URL switches to the spec mapping.
 */
export const GYRO_AXES = {
  device: { x: ['a', 1], y: ['b', 1], z: ['g', 1] },
  spec: { x: ['b', 1], y: ['g', 1], z: ['a', 1] },
};

/** Tunables (seconds unless noted). Exposed as `tracker.tune` for the readout and tests. */
export const DEFAULT_TUNE = {
  predict: 0.030,      // forward prediction by angular velocity: sensor -> display latency
  tauRest: 0.120,      // output low-pass time constant when the head is still
  tauFast: 0.012,      // ... when the head moves quickly
  speedScale: 25,      // deg/s at which the low-pass has moved most of the way to tauFast
  gravityTau: 1.5,     // tilt correction towards measured gravity
  gravityTol: 0.08,    // trust gravity only while | |a| / g - 1 | is below this
  biasStillDps: 4,     // "still" = raw gyro magnitude below this (deg/s) ...
  biasStillS: 0.6,     // ... for at least this long before the bias estimate updates
  biasTau: 3.0,        // bias estimate time constant
  restDeadbandDps: 0.5, // rates below this (after bias removal) are treated as zero: no drift at rest
  orientTau: 0.15,     // low-pass when only orientation events exist
};

export class HeadTracker {
  constructor(element, { gyroAxes = 'device' } = {}) {
    this.element = element;
    this.quaternion = new THREE.Quaternion(); // output: camera orientation, three.js world
    this.tune = { ...DEFAULT_TUNE };
    this.axesName = GYRO_AXES[gyroAxes] ? gyroAxes : 'device';
    this.axes = GYRO_AXES[this.axesName];
    this.yawOffset = 0;
    this.sensitivity = 0.12; // drag: degrees per CSS pixel

    this.sensor = {
      listening: false,
      permission: 'unknown', // 'unknown' | 'pending' | 'granted' | 'denied' | 'none'
      permFn: null, asked: 0, askMs: 0, lastResult: '',
      source: 'none',        // 'gyro' | 'orientation' | 'none'
      has: false,
      // orientation events
      alpha: 0, beta: 0, gamma: 0, absolute: false, events: 0, lastAt: 0, rate: 0, eventType: null,
      // devicemotion events
      motionEvents: 0, motionLastAt: 0, motionRate: 0, hasGyro: false, hasGravity: false,
      rr: { a: 0, b: 0, g: 0 }, grav: { x: 0, y: 0, z: 0 },
    };
    this.bias = { x: 0, y: 0, z: 0 }; // deg/s about device X, Y, Z
    this.speed = 0;                   // |omega| after bias removal, deg/s
    this.tau = this.tune.tauRest;     // current output time constant (readout)
    this.gravityUsed = 0;             // recent fraction of samples where gravity was trusted
    this._omega = new THREE.Vector3(); // rad/s, device frame, bias removed
    this._raw3 = new THREE.Vector3();  // deg/s, device frame, bias not removed
    this._qWD = new THREE.Quaternion();
    this._seeded = false;
    this._stillFor = 0;
    this._target = new THREE.Quaternion();
    this._snap = true;

    // drag (desktop fallback)
    this.yaw = 0; this.pitch = 0;
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

  // ---------------------------------------------------------------------------
  // Sensors

  static sensorAvailable() {
    return typeof DeviceOrientationEvent !== 'undefined' || typeof DeviceMotionEvent !== 'undefined';
  }

  /**
   * Ask for permission (must run inside a user gesture) and attach the listeners once it
   * resolves 'granted'. Resolves to false when the APIs are missing or permission was refused.
   */
  async enableSensor() {
    if (!HeadTracker.sensorAvailable()) return false;
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
      try { result = await ask.call(); } catch (err) { result = `error: ${err && err.message || err}`; }
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

  disableSensor() {
    const s = this.sensor;
    if (!s.listening) return;
    window.removeEventListener('deviceorientation', this._onOrient, true);
    window.removeEventListener('deviceorientationabsolute', this._onOrient, true);
    window.removeEventListener('devicemotion', this._onMotion, true);
    s.listening = false; s.has = false; s.source = 'none'; s.eventType = null;
    s.lastAt = 0; s.motionLastAt = 0; s.rate = 0; s.motionRate = 0;
    this._seeded = false;
  }

  _makeHandlers() {
    if (this._onOrient) return;
    const s = this.sensor;
    this._onOrient = (e) => {
      // Prefer whichever event type fired first; ignore the other to avoid double samples.
      if (s.eventType && s.eventType !== e.type && (performance.now() - s.lastAt) / 1000 < STALE_S) return;
      const hasAlpha = e.alpha !== null && e.alpha !== undefined;
      const hasBeta = e.beta !== null && e.beta !== undefined;
      if (!hasAlpha && !hasBeta) return;
      s.eventType = e.type;
      s.alpha = hasAlpha ? e.alpha : 0;
      s.beta = hasBeta ? e.beta : 0;
      s.gamma = e.gamma === null || e.gamma === undefined ? 0 : e.gamma;
      s.absolute = !!e.absolute || e.type === 'deviceorientationabsolute';
      const now = performance.now();
      if (s.lastAt) s.rate = s.rate * 0.9 + (1000 / Math.max(now - s.lastAt, 1)) * 0.1;
      s.lastAt = now;
      s.events++;
      const gyroFresh = s.hasGyro && s.motionLastAt && (now - s.motionLastAt) / 1000 < STALE_S;
      if (gyroFresh) return; // the gyroscope owns the pose; orientation is only a fallback
      this._setSource('orientation');
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
      if (!hasRR) return;
      s.hasGyro = true;
      s.rr.a = rr.alpha; s.rr.b = rr.beta || 0; s.rr.g = rr.gamma || 0;
      this._step(dt);
      this._setSource('gyro');
    };
  }

  _setSource(src) {
    const s = this.sensor;
    if (s.source !== src) { s.source = src; this.resetHead(); } // frame changed: re-zero yaw
    if (!s.has) { s.has = true; this.resetHead(); }
  }

  // ---------------------------------------------------------------------------
  // Fusion (runs on every devicemotion sample)

  /** Gyro rates about device X, Y, Z in deg/s, bias not removed. */
  _rates(target) {
    const r = this.sensor.rr, m = this.axes;
    return target.set(r[m.x[0]] * m.x[1], r[m.y[0]] * m.y[1], r[m.z[0]] * m.z[1]);
  }

  /** Measured "up" in D from accelerationIncludingGravity (upright glasses -> +Y). */
  _upD(target) {
    const g = this.sensor.grav;
    target.set(g.x, g.y, g.z);
    return target.lengthSq() > 1 ? target.normalize() : target.set(0, 1, 0);
  }

  /** Forward gaze in Earth frame from the orientation events: Rz(a) Rx(b) Ry(g) [0,0,-1]. */
  _orientForwardW(target) {
    const s = this.sensor;
    const a = s.alpha * DEG, b = s.beta * DEG, g = s.gamma * DEG;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    target.set(-(ca * sg + sa * sb * cg), ca * sb * cg - sa * sg, -(cb * cg));
    return target.lengthSq() > 1e-9 ? target.normalize() : target.set(0, 1, 0);
  }

  _updateBias(dt, raw) {
    const t = this.tune;
    if (raw.length() > t.biasStillDps) { this._stillFor = 0; return; }
    this._stillFor += dt;
    if (this._stillFor < t.biasStillS) return;
    const k = Math.min(1, dt / t.biasTau);
    this.bias.x += (raw.x - this.bias.x) * k;
    this.bias.y += (raw.y - this.bias.y) * k;
    this.bias.z += (raw.z - this.bias.z) * k;
  }

  _step(dt) {
    const s = this.sensor, t = this.tune;
    if (!this._seeded) {
      // Level from gravity; the heading is arbitrary until the first recenter.
      if (s.hasGravity) this._qWD.setFromUnitVectors(this._upD(_v), _zee); else this._qWD.identity();
      this._seeded = true;
      return;
    }
    if (!(dt > 0)) return;
    const raw = this._rates(this._raw3);
    this._updateBias(dt, raw);
    const b = this.bias;
    this._omega.set((raw.x - b.x) * DEG, (raw.y - b.y) * DEG, (raw.z - b.z) * DEG);
    let w = this._omega.length();
    this.speed = w / DEG;
    if (this.speed < t.restDeadbandDps) { this._omega.set(0, 0, 0); w = 0; }
    if (w > 1e-6) {
      _qStep.setFromAxisAngle(_v.copy(this._omega).multiplyScalar(1 / w), w * dt);
      this._qWD.multiply(_qStep).normalize(); // body-frame rates: q <- q * dq
    }
    if (s.hasGravity) {
      // Tilt: q' = q * R(up_meas -> up_pred), so that q' maps measured up to Earth Z.
      // Skip samples where the head accelerates (|a| far from g): they do not show "up".
      const gs = s.grav, mag = Math.hypot(gs.x, gs.y, gs.z) / G;
      const ok = Math.abs(mag - 1) < t.gravityTol;
      this.gravityUsed += ((ok ? 1 : 0) - this.gravityUsed) * Math.min(1, dt);
      if (ok) {
        _v2.copy(_zee).applyQuaternion(_q0.copy(this._qWD).invert());
        this._upD(_v3);
        _qCorr.setFromUnitVectors(_v3, _v2);
        _q0.identity().slerp(_qCorr, 1 - Math.exp(-dt / t.gravityTau));
        this._qWD.multiply(_q0).normalize();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Output

  /** Raw camera orientation in the three.js world (no yaw offset, no prediction). */
  _raw(target) {
    const s = this.sensor;
    if (s.source === 'gyro') return target.copy(_qScreen).multiply(this._qWD);
    if (s.source === 'orientation') {
      const f = this._orientForwardW(_v);
      const heading = Math.atan2(f.x, f.y);
      const pitch = Math.atan2(f.z, Math.hypot(f.x, f.y));
      return quatFromYPR(target, -heading / DEG, pitch / DEG, 0);
    }
    return quatFromYPR(target, this.yaw, this.pitch, 0);
  }

  /** The way the wearer looks right now becomes "forward". */
  resetHead() {
    if (this.sensor.has) this.yawOffset = -yprFromQuat(this._raw(_q)).yaw;
    else { this.yaw = 0; this.pitch = 0; }
    this._snap = true;
    if (this.onReset) this.onReset();
  }

  update(dt) {
    const s = this.sensor, t = this.tune, out = this._target;
    this._raw(out);
    const gyroBased = s.source === 'gyro';
    if (gyroBased && t.predict > 0) {
      // Predict where the head will be when the frame is shown (omega is in the body frame).
      const w = this._omega.length();
      if (w > 1e-6) {
        _qStep.setFromAxisAngle(_v.copy(this._omega).multiplyScalar(1 / w), w * t.predict);
        out.multiply(_qStep);
      }
    }
    if (s.has) { quatFromYPR(_qYaw, this.yawOffset, 0, 0); out.premultiply(_qYaw); }
    // Adaptive low-pass (One Euro style): heavy when still, light when moving.
    let tau;
    if (gyroBased) tau = t.tauFast + (t.tauRest - t.tauFast) * Math.exp(-this.speed / t.speedScale);
    else if (s.source === 'orientation') tau = t.orientTau;
    else tau = 0;
    this.tau = tau;
    if (this._snap || tau <= 0) { this.quaternion.copy(out); this._snap = false; }
    else this.quaternion.slerp(out, 1 - Math.exp(-dt / tau));
    return this.quaternion;
  }
}
