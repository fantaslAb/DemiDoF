// Headless smoke test: serves the repo, loads the app in Chromium (SwiftShader WebGL),
// drives it through every anchoring mode / content preset, and writes screenshots to
// test-output/. Then loads glasses.html (the on-device build) at 600 x 600, feeds it
// synthetic IMU events and drives its menu with arrow keys. Fails on any page error or
// console error.
//
//   npm install && npx playwright install chromium && npm test

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-output');
const PORT = 8765;
mkdirSync(OUT, { recursive: true });

const server = spawn('python', ['serve.py', '--port', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await sleep(800);

const errors = [];
let browser;
try {
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__demidof && window.__demidof.renderer.info.render.frame > 5, null, { timeout: 15000 });

  const shot = async (name) => { await sleep(250); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const set = (fn) => page.evaluate(fn);

  await shot('01-default-world-workspace');

  // Turn the head 20° right: world-locked content should slide out of the display
  await set(() => { window.__demidof.head.yaw = -20; });
  await shot('02-world-yaw-right-20');

  await page.keyboard.press('Digit1'); // head-locked
  await shot('03-locked-yaw-right-20');

  await page.keyboard.press('Digit3'); // lazy follow (still catching up)
  await set(() => { window.__demidof.head.yaw = 0; });
  await shot('04-lazy');

  await page.keyboard.press('Digit4'); // horizon-level with roll
  await set(() => { window.__demidof.head.roll = 18; });
  await shot('05-level-roll-18');

  await set(() => { const h = window.__demidof.head; h.roll = 0; h.yaw = 0; h.pitch = 0; });
  await page.selectOption('#p-content', 'hud');
  await page.keyboard.press('Digit2');
  await shot('06-hud-world');

  await page.selectOption('#p-content', 'grid');
  await page.keyboard.press('Digit1');
  await shot('07-grid-locked');

  // Exercise PNG export path (no download, just the readback)
  const png = await set(async () => {
    const d = window.__demidof;
    const blob = await d.display.exportPNG(d.renderer);
    return blob.size;
  });
  if (!(png > 1000)) errors.push(`PNG export too small: ${png}`);

  const stats = await set(() => {
    const d = window.__demidof;
    return { frames: d.renderer.info.render.frame, calls: d.renderer.info.render.calls, offset: d.display.contentOffset() };
  });
  console.log('render stats', stats);

  // -------------------------------------------------------------------------
  // Glasses build: the page is the 600 x 600 display, driven by arrows + Enter.
  const g = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
  g.on('pageerror', (e) => errors.push(`glasses pageerror: ${e.message}`));
  g.on('console', (m) => { if (m.type() === 'error') errors.push(`glasses console: ${m.text()}`); });
  await g.goto(`http://127.0.0.1:${PORT}/glasses.html`, { waitUntil: 'load' });
  await g.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5, null, { timeout: 15000 });
  const gshot = async (name) => { await sleep(250); await g.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const gset = (fn, arg) => g.evaluate(fn, arg);

  await gshot('g1-start');
  // Headless Chromium answers the sensor permission with "denied"; pretend the wearer granted it.
  await gset(() => { DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted'); });
  await g.keyboard.press('Enter'); // Start: attaches the orientation listener
  await sleep(200);

  // Feed synthetic IMU events before the 2.5 s watchdog falls back to demo motion.
  const feed = (alpha, beta, gamma) => gset(([a, b, c]) => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: a, beta: b, gamma: c, absolute: false }));
  }, [alpha, beta, gamma]);
  await feed(0, 90, 0); // upright, looking straight ahead -> becomes "forward"
  await sleep(100);
  await gshot('g2-sensor-forward');
  await feed(-20, 90, 0); // turn 20 deg right (alpha decreases when turning right)
  await sleep(400); // let the pose filter settle
  const sensorState = await gset(() => {
    const h = window.__glasses.head;
    return { motion: h.motion, has: h.sensor.has, events: h.sensor.events, offset: window.__glasses.display.contentOffset() };
  });
  console.log('glasses sensor', sensorState);
  if (sensorState.motion !== 'sensor' || !sensorState.has) errors.push(`glasses: sensor path not active: ${JSON.stringify(sensorState)}`);
  if (!(sensorState.offset > 15 && sensorState.offset < 25)) errors.push(`glasses: expected ~20 deg content offset after a 20 deg yaw, got ${sensorState.offset}`);
  await gshot('g3-sensor-yaw-right-20');

  // Menu: Enter on the focused "Mode" button cycles world -> locked
  await g.keyboard.press('Enter');
  await sleep(50);
  const mode1 = await gset(() => window.__glasses.params.mode);
  if (mode1 !== 'locked') errors.push(`glasses: Mode button should cycle to locked, got ${mode1}`);
  await gshot('g4-locked');

  // ArrowRight moves focus to "Content"; Enter cycles workspace -> hud
  await g.keyboard.press('ArrowRight');
  await g.keyboard.press('Enter');
  await sleep(50);
  const content1 = await gset(() => window.__glasses.params.content);
  if (content1 !== 'hud') errors.push(`glasses: Content button should cycle to hud, got ${content1}`);
  // ArrowUp hides the bar; the readout toggle is the last button
  await g.keyboard.press('ArrowUp');
  const hidden = await gset(() => document.getElementById('bar').classList.contains('hidden'));
  if (!hidden) errors.push('glasses: ArrowUp should hide the bar');
  await g.keyboard.press('ArrowLeft'); // reveals the bar again and moves focus to "Mode"
  await g.keyboard.press('ArrowLeft'); // wraps to "Readout"
  await g.keyboard.press('Enter');
  await sleep(200);
  const hudOn = await gset(() => !document.getElementById('hud').classList.contains('hidden'));
  if (!hudOn) errors.push('glasses: Readout button should show the HUD');
  await gshot('g5-hud-readout');

  // Every interactive element must be reachable: the focused element is always one of ours
  const focused = await gset(() => document.activeElement && document.activeElement.id);
  if (!/^b-/.test(focused || '')) errors.push(`glasses: focus left the menu (${focused})`);

  // The drawn frame must not be empty (black = transparent on the waveguide)
  const lit = await gset(() => {
    const d = window.__glasses;
    const w = 600, buf = new Uint8Array(w * w * 4);
    d.renderer.render(d.content.scene, d.display.camera);
    d.renderer.getContext().readPixels(0, 0, w, w, d.renderer.getContext().RGBA, d.renderer.getContext().UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] + buf[i + 1] + buf[i + 2] > 60) n++;
    return n / (w * w);
  });
  console.log('glasses lit fraction', lit.toFixed(3));
  if (!(lit > 0.01)) errors.push(`glasses: frame looks empty (lit fraction ${lit})`);
  await g.close();

  // Gyro fallback: only devicemotion (rotationRate + gravity) arrives, no orientation events.
  const g3 = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
  g3.on('pageerror', (e) => errors.push(`glasses3 pageerror: ${e.message}`));
  await g3.goto(`http://127.0.0.1:${PORT}/glasses.html`, { waitUntil: 'load' });
  await g3.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5, null, { timeout: 15000 });
  await g3.evaluate(() => {
    DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted');
    if (typeof DeviceMotionEvent !== 'undefined') DeviceMotionEvent.requestPermission = () => Promise.resolve('granted');
  });
  await g3.keyboard.press('Enter');
  await sleep(200);
  const feedMotion = (a) => g3.evaluate((alpha) => {
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      rotationRate: { alpha, beta: 0, gamma: 0 },
      accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 }, // upright: gravity along -Y of the device
      interval: 50,
    }));
  }, a);
  await feedMotion(0); // seeds the attitude from gravity
  for (let i = 0; i < 8; i++) { await sleep(50); await feedMotion(-120); } // ~ -120 deg/s about the device z axis
  await sleep(400);
  const gyro = await g3.evaluate(() => {
    const h = window.__glasses.head;
    return { motion: h.motion, source: h.sensor.source, has: h.sensor.has, motionEvents: h.sensor.motionEvents, offset: window.__glasses.display.contentOffset() };
  });
  console.log('glasses gyro', gyro);
  if (gyro.motion !== 'sensor' || gyro.source !== 'gyro') errors.push(`glasses: gyro fallback not active: ${JSON.stringify(gyro)}`);
  if (!(gyro.offset > 5)) errors.push(`glasses: gyro integration produced no rotation (offset ${gyro.offset})`);
  await g3.close();

  // Without sensor permission the app must still run, on demo motion.
  const g2 = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
  g2.on('pageerror', (e) => errors.push(`glasses2 pageerror: ${e.message}`));
  await g2.goto(`http://127.0.0.1:${PORT}/glasses.html`, { waitUntil: 'load' });
  await g2.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5, null, { timeout: 15000 });
  await g2.keyboard.press('Enter');
  await g2.waitForFunction(() => window.__glasses.head.motion !== 'sensor', null, { timeout: 5000 }).catch(() => {});
  const motion2 = await g2.evaluate(() => window.__glasses.head.motion);
  if (motion2 !== 'demo') errors.push(`glasses: expected demo motion after a refused permission, got ${motion2}`);
  await sleep(300);
  await g2.screenshot({ path: path.join(OUT, 'g6-demo-fallback.png') });
  await g2.close();
} catch (e) {
  errors.push(`test: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

if (errors.length) {
  console.error('FAILED');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log(`OK — screenshots in ${OUT}`);
