import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const OUT='/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots';
const b = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium')?'/opt/pw-browsers/chromium':undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:900,height:520}});
p.on('pageerror',e=>console.log('ERR',e));
await p.goto('http://127.0.0.1:4173',{waitUntil:'load'});
await p.waitForTimeout(5000);

const info = await p.evaluate(()=>{
  const g = window.__garden;
  g.day.manualHour = 12.5;
  g.engine.camera.position.set(0,1.2,12);
  g.engine.camera.lookAt(0,0.5,0);
  const r = g.engine.renderer.info.render;
  const scene = g.engine.scene;
  const names = [];
  scene.traverse(o=>{ if(o.isMesh) names.push({name:o.name||o.type, visible:o.visible, ro:o.renderOrder, frustumCulled:o.frustumCulled}); });
  return { calls:r.calls, tris:r.triangles, children:scene.children.length, meshes:names.slice(0,8),
           groundVisible: !!scene.getObjectByName('Ground')?.visible,
           fieldStats: g.stats() };
});
console.log(JSON.stringify(info,null,1));

// Hide the sky to see the ground unambiguously.
await p.evaluate(()=>{ window.__garden.engine.scene.getObjectByName('Sky').visible=false; });
await p.waitForTimeout(1200);
await p.screenshot({path:`${OUT}/diag-nosky.png`});

// Hide tulips too: pure ground.
await p.evaluate(()=>{ window.__garden.engine.scene.getObjectByName('TulipField').visible=false; });
await p.waitForTimeout(1200);
await p.screenshot({path:`${OUT}/diag-groundonly.png`});

const px = await p.evaluate(()=>{
  const c=document.getElementById('stage');
  const g=c.getContext('webgl2')||c.getContext('webgl');
  return g? 'ctx ok':'no ctx';
});
console.log(px);
await b.close();
