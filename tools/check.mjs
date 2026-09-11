/**
 * Production check harness.
 *
 * Boots the built site in headless Chromium, records every console message,
 * page error and failed request, waits for the world to settle, and writes
 * screenshots. Used to enforce the brief's "no console errors" requirement for
 * real rather than by inspection.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const OUT = process.env.OUT_DIR ?? '/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1600, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'tablet-landscape', width: 1180, height: 820, mobile: true },
];

const scenarios = (process.env.SCENARIOS ?? 'desktop,phone').split(',');
const WAIT = Number(process.env.WAIT_MS ?? 9000);
const EXTRA_SHOTS = Number(process.env.EXTRA_SHOTS ?? 0);

// The image ships a Chromium build that predates this Playwright release, so
// point at it explicitly rather than downloading a second one.
const EXECUTABLE = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';

const browser = await chromium.launch({
  executablePath: existsSync(EXECUTABLE) ? EXECUTABLE : undefined,
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

let failures = 0;
const report = [];

for (const vpName of scenarios) {
  const vp = VIEWPORTS.find((v) => v.name === vpName.trim());
  if (!vp) continue;

  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    hasTouch: vp.mobile,
    isMobile: vp.mobile,
    reducedMotion: process.env.REDUCED === '1' ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();

  const errors = [];
  const warnings = [];
  const logs = [];

  page.on('console', (msg) => {
    const text = `${msg.type()}: ${msg.text()}`;
    if (msg.type() === 'error') errors.push(text);
    else if (msg.type() === 'warning') warnings.push(text);
    else logs.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    // Google Fonts is a progressive enhancement; the page has real fallbacks.
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return;
    errors.push(`requestfailed: ${url} ${req.failure()?.errorText ?? ''}`);
  });

  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Get in, then force every material in the scene to compile. Materials are
  // compiled lazily on first draw, so a shader that only exists at the far side
  // of the world (the pond, the tree) would otherwise not be exercised at all
  // until someone flew out there.
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.loader')).display === 'none',
    null, { timeout: 60000 },
  ).catch(() => errors.push('loader never cleared'));
  await page.waitForTimeout(1200);

  await page.evaluate(async () => {
    const g = window.__garden;
    if (!g) return;
    g.bench();
    const { engine, world } = g;
    // Visit each landmark so every material is drawn at least once.
    const spots = [
      [0, 1.4, 8, 0, 0.6, 0],
      [-42, 3.2, 58, -58, 0, 44],       // the pond
      [70, 7, -48, 88, 5, -66],         // the tree
      [-90, 2.2, -74, -99, 0.6, -82],   // the white garden
      [66, 2.2, 88, 74, 0.6, 96],       // the moonlit garden
      [0, 280, 220, 0, 0, 0],           // the aerial reveal
    ];
    for (const [x, y, z, tx, ty, tz] of spots) {
      engine.camera.position.set(x, y, z);
      engine.camera.lookAt(tx, ty, tz);
      world.update(0.016, engine.camera, { night: 0.5, rain: 0.5, pixelRatio: 1 });
      engine.renderer.render(engine.scene, engine.camera);
      await new Promise((r) => setTimeout(r, 220));
    }
    // And exercise the states that swap materials on: rain, night, dream.
    world.uniforms.mood.uDream.value = 1;
    world.uniforms.mood.uWetness.value = 1;
    world.rain.update(engine.camera, 1);
    engine.renderer.render(engine.scene, engine.camera);
  });
  await page.waitForTimeout(1500);
  await page.waitForTimeout(WAIT);

  await page.screenshot({ path: `${OUT}/${vp.name}.png` });

  for (let i = 1; i <= EXTRA_SHOTS; i++) {
    await page.waitForTimeout(Number(process.env.SHOT_GAP ?? 6000));
    await page.screenshot({ path: `${OUT}/${vp.name}-t${i}.png` });
  }

  const diag = await page.evaluate(() => {
    const g = window.__garden;
    if (!g) return { ok: false, reason: 'no __garden handle' };
    try {
      return { ok: true, ...(g.report ? g.report() : {}) };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  });

  // Resize mid-flight: a classic source of WebGL crashes.
  await page.setViewportSize({ width: Math.round(vp.width * 0.62), height: Math.round(vp.height * 1.1) });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${vp.name}-resized.png` });

  const entry = { viewport: vp.name, errors, warningCount: warnings.length, warnings: warnings.slice(0, 12), diag };
  report.push(entry);
  if (errors.length) failures += errors.length;

  console.log(`\n=== ${vp.name} (${vp.width}x${vp.height}) ===`);
  console.log('errors:', errors.length);
  errors.slice(0, 12).forEach((e) => console.log('  !', e.slice(0, 400)));
  console.log('warnings:', warnings.length);
  warnings.slice(0, 6).forEach((w) => console.log('  ~', w.slice(0, 220)));
  console.log('diag:', JSON.stringify(diag).slice(0, 900));

  await context.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} console error(s). Shots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
