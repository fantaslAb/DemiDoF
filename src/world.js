import * as THREE from 'three';
import { DEG } from './math.js';
import { textSprite } from './textures.js';

export const EYE_HEIGHT = 1.6;
const HORIZON = new THREE.Color('#8c9ab0');
const ZENITH = new THREE.Color('#121a2c');
const GROUND = new THREE.Color('#1c2129');

/** Procedural environment: gradient sky, graded ground grid, compass ring, landmarks. */
export function buildWorld() {
  const group = new THREE.Group();
  group.name = 'world';

  // Sky dome -------------------------------------------------------------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { zenith: { value: ZENITH }, horizon: { value: HORIZON }, warm: { value: new THREE.Color('#c99a6b') } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith; uniform vec3 horizon; uniform vec3 warm;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.2, 1.0);
          float t = pow(smoothstep(-0.05, 0.9, h), 0.6);
          vec3 c = mix(horizon, zenith, t);
          float band = exp(-abs(vDir.y - 0.02) * 22.0);
          c = mix(c, warm, band * 0.35);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    })
  );
  sky.frustumCulled = false;
  group.add(sky);

  // Ground grid ----------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.ShaderMaterial({
      uniforms: { base: { value: GROUND }, fog: { value: HORIZON } },
      vertexShader: /* glsl */ `
        varying vec2 vXZ; varying float vDist;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vXZ = wp.xz;
          vDist = length(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 base; uniform vec3 fog;
        varying vec2 vXZ; varying float vDist;
        float gridLine(vec2 p, float cell, float width) {
          vec2 g = abs(fract(p / cell - 0.5) - 0.5) / fwidth(p / cell);
          float l = min(g.x, g.y);
          return 1.0 - smoothstep(0.0, width, l);
        }
        void main() {
          float minor = gridLine(vXZ, 1.0, 1.2) * 0.22;
          float major = gridLine(vXZ, 5.0, 1.6) * 0.45;
          vec3 c = base + vec3(0.9, 0.95, 1.0) * max(minor, major);
          float f = 1.0 - exp(-vDist * 0.028);
          c = mix(c, fog, f);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  // Compass ring at eye height ------------------------------------------
  const R = 10;
  const ringPts = [];
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    ringPts.push(new THREE.Vector3(Math.sin(a) * R, EYE_HEIGHT, -Math.cos(a) * R));
  }
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35 })));

  const tickPts = [];
  for (let az = 0; az < 360; az += 5) {
    const a = az * DEG;
    const major = az % 15 === 0;
    const len = major ? 0.22 : 0.09;
    const x = Math.sin(a) * R, z = -Math.cos(a) * R;
    tickPts.push(new THREE.Vector3(x, EYE_HEIGHT - len, z), new THREE.Vector3(x, EYE_HEIGHT + len, z));
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tickPts), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4 })));

  const postGeo = new THREE.CylinderGeometry(0.035, 0.035, EYE_HEIGHT + 0.9, 8);
  const postMat = new THREE.MeshStandardMaterial({ color: '#9aa6b8', roughness: 0.6, metalness: 0.1 });
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let az = 0; az < 360; az += 30) {
    const a = az * DEG;
    const x = Math.sin(a) * R, z = -Math.cos(a) * R;
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(x, (EYE_HEIGHT + 0.9) / 2, z);
    group.add(post);
    const label = names[az] ? `${names[az]} ${az}°` : `${az}°`;
    const sprite = textSprite(label, { size: 0.42, color: names[az] ? '#5ad1ff' : '#e8ebf0', bg: 'rgba(10,12,16,0.65)' });
    sprite.position.set(x * 0.985, EYE_HEIGHT + 0.62, z * 0.985);
    group.add(sprite);
  }

  // Landmarks ------------------------------------------------------------
  const palette = ['#5ad1ff', '#ffb86b', '#7bffb0', '#ff7ba6', '#b48cff', '#ffd166'];
  const items = [
    { az: 12, dist: 7, w: 1.2, h: 2.2, d: 1.2 },
    { az: -35, dist: 9, w: 2.4, h: 1.0, d: 2.4 },
    { az: 60, dist: 12, w: 1.0, h: 3.5, d: 1.0 },
    { az: 150, dist: 8, w: 1.6, h: 1.6, d: 1.6 },
    { az: -120, dist: 11, w: 3.0, h: 0.8, d: 1.0 },
    { az: -80, dist: 6, w: 0.8, h: 2.8, d: 0.8 },
  ];
  items.forEach((it, i) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(it.w, it.h, it.d),
      new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: 0.7, metalness: 0.05 })
    );
    const a = it.az * DEG;
    mesh.position.set(Math.sin(a) * it.dist, it.h / 2, -Math.cos(a) * it.dist);
    mesh.rotation.y = -a;
    group.add(mesh);
  });

  // Lights ---------------------------------------------------------------
  group.add(new THREE.HemisphereLight('#c7d3e6', '#2a2f38', 1.1));
  const sun = new THREE.DirectionalLight('#ffe9c9', 1.4);
  sun.position.set(6, 12, 4);
  group.add(sun);

  return group;
}
