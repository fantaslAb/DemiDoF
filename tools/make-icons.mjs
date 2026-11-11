// Renders assets/favicon.svg to the PNG icons the glasses require (SVG icons are not supported).
//   node tools/make-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(ROOT, 'assets', 'favicon.svg'), 'utf8');
const browser = await chromium.launch();
for (const size of [96, 180]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(`<body style="margin:0;background:#000">${sized}</body>`);
  await page.screenshot({ path: path.join(ROOT, 'assets', `icon-${size}.png`), clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
}
await browser.close();
console.log('wrote assets/icon-96.png and assets/icon-180.png');
