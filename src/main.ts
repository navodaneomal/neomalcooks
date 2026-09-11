import './style.css';
import * as THREE from 'three';

import { Engine } from './core/Engine';
import { Quality, type TierName } from './core/Quality';
import { bus } from './core/Bus';
import { clamp01, damp } from './core/MathUtils';

import { World } from './world/World';
import { POND_WATER_Y } from './world/Terrain';
import { POND } from './world/Landmarks';

import { DayCycle } from './systems/DayCycle';
import { Heart } from './systems/Heart';
import { Weather } from './systems/Weather';
import { AudioEngine } from './systems/Audio';
import { Memory } from './systems/Memory';
import { Dancer } from './systems/Dancer';
import { CameraDirector } from './systems/CameraDirector';
import { Interaction } from './systems/Interaction';
import { Events } from './systems/Events';

import { Director } from './narrative/Director';
import { PETAL_MESSAGES, LOADING_STAGES } from './narrative/CodePoem';
import { Overlay, wait } from './ui/Overlay';
import { Settings } from './ui/Settings';

/**
 * Assembly.
 *
 * Every engine is independent and talks through the shared uniform graph or the
 * event bus; this file is the only place that knows they all exist, and its job
 * is to update them in a defensible order and hand each one the few facts it
 * cannot work out for itself.
 */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const memory = new Memory();
const quality = new Quality();

// Honour whatever they chose last time, before anything is built.
if (memory.data.prefs.tier) quality.setTier(memory.data.prefs.tier as TierName, true);
if (memory.data.prefs.reducedMotion !== null) quality.reducedMotion = memory.data.prefs.reducedMotion;

const engine = new Engine(canvas, quality);
const world = new World(engine, quality);
const overlay = new Overlay(uiRoot);

const heart = new Heart(world.uniforms);
const day = new DayCycle(world.uniforms, world.sky);
const weather = new Weather(world.uniforms, world.sky, heart);
const audio = new AudioEngine(world.uniforms, heart);
const dancer = new Dancer(world.uniforms, quality.settings, world.tulips);
world.group.add(dancer.group, dancer.reflection);

// After a quality rebuild the old tulip field is disposed, so anything holding
// a reference to it has to be re-pointed at the new one.
world.onRebuild(() => dancer.setField(world.tulips));

const camera = new CameraDirector(engine, dancer, heart, quality.reducedMotion);
// The close-up shot is about a tulip; give the director a way to find one.
const flowerPos = new THREE.Vector3();
camera.findFlower = (x, z) => {
  const rec = world.tulips.nearest(x, z, 9);
  if (!rec) return null;
  return flowerPos.set(rec.x, rec.y + rec.scale * 0.72, rec.z);
};

const interaction = new Interaction(engine, camera, world.tulips, world.pond, audio, memory);
const events = new Events(weather, world.meteors, heart, day, memory);
const director = new Director(
  engine, world, dancer, camera, heart, memory, audio, interaction, world.tree, overlay,
);

audio.setVolume(memory.data.prefs.volume);
audio.setMuted(memory.data.prefs.muted);

// ---------------------------------------------------------------------------
// Bloom waves
// ---------------------------------------------------------------------------

/**
 * Expanding rings of blooming, driven entirely from four uniforms. Because the
 * shader evaluates the ring per-vertex, a wave crossing a hundred thousand
 * flowers costs exactly this much CPU: one object.
 */
interface Wave { x: number; z: number; radius: number; max: number; power: number; speed: number }
const waves: Wave[] = [];

bus.on('garden:bloom', ({ x, z, radius, power }) => {
  // Keep only the most recent few; the shader can express two at a time.
  if (waves.length > 5) waves.shift();
  waves.push({ x, z, radius: 0, max: radius, power, speed: Math.max(6, radius * 0.9) });
  heart.interaction = Math.max(heart.interaction, power * 0.6);
});

function updateWaves(dt: number): void {
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.radius += w.speed * dt;
    if (w.radius > w.max) waves.splice(i, 1);
  }
  // The director owns uWave during the mass bloom; everything else shares uWave2.
  const u = world.uniforms.wave;
  if (director.massBloom < 0) {
    const a = waves[waves.length - 1];
    if (a) {
      (u.uWave.value as THREE.Vector4).set(a.x, a.z, a.radius, Math.max(2, a.max * 0.35));
      u.uWaveStrength.value = a.power * (1 - clamp01(a.radius / a.max));
    } else {
      u.uWaveStrength.value = 0;
    }
  }
  const b = waves[waves.length - 2];
  if (b) {
    (u.uWave2.value as THREE.Vector4).set(b.x, b.z, b.radius, Math.max(2, b.max * 0.35));
    u.uWave2Strength.value = b.power * (1 - clamp01(b.radius / b.max)) * 0.8;
  } else {
    u.uWave2Strength.value = 0;
  }
}

// ---------------------------------------------------------------------------
// Discoveries and messages
// ---------------------------------------------------------------------------

bus.on('garden:discovery', ({ label }) => overlay.whisper(label));

