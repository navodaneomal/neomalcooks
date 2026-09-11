import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const OUT='/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots';
const b = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium')?'/opt/pw-browsers/chromium':undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:700,height:440}});
p.on('pageerror',e=>console.log('ERR',e.message));
p.on('console',m=>{if(m.type()==='error')console.log('CERR',m.text().slice(0,250));});
await p.addInitScript(()=>{try{localStorage.clear();}catch{}});
await p.goto('http://127.0.0.1:4173',{waitUntil:'load'});
await p.waitForTimeout(2500);
// Pin the resolution before anything can adapt.
await p.evaluate(()=>{ window.__garden.engine.adaptiveResolution=false; window.__garden.engine.renderScale=1; });
await p.mouse.click(350,220);
await p.waitForFunction(()=>getComputedStyle(document.querySelector('.loader')).display==='none',null,{timeout:60000});
await p.waitForTimeout(1200);
await p.evaluate(()=>{ const g=window.__garden; g.bench(); g.day.setHourImmediate(11);
  g.camera.manual=true; g.engine.camera.position.set(3,1.6,3.6); g.engine.camera.lookAt(0,0.85,0); });
await p.waitForTimeout(3500);
await p.screenshot({path:`${OUT}/iso-a.png`});
// Disable only the grading pass: FXAA then reads the raw scene buffer.
await p.evaluate(()=>{
  const e = window.__garden.engine;
  e.finalPass.enabled = false;
});
console.log('finalPass uniforms:', JSON.stringify(await p.evaluate(()=>{
  const u = window.__garden.engine.finalPass.uniforms;
  const f = window.__garden.engine.fxaaPass.uniforms;
  return { res: u.uResolution.value.toArray(), exposure:u.uExposure.value,
           fade:u.uFadeAmount.value, letterbox:u.uLetterbox.value,
           dof:u.uDofStrength.value, aber:u.uAberration.value,
           vignette:u.uVignette.value, grain:u.uGrain.value,
           contrast:u.uContrast.value, saturation:u.uSaturation.value,
           tint:u.uTint.value.toArray(), lift:u.uLift.value.toArray(),
           fxaaTexel: f.uTexel.value.toArray() };
})));
await p.waitForTimeout(600);
await p.screenshot({path:`${OUT}/iso-direct.png`});
console.log('lighting:', JSON.stringify(await p.evaluate(()=>{
  const u = window.__garden.world.uniforms;
  const g = window.__garden;
  return {
    hour: +(g.day.dayT*24).toFixed(2), night:+g.day.night.toFixed(3), exposure:+g.day.exposure.toFixed(3),
    sunDir: u.lighting.uSunDir.value.toArray().map(v=>+v.toFixed(3)),
    sunColor: u.lighting.uSunColor.value.toArray().map(v=>+v.toFixed(3)),
    sunIntensity: +u.lighting.uSunIntensity.value.toFixed(3),
    skyColor: u.lighting.uSkyColor.value.toArray().map(v=>+v.toFixed(3)),
    fogDensity: +u.atmosphere.uFogDensity.value.toFixed(5),
    fogColor: u.atmosphere.uFogColor.value.toArray().map(v=>+v.toFixed(3)),
    shadowEnabled: u.shadow.uShadowEnabled.value,
    skyZenith: g.world.sky.uniforms.uZenith.value.toArray().map(v=>+v.toFixed(3)),
    skySunI: +g.world.sky.uniforms.uSunIntensity.value.toFixed(3),
  };
})));
console.log('visibility:', JSON.stringify(await p.evaluate(()=>{
  const w = window.__garden.world;
  return { sky:w.sky.mesh.visible, ground:w.ground.mesh.visible,
           tulips:w.tulips.group.visible, grass:w.grass.mesh.visible,
           content: w.group.children.map(c=>({n:c.name,v:c.visible})) };
})));
console.log('pinned scale=1:', JSON.stringify(await p.evaluate(()=>{
  const g=window.__garden, e=g.engine;
  return { scale:e.renderScale, pr:e.renderer.getPixelRatio(),
    passes: e.composer.passes.map(x=>({n:x.constructor.name, screen:x.renderToScreen, en:x.enabled})),
    rt1:[e.composer.renderTarget1.width, e.composer.renderTarget1.height],
    exposure:+e.post.uExposure.value.toFixed(3), fade:+e.post.uFadeAmount.value.toFixed(3),
    letterbox:+e.post.uLetterbox.value.toFixed(2), dof:+e.post.uDofStrength.value.toFixed(2),
    canvas:[e.canvas.width, e.canvas.height] };
})));
await b.close();
