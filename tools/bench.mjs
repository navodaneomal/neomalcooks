/**
 * Frame-time benchmark.
 *
 * Runs in software rendering, so the absolute numbers mean nothing about real
 * hardware. The *ratios* do: fill-rate scales with pixel count on any renderer,
 * so what this measures honestly is how much each feature costs and how much
 * dynamic resolution actually recovers.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const b = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => { try { localStorage.clear(); } catch {} });
await p.goto('http://127.0.0.1:4173', { waitUntil: 'load' });
await p.waitForTimeout(2500);
await p.mouse.click(450, 280);
await p.waitForFunction(() => getComputedStyle(document.querySelector('.loader')).display === 'none', null, { timeout: 60000 });
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const g = window.__garden;
  g.bench();
  g.day.setHourImmediate(12);
  g.camera.manual = true;
  g.engine.camera.position.set(0, 1.4, 9);
  g.engine.camera.lookAt(0, 0.8, 0);
  g.engine.adaptiveResolution = false;
});

async function measure(label, setup, seconds = 6) {
  await p.evaluate(setup);
  await p.waitForTimeout(2000);                       // let it settle
  const ms = await p.evaluate(async (secs) => {
    const times = [];
    let last = performance.now();
    return await new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (times.length > 4 && (now - times.t0) > secs * 1000) { /* noop */ }
        if (times.length >= 120 || (performance.now() - start) > secs * 1000) {
          times.sort((a, b) => a - b);
          resolve(times[times.length >> 1]);
          return;
        }
        requestAnimationFrame(tick);
      };
      const start = performance.now();
      requestAnimationFrame(tick);
    });
  }, seconds);
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(7)} ms/frame   ${(1000/ms).toFixed(1).padStart(5)} fps`);
  return ms;
}

console.log('\n--- performance tier, 900x560, software renderer ---');
const full = await measure('scale 1.00, FXAA on', () => {
  const e = window.__garden.engine;
  e.renderScale = 1; e.applyQuality();
  e.fxaaPass.uniforms.uEnabled.value = 1;
});
await measure('scale 1.00, FXAA off', () => {
  window.__garden.engine.fxaaPass.uniforms.uEnabled.value = 0;
});
const s75 = await measure('scale 0.75, FXAA on', () => {
  const e = window.__garden.engine;
  e.fxaaPass.uniforms.uEnabled.value = 1;
  e.renderScale = 0.75; e.applyQuality();
});
const s50 = await measure('scale 0.50, FXAA on', () => {
  const e = window.__garden.engine;
  e.renderScale = 0.5; e.applyQuality();
});

console.log(`\ndynamic resolution recovers: ${((full/s75 - 1) * 100).toFixed(0)}% at 0.75, ${((full/s50 - 1) * 100).toFixed(0)}% at 0.50`);
await b.close();
