/** Bench for the hero tulip: a row of openness values, on black and in field. */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
const OUT = '/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 900, height: 900 } });
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
p.on('pageerror', e => errs.push(String(e)));
await p.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } });
await p.goto('http://127.0.0.1:4173', { waitUntil: 'load' });
await p.waitForTimeout(3000);
await p.mouse.click(450, 450);
await p.waitForFunction(() => getComputedStyle(document.querySelector('.loader')).display === 'none', null, { timeout: 60000 });
await p.waitForTimeout(1500);

const SHOTS = JSON.parse(process.env.HSHOTS ?? '[]');
for (const s of SHOTS) {
  await p.evaluate((sh) => {
    const g = window.__garden;
    g.hero(sh.open, sh.glow ?? 1, !!sh.fil);
    g.day.setHourImmediate(sh.hour ?? 22);
    g.camera.manual = true;
    g.engine.camera.position.set(sh.cam[0], sh.cam[1], sh.cam[2]);
    g.engine.camera.lookAt(sh.at[0], sh.at[1], sh.at[2]);
    const hide = !!sh.dark;
    g.world.sky.mesh.visible = !hide;
    g.world.ground.mesh.visible = !hide;
    g.world.tulips.group.visible = !hide;
    g.world.grass.mesh.visible = !hide;
    g.world.motes.points.visible = !hide;
    g.world.petals.mesh.visible = !hide;
  }, s);
  await p.waitForTimeout(Number(process.env.SETTLE ?? 3500));
  await p.screenshot({ path: `${OUT}/h-${s.name}.png` });
  console.log('shot', s.name);
}
console.log('console errors:', errs.length);
errs.slice(0,6).forEach(e=>console.log(' !', e.slice(0,400)));
await b.close();
