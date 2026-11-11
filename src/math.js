import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

const _euler = new THREE.Euler();

/**
 * Quaternion from yaw / pitch / roll in degrees.
 * Convention (three.js, camera looks down -Z):
 *   yaw   > 0  turns the view to the LEFT  (rotation about +Y)
 *   pitch > 0  tilts the view UP            (rotation about +X)
 *   roll  > 0  rolls counter-clockwise      (rotation about +Z)
 * Order is yaw, then pitch, then roll (Euler 'YXZ').
 */
export function quatFromYPR(target, yawDeg, pitchDeg, rollDeg) {
  _euler.set(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, 'YXZ');
  return target.setFromEuler(_euler);
}

/** Decompose a quaternion into { yaw, pitch, roll } in degrees (Euler 'YXZ'). */
export function yprFromQuat(q) {
  _euler.setFromQuaternion(q, 'YXZ');
  return { yaw: _euler.y * RAD, pitch: _euler.x * RAD, roll: _euler.z * RAD };
}

/** Angle in degrees between two orientations. */
export function angleBetween(a, b) {
  return a.angleTo(b) * RAD;
}

/** Half-width of a plane (in metres) that subtends `deg` degrees at `distance`. */
export function angularSize(deg, distance) {
  return 2 * distance * Math.tan((deg * DEG) / 2);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fmtDeg(v, signed = false) {
  const s = Math.abs(v) < 0.05 ? 0 : v;
  const str = `${Math.abs(s).toFixed(1)}°`;
  if (!signed) return (s < 0 ? '−' : '') + str;
  return (s < 0 ? '−' : '+') + str;
}
