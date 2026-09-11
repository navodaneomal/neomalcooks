/**
 * Art-direction preview: drives the live world to a given hour / camera and
 * writes a contact sheet of stills. Not shipped — a bench instrument.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const OUT = process.env.OUT_DIR ?? '/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });
const EXE = '/opt/pw-browsers/chromium';

// name, hour, camera position, look-at target
const SHOTS = JSON.parse(process.env.SHOTS ?? JSON.stringify([
  { name: 'noon',    hour: 12.5, cam: [0, 1.2, 12],  at: [0, 0.5, 0] },
  { name: 'golden',  hour: 18.2, cam: [0, 1.0, 10],  at: [0, 0.55, 0] },
  { name: 'night',   hour: 23.0, cam: [0, 1.2, 11],  at: [0, 0.6, 0] },
  { name: 'wide',    hour: 16.0, cam: [0, 26, 92],   at: [0, 2, 0] },
  { name: 'aerial',  hour: 15.0, cam: [0, 260, 210], at: [0, 0, 0] },
  { name: 'macro',   hour: 17.6, cam: [0.6, 0.42, 1.5], at: [0, 0.42, 0] },
]));

const browser = await chromium.launch({
  executablePath: existsSync(EXE) ? EXE : undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3000);
// Get past the loader; the bench needs the world, not the front door.
await page.mouse.click(640, 360);
await page.waitForFunction(
  () => getComputedStyle(document.querySelector('.loader')).display === 'none',
  null, { timeout: 60000 },
).catch(() => console.log('WARNING: loader never cleared'));
await page.waitForTimeout(1200);
// Skip the film: the bench looks at the garden, not at the sequence.
await page.evaluate(() => window.__garden?.bench?.());
await page.waitForTimeout(2500);

for (const s of SHOTS) {
  await page.evaluate((shot) => {
    const g = window.__garden;
    if (!g) return;
    if (g.preview) { g.preview(shot); return; }
    g.day.manualHour = shot.hour;
    g.engine.camera.position.set(...shot.cam);
    g.engine.camera.lookAt(...shot.at);
  }, s);
  // Let the hour ease in and the wind advance.
  await page.waitForTimeout(Number(process.env.SETTLE ?? 3000));
  await page.screenshot({ path: `${OUT}/p-${s.name}.png` });
  const r = await page.evaluate(() => window.__garden?.report?.() ?? {});
  console.log('shot', s.name, 'wanted hour', s.hour, '| got', r.hour, '| night', r.night, '| tier', r.tier);
}

console.log('console errors during preview:', errs.length);
errs.slice(0, 8).forEach((e) => console.log(' !', e.slice(0, 300)));
await browser.close();
