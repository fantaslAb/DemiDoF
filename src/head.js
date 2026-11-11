import * as THREE from 'three';
import { DEG, RAD, quatFromYPR, yprFromQuat, clamp } from './math.js';

const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qDemo = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _zee = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° about X

/**
 * Produces the wearer's head orientation from whichever input is active:
 *   - pointer drag / keyboard (desktop & touch)
 *   - DeviceOrientation (phone gyro)
 *   - scripted demo motion (added on top)
 * In WebXR the head pose is supplied by the session instead (see main.js).
 */
export class HeadInput {
  constructor(element) {
    this.element = element;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.quaternion = new THREE.Quaternion();

    this.gyro = { enabled: false, alpha: 0, beta: 0, gamma: 0, has: false, yawOffset: 0 };
    this.demoMotion = false;
    this.sensitivity = 0.18; // degrees per CSS pixel
    this.keys = new Set();
    this.onReset = null;

    this._drag = null;
    this._time = 0;
    this._bind();
  }

  _bind() {
    const el = this.element;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      el.setPointerCapture(e.pointerId);
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      // Dragging the world: move pointer right -> look right (yaw decreases).
      this.yaw -= dx * this.sensitivity;
      this.pitch = clamp(this.pitch - dy * this.sensitivity, -85, 85);
    });
    const up = (e) => { if (this._drag && e.pointerId === this._drag.id) this._drag = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Request gyro permission (iOS needs a user gesture) and start listening. */
  async enableGyro() {
    if (this.gyro.enabled) return true;
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch (err) {
      console.warn('gyro permission', err);
      return false;
    }
    this._onOrient = (e) => {
      if (e.alpha === null || e.alpha === undefined) return;
      this.gyro.alpha = e.alpha;
      this.gyro.beta = e.beta;
      this.gyro.gamma = e.gamma;
      if (!this.gyro.has) {
        this.gyro.has = true;
        this.resetHead(); // make the current heading "forward"
      }
    };
    window.addEventListener('deviceorientation', this._onOrient, true);
    this.gyro.enabled = true;
    return true;
  }

  disableGyro() {
    if (!this.gyro.enabled) return;
    window.removeEventListener('deviceorientation', this._onOrient, true);
    this.gyro.enabled = false;
    this.gyro.has = false;
  }

  /** Make the current heading the new forward direction. */
  resetHead() {
    if (this.gyro.enabled && this.gyro.has) {
      this._gyroQuat(_q);
      this.gyro.yawOffset = -yprFromQuat(_q).yaw;
    } else {
      this.yaw = 0;
      this.pitch = 0;
      this.roll = 0;
    }
    if (this.onReset) this.onReset();
  }

  _gyroQuat(target) {
    const g = this.gyro;
    const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    _euler.set(g.beta * DEG, g.alpha * DEG, -g.gamma * DEG, 'YXZ');
    target.setFromEuler(_euler);
    target.multiply(_q1);
    target.multiply(_q0.setFromAxisAngle(_zee, -orient * DEG));
    return target;
  }

  update(dt) {
    this._time += dt;
    const k = this.keys;
    const spd = 60 * dt; // deg/s
    if (k.has('ArrowLeft')) this.yaw += spd;
    if (k.has('ArrowRight')) this.yaw -= spd;
    if (k.has('ArrowUp')) this.pitch = clamp(this.pitch + spd, -85, 85);
    if (k.has('ArrowDown')) this.pitch = clamp(this.pitch - spd, -85, 85);
    if (k.has('KeyQ')) this.roll += spd;
    if (k.has('KeyE')) this.roll -= spd;

    if (this.gyro.enabled && this.gyro.has) {
      this._gyroQuat(_q);
      quatFromYPR(_qYaw, this.gyro.yawOffset, 0, 0);
      this.quaternion.copy(_qYaw).multiply(_q);
    } else {
      quatFromYPR(this.quaternion, this.yaw, this.pitch, this.roll);
    }

    if (this.demoMotion) {
      const t = this._time;
      quatFromYPR(_qDemo, 28 * Math.sin(t * 0.45), 7 * Math.sin(t * 0.9 + 1), 5 * Math.sin(t * 0.7));
      this.quaternion.multiply(_qDemo);
    }
    return this.quaternion;
  }
}
