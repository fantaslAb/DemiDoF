import * as THREE from 'three';
import { quatFromYPR, yprFromQuat, angleBetween, angularSize } from './math.js';

export const MODES = {
  locked: 'Head-locked (stock 0 DoF)',
  world: 'World-locked (DemiDoF)',
  lazy: 'Lazy follow',
  level: 'Horizon-level',
};

const _dir = new THREE.Vector3();

/**
 * The simulated monocular display.
 *
 *  - `camera`  : a square camera with the display's FOV, pointing where the display points
 *                (head orientation × placement offset). It renders the content layer into
 *                `rt`, the exact 600×600 frame the glasses would receive.
 *  - `anchor`  : the orientation of the content group. The anchoring mode decides how it
 *                relates to `camera`: equal (head-locked), fixed (world-locked), tethered
 *                (lazy follow) or roll-free (horizon-level).
 *  - `overlay` : a quad attached to the wearer's eye camera that shows `rt` with a
 *                waveguide-like additive look. In WebXR it can be limited to the right eye.
 */
export class DisplayModel {
  constructor(params) {
    this.params = params;
    this.size = 600;

    this.rt = new THREE.WebGLRenderTarget(this.size, this.size, {
      samples: 4,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;

    this.camera = new THREE.PerspectiveCamera(params.fov, 1, 0.05, 100);
    this.placement = new THREE.Quaternion();
    this.anchor = new THREE.Quaternion();
    this.lazyFollowing = false;
    this._fov = -1;

    // Overlay quad (child of the eye camera)
    this.overlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.rt.texture },
        brightness: { value: 1 },
        occlusion: { value: 0.35 },
        vignette: { value: 0.6 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform float brightness; uniform float occlusion; uniform float vignette;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(map, vUv).rgb * brightness;
          vec2 p = vUv * 2.0 - 1.0;
          float r2 = dot(p, p);
          float v = 1.0 - vignette * smoothstep(0.45, 1.6, r2);
          c *= v;
          float lum = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
          gl_FragColor = vec4(c, lum * occlusion);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      toneMapped: false,
    });
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.overlayMaterial);
    this.overlay.renderOrder = 1000;
    this.overlay.frustumCulled = false;

    const b = 0.5;
    this.bounds = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-b, -b, 0), new THREE.Vector3(b, -b, 0), new THREE.Vector3(b, b, 0), new THREE.Vector3(-b, b, 0),
      ]),
      new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthTest: false, depthWrite: false })
    );
    this.bounds.renderOrder = 1001;
    this.bounds.frustumCulled = false;
    this.overlay.add(this.bounds);

    // Preview (device frame) drawn in a corner of the canvas
    this.previewScene = new THREE.Scene();
    this.previewCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
    this.previewScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.rt.texture })));

    this.updatePlacement();
  }

  /** Placement offset: UI uses + = right / + = up; three.js yaw + = left. */
  updatePlacement() {
    const p = this.params;
    quatFromYPR(this.placement, -p.offsetH, p.offsetV, p.roll);
  }

  /** Centre the content in the display right now (content → where the display looks). */
  recenter() {
    if (!this._updated) { this._pendingRecenter = true; return; } // before the first frame
    this.anchor.copy(this.camera.quaternion);
    this.lazyFollowing = false;
  }

  update(headQuat, dt) {
    const p = this.params;
    this.updatePlacement();
    this.camera.quaternion.copy(headQuat).multiply(this.placement);
    if (this._fov !== p.fov) {
      this._fov = p.fov;
      this.camera.fov = p.fov;
      this.camera.updateProjectionMatrix();
    }
    this._updated = true;
    if (this._pendingRecenter) { this._pendingRecenter = false; this.recenter(); }

    const cq = this.camera.quaternion;
    switch (p.mode) {
      case 'locked':
        this.anchor.copy(cq);
        break;
      case 'world':
      case 'snap': // world-locked; the caller quantises the head pose into detents
        break;
      case 'lazy': {
        const ang = angleBetween(this.anchor, cq);
        if (!this.lazyFollowing && ang > p.lazyDeadzone) this.lazyFollowing = true;
        if (this.lazyFollowing) {
          this.anchor.slerp(cq, 1 - Math.exp(-p.lazySpeed * dt));
          if (ang < 0.15) this.lazyFollowing = false;
        }
        break;
      }
      case 'level': {
        const e = yprFromQuat(cq);
        quatFromYPR(this.anchor, e.yaw, e.pitch, 0);
        break;
      }
    }

    // Overlay transform in eye space
    const d = p.distance;
    const s = angularSize(p.fov, d);
    this.overlay.quaternion.copy(this.placement);
    this.overlay.position.copy(_dir.set(0, 0, -d).applyQuaternion(this.placement));
    this.overlay.scale.set(s, s, 1);
    this.bounds.visible = p.showBounds;
    const u = this.overlayMaterial.uniforms;
    u.brightness.value = p.brightness;
    u.occlusion.value = p.occlusion;
    u.vignette.value = p.vignette;
  }

  /** Angular distance between where content is anchored and where the display looks. */
  contentOffset() {
    return angleBetween(this.anchor, this.camera.quaternion);
  }

  renderContent(renderer, content) {
    content.anchor.quaternion.copy(this.anchor);
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(content.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
  }

  /** Draw the device frame into a rectangle of the canvas (device pixels, origin bottom-left). */
  renderPreview(renderer, x, y, w, h) {
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(this.previewScene, this.previewCamera);
    renderer.setScissorTest(false);
  }

  /** Read back the 600×600 frame as a PNG blob. */
  exportPNG(renderer) {
    const w = this.size;
    const buf = new Uint8Array(w * w * 4);
    renderer.readRenderTargetPixels(this.rt, 0, 0, w, w, buf);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = w;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, w);
    for (let y = 0; y < w; y++) {
      const src = (w - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let i = 0; i < w * 4; i += 4) {
        img.data[dst + i] = buf[src + i];
        img.data[dst + i + 1] = buf[src + i + 1];
        img.data[dst + i + 2] = buf[src + i + 2];
        img.data[dst + i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
}