const projected = new THREE.Vector3();
let messageCooldown = 0;

bus.on('garden:message', ({ x, y, z }) => {
  // Not every flower says something, and none of them repeat themselves.
  if (messageCooldown > 0) return;
  const unseen = PETAL_MESSAGES
    .map((_, i) => i)
    .filter((i) => !memory.data.messagesSeen.includes(i));
  if (unseen.length === 0 || Math.random() > 0.42) return;

  const idx = unseen[Math.floor(Math.random() * unseen.length)];
  memory.markMessage(idx);
  messageCooldown = 22;

  projected.set(x, y, z).project(engine.camera);
  if (projected.z > 1) return;   // behind the camera
  const sx = (projected.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-projected.y * 0.5 + 0.5) * window.innerHeight;
  overlay.petalMessage(PETAL_MESSAGES[idx], sx, sy);
});

// Rare events that need something visible to happen.
bus.on('event:rare', ({ id }) => {
  if (id === 'butterfly-swarm') heart.spark(0.7);
  if (id === 'golden-sunrise') day.forceTime(6.1 / 24);
  if (id === 'petal-spiral') world.setAirAmount(1.6, 2.2);
  if (id === 'caught-star') camera.impulse(0.6);
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

let zeroUi = false;
const settings = new Settings(uiRoot, quality, engine, audio, memory, day, world, heart, weather, {
  onReducedMotion: (v) => camera.setReducedMotion(v),
  onZeroUi: (v) => {
    zeroUi = v;
    overlay.setChromeVisible(!v);
    camera.letterboxOverride = v ? 0 : null;
  },
  onReplay: () => director.replay(),
});

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

const herPos = new THREE.Vector3();
let fps = 60;
let uiTick = 0;

engine.onUpdate((dt, t) => {
  world.uniforms.wind.uTime.value = t;
  fps = damp(fps, 1 / Math.max(dt, 1e-4), 1.2, dt);
  messageCooldown = Math.max(0, messageCooldown - dt);

  // --- Input and mood ------------------------------------------------------
  interaction.update(dt);
  heart.interaction = Math.max(heart.interaction, interaction.activity);

  // --- Time, weather, sound ------------------------------------------------
  day.update(dt);
  weather.update(dt, day.baseFogDensity);
  audio.windStrength = weather.wind;
  audio.rain = weather.rain;
  audio.night = day.night;
  audio.update(dt);

  // --- Her -----------------------------------------------------------------
  dancer.update(dt, world.uniforms.wind.uWindDir.value as THREE.Vector2, weather.wind);
  heart.herMotion = dancer.motion;
  // Her singing reads as a voice the field can answer, even with no track.
  world.uniforms.mood.uAudioVoice.value = Math.max(
    world.uniforms.mood.uAudioVoice.value as number, dancer.singing * 0.5);

  heart.update(dt);

  // --- Narrative -----------------------------------------------------------
  events.update(dt);
  director.update(dt, interaction.activity + heart.interaction);

  // During the held silence before the bloom, the world genuinely stops.
  if (director.stillness > 0) {
    world.uniforms.wind.uWindStrength.value *= 1 - director.stillness * 0.97;
  }

  // --- Influence: what the field is currently reacting to -------------------
  const u = world.uniforms;
  u.beginInfluences();
  if (dancer.reveal > 0.05) {
    u.addInfluence(dancer.position.x, dancer.position.z, 2.2, 0.5 + dancer.motion * 0.5);
    u.addInfluence(dancer.position.x, dancer.position.z, 7 + dancer.herWind * 7, dancer.herWind * 0.4);
  }
  if (interaction.hasHover) {
    // A tulip leans toward the cursor (brief §48, egg 1).
    u.addInfluence(interaction.hover.x, interaction.hover.z, 1.1, 0.30);
  }
  interaction.forEachSeed((x, z, growth) => {
    // Her own planted tulips are permanently a little more awake.
    u.addInfluence(x, z, 0.9 + growth * 0.8, 0.35 + growth * 0.55);
  });
  u.endInfluences();

  updateWaves(dt);

  // --- The tree, the pond, discoveries --------------------------------------
  const focusX = dancer.reveal > 0.4 ? dancer.position.x : engine.camera.position.x;
  const focusZ = dancer.reveal > 0.4 ? dancer.position.z : engine.camera.position.z;
  world.tree.setProximity(director.treeDistance(focusX, focusZ));
  director.checkDiscoveries(engine.camera.position.x, engine.camera.position.z, day.night);
  if (dancer.reveal > 0.4) director.checkDiscoveries(focusX, focusZ, day.night);

  const pondDist = Math.hypot(dancer.position.x - POND.x, dancer.position.z - POND.z);
  dancer.updateReflection(dt, POND_WATER_Y, clamp01(1 - (pondDist - POND.radius * 0.4) / 14));

  // --- Shadow ----------------------------------------------------------------
  // Fitted to her, because she is what it is for. The map only covers a box a
  // few metres across, which is why it can afford to be sharp.
  if (engine.shadow.enabled) {
    dancer.centre(herPos);
    engine.shadow.fit(herPos, world.uniforms.lighting.uSunDir.value as THREE.Vector3);
    const su = world.uniforms.shadow;
    su.uShadowMap.value = engine.shadow.target.texture;
    (su.uShadowMatrix.value as THREE.Matrix4).copy(engine.shadow.matrix);
    su.uShadowTexel.value = 1 / engine.shadow.target.width;
    // Moonlight casts a far softer shadow than the sun does.
    su.uShadowEnabled.value = dancer.reveal > 0.15 ? 1 : 0;
    su.uShadowStrength.value = 0.85 * (1 - day.night * 0.55) * clamp01(dancer.reveal);
  } else if (world.uniforms.shadow.uShadowEnabled.value !== 0) {
    // Shadows just went off — a step down in tier, or the settings toggle. The
    // map stops being redrawn, so leaving the flag up would paint a frozen
    // shadow on the ground wherever she happened to be standing.
    world.uniforms.shadow.uShadowEnabled.value = 0;
  }

  // --- Camera and world -----------------------------------------------------
  camera.update(dt, t);
  dancer.headPosition(herPos);
  world.setHer(dancer.position, dancer.herWind + dancer.handsRaised * 0.6);
  world.setAirAmount(
    1 + heart.wonder * 0.8 + director.dream * 0.8,
    1 + dancer.herWind * 0.9 + heart.energy * 0.5,
  );

  interaction.shootingStarWindow = world.meteors.active ? 0.9 : interaction.shootingStarWindow;

  world.update(dt, engine.camera, {
    night: day.night,
    rain: weather.rain,
    pixelRatio: engine.renderer.getPixelRatio(),
  });

  // --- Lens -----------------------------------------------------------------
  engine.post.uExposure.value = damp(
    engine.post.uExposure.value as number,
    day.exposure * (1 + heart.wonder * 0.12),
    1.5, dt,
  );

  // --- Memory ---------------------------------------------------------------
  memory.update(dt);

  uiTick += dt;
  if (uiTick > 0.35) {
    uiTick = 0;
    settings.update(fps);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  engine.start();

  // Audio needs a user gesture. Take the first one that arrives, even if it
  // lands while the world is still being built.
  overlay.onFirstGesture = () => void audio.unlock();

  // The loader is a real loader: each stage waits for actual work. The world is
  // built by now, so what remains is shader compilation, which is the part that
  // genuinely takes time on a cold GPU.
  for (let i = 0; i < LOADING_STAGES.length; i++) {
    overlay.setLoaderStage(i);
    // Give the browser room to compile and upload between stages.
    await wait(420);
    if (i === 2) {
      // Force the heavy programs to compile now rather than on the first frame.
      engine.renderer.compile(engine.scene, engine.camera);
    }
  }

  await overlay.awaitEntry();
  void audio.unlock();
  void director.run();
}

void boot();

// Save on the way out; a visit that is closed still counts.
window.addEventListener('pagehide', () => memory.save());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) memory.save();
});

// Exposed for the automated production checks and the art-direction bench.
(window as unknown as Record<string, unknown>).__garden = {
  engine, world, quality, day, weather, heart, dancer, camera, director, audio, memory,
  interaction, events,
  stats: () => world.tulips.stats(),
  bench: () => director.bench(),
  // Art-direction bench: place a hero tulip at a chosen openness.
  hero: (open: number, glow = 1, filaments = false, scale = 1.6) => {
    director.bench();
    dancer.revealTarget = 0;
    dancer.reveal = 0;
    for (const slot of world.hero.slots) slot.active = false;
    const i = world.hero.spawn({ x: 0, z: 0, scale, open, glow, core: 0.9, instant: true });
    if (filaments) { world.filaments.begin(0, 0, 0, scale); world.filaments.complete(); }
    else world.filaments.dismiss();
    return i;
  },
  preview: (shot: { hour: number; cam: number[]; at: number[]; tier?: string }) => {
    if (shot.tier && shot.tier !== quality.tier) world.setTier(shot.tier as TierName);
    director.bench();
    day.setHourImmediate(shot.hour);
    camera.manual = true;
    engine.camera.position.set(shot.cam[0], shot.cam[1], shot.cam[2]);
    engine.camera.lookAt(shot.at[0], shot.at[1], shot.at[2]);
  },
  report: () => ({
    tier: quality.tier,
    tulips: world.tulips.count,
    chunks: world.tulips.stats().chunks,
    lod: world.tulips.lodCounts(),
    hour: +(day.dayT * 24).toFixed(2),
    renderScale: +engine.renderScale.toFixed(2),
    shadows: engine.shadow.enabled,
    night: +day.night.toFixed(3),
    act: director.act,
    weather: weather.label(),
    heart: heart.label(),
    fps: Math.round(fps),
    audio: audio.ready ? 'on' : audio.blocked ? 'blocked' : 'idle',
    zeroUi,
  }),
};
