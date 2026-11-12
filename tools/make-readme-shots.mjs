// Renders docs/glasses.png: three 600x600 frames of glasses.html at different head yaws.
// Usage: python serve.py (port 8000) in another terminal, then node tools/make-readme-shots.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.DEMIDOF_URL || 'http://127.0.0.1:8000/glasses.html?log=0';
const shots = [
  { yaw: 0, label: 'Looking ahead: the card in front' },
  { yaw: -20, label: 'Head turned 20° right: the next card' },
  { yaw: -95, label: 'Past the last card: the arrow points back' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__glasses && window.__glasses.renderer.info.render.frame > 5);
await page.keyboard.press('Enter'); // Start (headless: no sensors -> drag fallback)
await page.waitForTimeout(4500);    // let the toasts fade
const images = [];
for (const s of shots) {
  await page.evaluate((yaw) => { const h = window.__glasses.head; h.yaw = yaw; h.pitch = 0; }, s.yaw);
  await page.waitForTimeout(400);
  images.push((await page.screenshot()).toString('base64'));
}

const sheet = await browser.newPage({ viewport: { width: 1920, height: 700 }, deviceScaleFactor: 1 });
await sheet.setContent(`<body style="margin:0;background:#0d1117;font:22px Segoe UI,system-ui,sans-serif;color:#c9d1d9">
  <div style="display:flex;gap:30px;padding:30px 30px 20px">${images.map((b, i) => `
    <figure style="margin:0"><img src="data:image/png;base64,${b}" width="600" height="600" style="display:block;border-radius:12px;border:1px solid #30363d">
    <figcaption style="margin-top:12px">${shots[i].label}</figcaption></figure>`).join('')}
  </div></body>`);
writeFileSync('docs/glasses.png', await sheet.screenshot({ fullPage: true }));
await browser.close();
console.log('wrote docs/glasses.png');
