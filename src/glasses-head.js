import * as THREE from 'three';
import { DEG, quatFromYPR, yprFromQuat, clamp } from './math.js';

/**
 * Head tracker for the on-glasses build: one job, the wearer's head orientation, as
 * stable and as immediate as the glasses' sensors allow.
 *
 * Signal chain (all in the W3C device frame D: X right, Y up, Z towards the wearer;
 * the wearer looks along -Z, which is confirmed on Meta Display Glasses):
 *
 *   gyroscope (devicemotion.rotationRate, ~60 Hz)
 *     → bias removed (estimated while the head is still)
 *     → integrated into q_WD (device → Earth)
 *     → tilt pulled towards gravity        (complementary filter, slow)
 *     → heading pulled towards the orientation events' forward vector (slower)
 *   per frame:
 *     → predicted forward by the display latency (ω · T_PREDICT)
 *     → yaw offset from the last recenter
 *     → adaptive low-pass: heavy when still (no jitter), light when moving (no lag)
 *
 * Without a gyroscope the orientation events' forward vector is used directly; without
 * any sensor the pose comes from pointer drag (desktop testing).
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
const _qScreen = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° about X: Earth (Z up) → three.js (Y up)

/** Seconds of silence after which a sensor stream is considered gone. */
const STALE_S = 1.0;

/** Tunables (seconds unless noted). Exposed as `tracker.tune` for the readout and tests. */
export const DEFAULT_TUNE = {
  predict: 0.030,      // forward prediction by angular velocity: sensor → display latency
  tauRest: 0.120,      // output low-pass time constant when the head is still
  tauFast: 0.012,      // … when the head moves quickly
  speedScale: 25,      // °/s at which the low-pass has moved most of the way to tauFast
  gravityTau: 2.0,     // tilt correction towards measured gravity
  headingTauRest: 2.5, // heading correction towards the orientation events, head still
  headingTauMove: 8.0, // … head moving (the compass lags during motion)
  biasStillDps: 4,     // "still" = raw gyro magnitude below this (°/s) …
  biasStillS: 0.8,     // … for at least this long before the bias estimate updates
  biasTau: 4.0,        // bias estimate time constant
  orientTau: 0.15,     // low-pass when only orientation events exist
};

