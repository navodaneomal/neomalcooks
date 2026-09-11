/**
 * Walks the experience: clicks through the loader, then samples the narrative
 * at intervals, capturing stills and the diagnostics report at each. Used to
 * verify that the acts actually advance and that nothing errors along the way.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const OUT = process.env.OUT_DIR ?? '/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });
const EXE = '/opt/pw-browsers/chromium';
const TIER = process.env.TIER ?? '';
const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const MOBILE = process.env.MOBILE === '1';
const PREFIX = process.env.PREFIX ?? 'j';

// seconds into the experience at which to capture
const MARKS = (process.env.MARKS ?? '2,6,12,20,32,48,70,100').split(',').map(Number);

const browser = await chromium.launch({
  executablePath: existsSync(EXE) ? EXE : undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
  hasTouch: MOBILE, isMobile: MOBILE,
});
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(5000);

if (TIER) {
  await page.evaluate((t) => window.__garden?.world.setTier(t), TIER);
  await page.waitForTimeout(3000);
}

// The entry gesture: this is what starts the film and unlocks audio.
await page.mouse.click(W / 2, H / 2);
// Wait for the loader to actually clear before the clock starts, so the marks
// below measure time inside the experience rather than time spent loading.
await page.waitForFunction(
  () => getComputedStyle(document.querySelector('.loader')).display === 'none',
  null, { timeout: 60000 },
).catch(() => console.log('WARNING: loader never cleared'));
await page.waitForTimeout(400);

const log = [];
let elapsed = 0;
for (const mark of MARKS) {
  const wait = Math.max(0, mark - elapsed) * 1000;
  if (wait > 0) await page.waitForTimeout(wait);
  elapsed = mark;
  await page.screenshot({ path: `${OUT}/${PREFIX}-${String(mark).padStart(3, '0')}s.png` });
  const r = await page.evaluate(() => window.__garden?.report?.() ?? {});
  log.push({ mark, ...r });
  console.log(`${String(mark).padStart(3)}s`, JSON.stringify(r));
}

writeFileSync(`${OUT}/${PREFIX}-journey.json`, JSON.stringify({ log, errors }, null, 2));
console.log('\nconsole errors:', errors.length);
errors.slice(0, 10).forEach((e) => console.log(' !', e.slice(0, 400)));
await browser.close();
process.exit(errors.length ? 1 : 0);
