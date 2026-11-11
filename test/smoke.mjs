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
  // Glasses build: the page is the 600 x 600 display, world-locked content only.
  const g = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
  g.on('pageerror', (e) => errors.push(`glasses pageerror: ${e.message}`));
  g.on('console', (m) => { if (m.type() === 'error') errors.push(`glasses console: ${m.text()}`); });
  await g.goto(`http://127.0.0.1:${PORT}/glasses.html`, { waitUntil: 'load' });
  await g.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5, null, { timeout: 15000 });
  const gshot = async (name) => { await sleep(250); await g.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const gset = (fn, arg) => g.evaluate(fn, arg);
  const offset = () => gset(() => window.__glasses.display.contentOffset());

  await gshot('g1-start');
  // Headless Chromium answers the sensor permission with "denied"; pretend the wearer granted it.
  await gset(() => { DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted'); });
  await g.keyboard.press('Enter'); // Start
  await sleep(200);

  // Orientation events only (no gyroscope): forward-vector path.
  const feed = (alpha, beta, gamma) => gset(([a, b, c]) => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: a, beta: b, gamma: c, absolute: false }));
  }, [alpha, beta, gamma]);
  await feed(0, 90, 0); // upright, looking straight ahead -> becomes "forward"
  await sleep(100);
  await gshot('g2-forward');
  await feed(-20, 90, 0); // turn 20 deg right (alpha decreases when turning right)
  await sleep(600); // let the output filter settle
  const orient = await gset(() => ({ source: window.__glasses.head.sensor.source, has: window.__glasses.head.sensor.has, events: window.__glasses.head.sensor.events, offset: window.__glasses.display.contentOffset() }));
  console.log('glasses orientation', orient);
  if (orient.source !== 'orientation' || !orient.has) errors.push(`glasses: orientation path not active: ${JSON.stringify(orient)}`);
  if (!(orient.offset > 17 && orient.offset < 23)) errors.push(`glasses: expected ~20 deg content offset after a 20 deg yaw, got ${orient.offset}`);
  await gshot('g3-yaw-right-20');

  // Select = recenter: the content comes back to the window.
  await g.keyboard.press('Enter');
  await sleep(300);
  const afterRecenter = await offset();
  if (!(afterRecenter < 0.5)) errors.push(`glasses: Select should recenter, offset ${afterRecenter}`);

  // Arrows: content preset and readout.
  await g.keyboard.press('ArrowRight'); await sleep(50);
  const content1 = await gset(() => window.__glasses.params.content);
  if (content1 !== 'hud') errors.push(`glasses: ArrowRight should switch to hud, got ${content1}`);
  await g.keyboard.press('ArrowUp'); await sleep(250);
  const hudOn = await gset(() => !document.getElementById('hud').classList.contains('hidden'));
  if (!hudOn) errors.push('glasses: ArrowUp should show the readout');
  await gshot('g4-hud-readout');
  await g.keyboard.press('ArrowDown');

  // Edge indicator appears when the content is outside the window.
  await feed(-40, 90, 0); await sleep(600);
  const edgeShown = await gset(() => document.getElementById('edge').classList.contains('show') ? document.getElementById('edge').textContent : '');
  if (!/\u2190/.test(edgeShown)) errors.push(`glasses: edge indicator should point left (content is to the left), got "${edgeShown}"`);
  await gshot('g5-edge');
  await g.keyboard.press('Enter'); await sleep(300); // recenter: content back in the window

  // The drawn frame must not be empty (black = transparent on the waveguide)
  const lit = await gset(() => {
    const d = window.__glasses;
    const w = 600, buf = new Uint8Array(w * w * 4);
    d.renderer.render(d.content.scene, d.display.camera);
    const gl = d.renderer.getContext();
    gl.readPixels(0, 0, w, w, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] + buf[i + 1] + buf[i + 2] > 60) n++;
    return n / (w * w);
  });
  console.log('glasses lit fraction', lit.toFixed(3));
  if (!(lit > 0.005)) errors.push(`glasses: frame looks empty (lit fraction ${lit})`);
  await g.close();

  // Gyroscope + orientation (fused), and gyroscope only. Device upright: gravity +9.81 along +Y.
  const g3 = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
  g3.on('pageerror', (e) => errors.push(`glasses3 pageerror: ${e.message}`));
  await g3.goto(`http://127.0.0.1:${PORT}/glasses.html`, { waitUntil: 'load' });
  await g3.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5, null, { timeout: 15000 });
  await g3.evaluate(() => { DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted'); });
  await g3.keyboard.press('Enter');
  await sleep(200);
  const feedMotion = ([a, b, c]) => g3.evaluate(([alpha, beta, gamma]) => {
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      rotationRate: { alpha, beta, gamma }, accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 }, interval: 16,
    }));
  }, [a, b, c]);
  const feedOrient = (a) => g3.evaluate((alpha) => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta: 90, gamma: 0, absolute: false }));
  }, a);
  const burst = async (rate, n = 8, withOrient = null) => {
    for (let i = 0; i < n; i++) { await sleep(16); if (withOrient !== null) await feedOrient(withOrient); await feedMotion(rate); }
  };
  // Gyro only: a constant bias of 1.5 deg/s about Z while "still" is learned and removed.
  await feedMotion([1.5, 0, 0]);
  await burst([1.5, 0, 0], 90); // ~1.5 s still
  const biasState = await g3.evaluate(() => ({ source: window.__glasses.head.sensor.source, bias: window.__glasses.head.bias.z }));
  console.log('glasses gyro bias', biasState);
  if (biasState.source !== 'gyro') errors.push(`glasses: expected gyro source, got ${JSON.stringify(biasState)}`);
  if (!(biasState.bias > 0.3)) errors.push(`glasses: gyro bias should be learned while still, got ${biasState.bias}`);
  await g3.keyboard.press('Enter'); await sleep(100); // recenter
  // Turn right: ~ -120 deg/s about the device Y axis for 8 samples (~16 ms each) = about 15 deg.
  await burst([1.5, 0, -120], 8);
  await sleep(300);
  const gyroTurn = await g3.evaluate(() => {
    const e = window.__glasses.head.quaternion;
    return { offset: window.__glasses.display.contentOffset(), qy: e.y };
  });
  console.log('glasses gyro turn', gyroTurn);
  if (!(gyroTurn.offset > 5)) errors.push(`glasses: gyro turn produced no rotation (offset ${gyroTurn.offset})`);
  if (!(gyroTurn.qy < 0)) errors.push(`glasses: turning right should give a negative yaw quaternion y, got ${gyroTurn.qy}`);

  // Fused: both streams; the gyro drives, the heading is pulled towards the orientation events.
  await burst([1.5, 0, 0], 10, 0);
  await sleep(200);
  const fused = await g3.evaluate(() => window.__glasses.head.sensor.source);
  if (fused !== 'fused') errors.push(`glasses: expected fused source with both event kinds, got ${fused}`);
  await g3.keyboard.press('Enter'); await sleep(100);
  await burst([1.5, 0, -120], 8, 0);
  await sleep(300);
  const fusedTurn = await g3.evaluate(() => window.__glasses.display.contentOffset());
  console.log('glasses fused turn', fusedTurn);
  if (!(fusedTurn > 5)) errors.push(`glasses: fused pose did not follow the gyro (offset ${fusedTurn})`);
  await g3.close();

  // Without sensor permission the app must still run (drag fallback), without errors.
  const g2 = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
  g2.on('pageerror', (e) => errors.push(`glasses2 pageerror: ${e.message}`));
  await g2.goto(`http://127.0.0.1:${PORT}/glasses.html`, { waitUntil: 'load' });
  await g2.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5, null, { timeout: 15000 });
  await g2.keyboard.press('Enter');
  await sleep(500);
  const denied = await g2.evaluate(() => ({ perm: window.__glasses.head.sensor.permission, source: window.__glasses.head.sensor.source, started: document.getElementById('start').classList.contains('hidden') }));
  console.log('glasses denied', denied);
  if (!denied.started || denied.source !== 'none') errors.push(`glasses: denied permission should leave the app running on drag, got ${JSON.stringify(denied)}`);
  await g2.mouse.move(300, 300); await g2.mouse.down(); await g2.mouse.move(100, 300, { steps: 5 }); await g2.mouse.up();
  await sleep(200);
  const dragged = await g2.evaluate(() => window.__glasses.display.contentOffset());
  if (!(dragged > 5)) errors.push(`glasses: drag fallback should move the view, offset ${dragged}`);
  await g2.screenshot({ path: path.join(OUT, 'g6-drag-fallback.png') });
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
