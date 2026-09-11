import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const b = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium')?'/opt/pw-browsers/chromium':undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('ERR',e.message));
p.on('console',m=>{if(m.type()==='error')console.log('CERR',m.text().slice(0,300));});
await p.goto('http://127.0.0.1:4173',{waitUntil:'load'});
await p.waitForTimeout(3000);
await p.mouse.click(400,300);
await p.waitForFunction(()=>getComputedStyle(document.querySelector('.loader')).display==='none',null,{timeout:60000});
await p.waitForTimeout(1500);
await p.evaluate(()=>{
  const g=window.__garden;
  g.hero(0, 0.5, true);
  // Hide everything except the filaments so nothing can mask them.
  g.world.sky.mesh.visible=false; g.world.ground.mesh.visible=false;
  g.world.tulips.group.visible=false; g.world.grass.mesh.visible=false;
  g.world.hero.group.visible=false; g.world.motes.points.visible=false;
  g.world.petals.mesh.visible=false; g.world.fireflies.points.visible=false;
  g.camera.manual=true;
  g.engine.camera.position.set(0,2.2,4.0); g.engine.camera.lookAt(0,1.0,0);
});
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const f=window.__garden.world.filaments;
  const u=f.material.uniforms;
  return { visible:f.mesh.visible, parentVisible: f.mesh.parent?.visible,
           head:u.uHead.value, amount:u.uAmount.value, settle:u.uSettle.value,
           width:u.uWidth.value, centre:u.uCentre.value.toArray(),
           matNeedsUpdate: f.material.version,
           renderOrder: f.mesh.renderOrder, blending: f.material.blending };
}),null,1));
await p.screenshot({path:'/tmp/claude-0/-home-user-neomalcooks/787619a6-003d-5fab-8626-e5bd3cf8740c/scratchpad/shots/probe-fil.png'});
await b.close();