export class HeadTracker {
  constructor(element) {
    this.element = element;
    this.quaternion = new THREE.Quaternion(); // output: camera orientation, three.js world
    this.tune = { ...DEFAULT_TUNE };
    this.yawOffset = 0;
    this.sensitivity = 0.12; // drag: degrees per CSS pixel

    this.sensor = {
      listening: false,
      permission: 'unknown', // 'unknown' | 'pending' | 'granted' | 'denied' | 'none'
      permFn: null, asked: 0, askMs: 0, lastResult: '',
      source: 'none',        // 'fused' | 'gyro' | 'orientation' | 'none'
      has: false,
      // orientation events
      alpha: 0, beta: 0, gamma: 0, absolute: false, events: 0, lastAt: 0, rate: 0, eventType: null,
      // devicemotion events
      motionEvents: 0, motionLastAt: 0, motionRate: 0, hasGyro: false, hasGravity: false,
      rr: { a: 0, b: 0, g: 0 }, grav: { x: 0, y: 0, z: 0 },
    };
    this.bias = { x: 0, y: 0, z: 0 }; // °/s about device X (beta), Y (gamma), Z (alpha)
    this.speed = 0;                   // |ω| after bias removal, °/s (drives the adaptive filter)
    this.tau = this.tune.tauRest;     // current output time constant (readout)
    this._omega = new THREE.Vector3(); // rad/s, device frame, bias removed
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
      if (gyroFresh) return; // the motion handler owns the pose
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
      s.rr.a = rr.alpha; s.rr.b = rr.beta; s.rr.g = rr.gamma;
      const orientFresh = s.lastAt && (now - s.lastAt) / 1000 < STALE_S;
      this._step(dt, orientFresh);
      this._setSource(orientFresh ? 'fused' : 'gyro');
    };
  }

  _setSource(src) {
    const s = this.sensor;
    const wasGyroBased = s.source === 'fused' || s.source === 'gyro';
    const isGyroBased = src === 'fused' || src === 'gyro';
    if (s.source !== src) {
      s.source = src;
      if (!(wasGyroBased && isGyroBased)) this.resetHead(); // frame changed: re-zero yaw
    }
    if (!s.has) { s.has = true; this.resetHead(); }
  }

  // ---------------------------------------------------------------------------
  // Fusion (runs on every devicemotion sample)

  /** Measured "up" in D from accelerationIncludingGravity (flat device at rest → +Z). */
  _upD(target) {
    const g = this.sensor.grav;
    target.set(g.x, g.y, g.z);
    return target.lengthSq() > 1 ? target.normalize() : target.set(0, 1, 0);
  }

  /** Forward gaze in Earth frame from the orientation events: Rz(α)·Rx(β)·Ry(γ)·[0,0,-1]. */
  _orientForwardW(target) {
    const s = this.sensor;
    const a = s.alpha * DEG, b = s.beta * DEG, g = s.gamma * DEG;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    target.set(-(ca * sg + sa * sb * cg), ca * sb * cg - sa * sg, -(cb * cg));
    return target.lengthSq() > 1e-9 ? target.normalize() : target.set(0, 1, 0);
  }

  _updateBias(dt) {
    const t = this.tune, r = this.sensor.rr;
    if (Math.hypot(r.b, r.g, r.a) > t.biasStillDps) { this._stillFor = 0; return; }
    this._stillFor += dt;
    if (this._stillFor < t.biasStillS) return;
    const k = Math.min(1, dt / t.biasTau);
    this.bias.x += (r.b - this.bias.x) * k;
    this.bias.y += (r.g - this.bias.y) * k;
    this.bias.z += (r.a - this.bias.z) * k;
  }

  _step(dt, fuse) {
    const s = this.sensor, t = this.tune;
    if (!this._seeded) {
      // Level from gravity; take the heading from the orientation events when they exist.
      if (s.hasGravity) this._qWD.setFromUnitVectors(this._upD(_v), _zee); else this._qWD.identity();
      if (fuse) {
        _v2.set(0, 0, -1).applyQuaternion(this._qWD);
        this._orientForwardW(_v3);
        this._qWD.premultiply(_qCorr.setFromUnitVectors(_v2, _v3)).normalize();
      }
      this._seeded = true;
      return;
    }
    if (!(dt > 0)) return;
    this._updateBias(dt);
    const r = this.sensor.rr, b = this.bias;
    this._omega.set((r.b - b.x) * DEG, (r.g - b.y) * DEG, (r.a - b.z) * DEG);
    const w = this._omega.length();
    this.speed = w / DEG;
    if (w > 1e-6) {
      _qStep.setFromAxisAngle(_v.copy(this._omega).multiplyScalar(1 / w), w * dt);
      this._qWD.multiply(_qStep).normalize(); // body-frame rates: q ← q ⊗ Δq
    }
    if (s.hasGravity) {
      // Tilt: q' = q ⊗ R(up_meas → up_pred) so that q'·up_meas = Z.
      _v2.copy(_zee).applyQuaternion(_q0.copy(this._qWD).invert());
      this._upD(_v3);
      _qCorr.setFromUnitVectors(_v3, _v2);
      _q0.identity().slerp(_qCorr, 1 - Math.exp(-dt / t.gravityTau));
      this._qWD.multiply(_q0).normalize();
    }
    if (fuse) {
      // Heading (and residual tilt): world-frame pull of the forward vector towards the
      // orientation events' forward vector. Slower while moving: the compass lags.
      const moving = clamp(this.speed / t.speedScale, 0, 1);
      const tau = t.headingTauRest + (t.headingTauMove - t.headingTauRest) * moving;
      _v2.set(0, 0, -1).applyQuaternion(this._qWD);
      this._orientForwardW(_v3);
      _qCorr.setFromUnitVectors(_v2, _v3);
      _q0.identity().slerp(_qCorr, 1 - Math.exp(-dt / tau));
      this._qWD.premultiply(_q0).normalize();
    }
  }

  // ---------------------------------------------------------------------------
  // Output

  /** Raw camera orientation in the three.js world (no yaw offset, no prediction). */
  _raw(target) {
    const s = this.sensor;
    if (s.source === 'fused' || s.source === 'gyro') return target.copy(_qScreen).multiply(this._qWD);
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
    const gyroBased = s.source === 'fused' || s.source === 'gyro';
    if (gyroBased && t.predict > 0) {
      // Predict where the head will be when the frame is shown.
      const w = this._omega.length();
      if (w > 1e-6) {
        // ω is in D; the camera frame equals D here (forward -Z, up +Y), so apply it in body frame.
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
