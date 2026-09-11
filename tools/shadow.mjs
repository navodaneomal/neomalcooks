import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const b = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium')?'/opt/pw-browsers/chromium':undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:800,height:600}});
const errs=[];
p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
p.on('console',m=>{if(m.type()==='error')errs.push('CERR '+m.text().slice(0,300));});
await p.goto('http://127.0.0.1:4173',{waitUntil:'load'});
await p.waitForTimeout(2500);
await p.mouse.click(400,300);
await p.waitForFunction(()=>getComputedStyle(document.querySelector('.loader')).display==='none',null,{timeout:60000});
await p.waitForTimeout(1500);
// Force the cinematic tier so the shadow map switches on, and stop the
// adaptive systems from immediately pulling it back down.
await p.evaluate(()=>{
  const g=window.__garden;
  g.engine.adaptiveResolution=false;
  g.world.setTier('cinematic');
});
await p.waitForTimeout(6000);
const read = () => p.evaluate(()=>{
  const g=window.__garden, s=g.engine.shadow;
  const u=g.world.uniforms.shadow;
  return { tier:g.quality.tier, enabled:s.enabled, size:s.size,
           mapBound:!!u.uShadowMap.value, shadowEnabledUniform:u.uShadowEnabled.value,
           texel:u.uShadowTexel.value, strength:u.uShadowStrength.value,
           matrixSum:u.uShadowMatrix.value.elements.reduce((a,b)=>a+Math.abs(b),0),
           fps:g.report().fps };
});
console.log('cinematic:', JSON.stringify(await read()));
// She is what the map is for, so the flag only rises once she is actually there.
await p.evaluate(()=>{ const g=window.__garden; g.dancer.revealTarget=1; g.dancer.reveal=1; });
await p.waitForTimeout(4000);
console.log('she is here:', JSON.stringify(await read()));
// And back down: a device that steps down must shed the shadow pass, and the
// receivers must stop sampling a map that is no longer being redrawn.
await p.evaluate(()=>window.__garden.world.setTier('performance'));
await p.waitForTimeout(5000);
console.log('stepped down:', JSON.stringify(await read()));
console.log('console errors:', errs.length); errs.forEach(e=>console.log(' ',e));
await b.close();
