import { fmtDeg } from './math.js';

const $ = (id) => document.getElementById(id);

const FORMAT = {
  fov: (v) => fmtDeg(v),
  offsetH: (v) => fmtDeg(v, true),
  offsetV: (v) => fmtDeg(v, true),
  roll: (v) => fmtDeg(v, true),
  distance: (v) => `${v.toFixed(1)} m`,
  brightness: (v) => v.toFixed(2),
  occlusion: (v) => v.toFixed(2),
  vignette: (v) => v.toFixed(2),
  lazyDeadzone: (v) => fmtDeg(v),
  lazySpeed: (v) => v.toFixed(1),
  eyeFov: (v) => fmtDeg(v),
};

/** Wire the control panel to `params`; `actions` receives button presses. */
export function bindUI(params, actions) {
  // Sliders ---------------------------------------------------------------
  const sliders = {};
  for (const key of Object.keys(FORMAT)) {
    const input = $(`p-${key}`);
    const out = $(`o-${key}`);
    if (!input) continue;
    sliders[key] = input;
    const apply = () => {
      params[key] = parseFloat(input.value);
      out.textContent = FORMAT[key](params[key]);
    };
    input.addEventListener('input', apply);
    input.value = params[key];
    apply();
  }
  const setSlider = (key, value) => {
    params[key] = value;
    if (sliders[key]) {
      sliders[key].value = value;
      $(`o-${key}`).textContent = FORMAT[key](value);
    }
  };

  // Checkboxes ------------------------------------------------------------
  for (const key of ['showBounds', 'rightEyeOnly', 'demoMotion']) {
    const input = $(`p-${key}`);
    input.checked = params[key];
    input.addEventListener('change', () => {
      params[key] = input.checked;
      if (key === 'demoMotion') actions.demoMotion(input.checked);
    });
  }

  // Mode ------------------------------------------------------------------
  const radios = [...document.querySelectorAll('input[name="mode"]')];
  const setMode = (mode) => {
    params.mode = mode;
    radios.forEach((r) => (r.checked = r.value === mode));
    document.body.className = document.body.className.replace(/\bmode-\w+/g, '').trim();
    document.body.classList.add(`mode-${mode}`);
    actions.modeChanged(mode);
  };
  radios.forEach((r) => r.addEventListener('change', () => r.checked && setMode(r.value)));
  setMode(params.mode);

  // Content ---------------------------------------------------------------
  const content = $('p-content');
  content.value = params.content;
  content.addEventListener('change', () => {
    params.content = content.value;
    actions.setContent(content.value);
  });

  // Buttons ---------------------------------------------------------------
  $('b-recenter').addEventListener('click', actions.recenter);
  $('b-reset').addEventListener('click', actions.resetHead);
  $('b-preset-rbd').addEventListener('click', () => {
    setSlider('fov', 20); setSlider('offsetH', 12); setSlider('offsetV', -8); setSlider('roll', 0);
  });
  $('b-preset-center').addEventListener('click', () => {
    setSlider('offsetH', 0); setSlider('offsetV', 0); setSlider('roll', 0);
  });
  $('b-gyro').addEventListener('click', actions.toggleGyro);
  $('b-camera').addEventListener('click', actions.toggleCamera);
  $('b-png').addEventListener('click', actions.savePNG);

  // Panel toggle ----------------------------------------------------------
  const toggle = $('panel-toggle');
  toggle.addEventListener('click', () => document.body.classList.toggle('panel-hidden'));
  if (window.innerWidth < 820) document.body.classList.add('panel-hidden');

  // Keyboard shortcuts ----------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const modes = { Digit1: 'locked', Digit2: 'world', Digit3: 'lazy', Digit4: 'level' };
    if (modes[e.code]) setMode(modes[e.code]);
    else if (e.code === 'KeyC') actions.recenter();
    else if (e.code === 'KeyR') actions.resetHead();
    else if (e.code === 'KeyH') document.body.classList.toggle('panel-hidden');
  });

  return {
    setMode,
    setSlider,
    setButtonActive(id, on) { $(id).classList.toggle('active', !!on); },
  };
}

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
