import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FinalShader } from '../shaders/FinalPass';
import { FxaaShader } from '../shaders/FxaaPass';
import { Quality } from './Quality';
import { SunShadow } from './SunShadow';
import { clamp } from './MathUtils';

export type Updatable = (dt: number, elapsed: number) => void;

/**
 * Renderer, camera, post stack and the frame loop.
 *
 * Deliberately knows nothing about tulips. Systems register an update function
 * and the engine guarantees they are called with a sane, clamped delta — a tab
 * left in the background for ten minutes must not resume with a 600-second step
 * that fires every random event at once.
 */
export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloomPass: UnrealBloomPass | null;
  readonly finalPass: ShaderPass;
  readonly fxaaPass: ShaderPass;
  readonly quality: Quality;
  readonly clock = new THREE.Clock();
  readonly shadow: SunShadow;

  /** Seconds of simulated time since the world woke up. */
  elapsed = 0;
  /** False on the performance tier, where the DOF taps are not affordable. */
  dofAvailable = true;

  /**
   * Dynamic resolution.
   *
   * The single most effective thing that can be done for a weak phone: when
   * frames start costing too much, render fewer pixels and let the FXAA pass
   * resolve the result back up. Nothing about the world changes — no flowers
   * disappear, no draw distance shortens — so the experience degrades in the
   * one dimension a viewer is least likely to notice while they are looking at
   * a field move in the wind.
   *
   * Quantised to discrete steps and rate-limited, because every change
   * reallocates the render targets, and a scale that chases the frame time
   * continuously costs more than it saves.
   */
  renderScale = 1;
  private scaleTarget = 1;
  private frameSamples: number[] = [];
  private scaleCooldown = 0;
  private targetFrameTime = 1 / 55;
  /** Set false to pin the resolution (the settings panel exposes this). */
  adaptiveResolution = true;
  private minScale = 0.55;
  /** Set false to freeze simulation while keeping the last frame on screen. */
  running = true;

  /**
   * One depth texture per ping-pong buffer.
   *
   * The grading pass samples scene depth for its depth of field. It also writes
   * into one of these buffers — and sampling a texture that is attached to the
   * currently bound framebuffer is a feedback loop, which drivers are entitled
   * to resolve as black, and do. Giving each buffer its own depth attachment
   * and always sampling the *read* buffer's means the pass never reads what it
   * is writing.
   */
  private depthTextureA: THREE.DepthTexture;
  private depthTextureB: THREE.DepthTexture;
  private updates: Updatable[] = [];
  private lateUpdates: Updatable[] = [];
  private rafId = 0;
  private disposed = false;
  private contextLost = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.canvas = canvas;
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.settings.tier === 'cinematic',
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      // The grading pass writes final sRGB itself, so nothing is lost by
      // skipping the default depth attachment on the *default* framebuffer.
      depth: true,
    });

    this.renderer.setPixelRatio(this.effectivePixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    // Tone mapping happens in the grading pass; doing it twice crushes the
    // highlights that make petals glow.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = true;

    if (quality.settings.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      quality.settings.viewDistance,
    );
    this.camera.position.set(0, 1.6, 8);

    // --- Post stack --------------------------------------------------------
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const makeDepth = (): THREE.DepthTexture => {
      const d = new THREE.DepthTexture(size.x, size.y);
      d.type = THREE.UnsignedIntType;
      d.format = THREE.DepthFormat;
      d.minFilter = THREE.NearestFilter;
      d.magFilter = THREE.NearestFilter;
      return d;
    };
    this.depthTextureA = makeDepth();
    this.depthTextureB = makeDepth();

    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      depthTexture: this.depthTextureA,
      samples: 0,
    });

    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(this.effectivePixelRatio());
    this.composer.renderTarget2.depthBuffer = true;
    this.composer.renderTarget2.depthTexture = this.depthTextureB;

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    if (quality.settings.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        quality.settings.bloomStrength,
        0.72,
        0.82,
      );
      this.composer.addPass(this.bloomPass);
    } else {
      this.bloomPass = null;
    }

    this.finalPass = new ShaderPass(FinalShader);
    // No longer the last pass: FXAA resolves to screen, and it has to run on
    // the graded sRGB image rather than on linear HDR.
    this.finalPass.renderToScreen = false;
    this.finalPass.material.depthTest = false;
    this.finalPass.material.depthWrite = false;
    this.finalPass.uniforms.tDepth.value = this.depthTextureA;
    this.finalPass.uniforms.uNear.value = this.camera.near;
    this.finalPass.uniforms.uFar.value = this.camera.far;
    this.finalPass.uniforms.uResolution.value.set(size.x, size.y);
    // Depth of field starts off. It is a shot decision the camera director
    // makes for close-ups, not a permanent property of the lens — leaving it on
    // blurs the whole field the moment the camera is anywhere but mid-distance.
    this.finalPass.uniforms.uDofStrength.value = 0;
    this.dofAvailable = quality.settings.tier !== 'performance';
    this.targetFrameTime = quality.settings.tier === 'performance' ? 1 / 40
      : quality.settings.tier === 'beautiful' ? 1 / 50 : 1 / 55;
    this.minScale = quality.settings.tier === 'performance' ? 0.45 : 0.6;
    this.composer.addPass(this.finalPass);

    this.fxaaPass = new ShaderPass(FxaaShader);
    this.fxaaPass.renderToScreen = true;
    this.fxaaPass.material.depthTest = false;
    this.fxaaPass.material.depthWrite = false;
    this.fxaaPass.uniforms.uEnabled.value = 1;
    this.composer.addPass(this.fxaaPass);

    this.shadow = new SunShadow(quality);

    this.bindEvents();
  }

  get post(): Record<string, THREE.IUniform> {
    return this.finalPass.uniforms as Record<string, THREE.IUniform>;
  }

  /**
   * Re-apply the current quality tier to the renderer and post stack. Called
   * after the settings panel changes the tier so the change is real rather than
   * cosmetic — pixel ratio, shadows, bloom strength and depth of field all move.
   */
  applyQuality(): void {
    const s = this.quality.settings;
    // A weaker tier is also a weaker device: aim for a lower framerate there
    // rather than shrinking the image to hit a number it was never going to.
    this.targetFrameTime = s.tier === 'performance' ? 1 / 40 : s.tier === 'beautiful' ? 1 / 50 : 1 / 55;
    this.minScale = s.tier === 'performance' ? 0.45 : 0.6;
    this.renderer.setPixelRatio(this.effectivePixelRatio());
    this.renderer.shadowMap.enabled = s.shadows;
    this.shadow.applyTier(this.quality);
    if (this.bloomPass) {
      this.bloomPass.enabled = s.bloom;
      this.bloomPass.strength = s.bloomStrength;
    }
    this.dofAvailable = s.tier !== 'performance';
    if (!this.dofAvailable) this.finalPass.uniforms.uDofStrength.value = 0;
    this.camera.far = s.viewDistance;
    this.camera.updateProjectionMatrix();
    this.lastW = 0;
    this.handleResize();
  }

  private effectivePixelRatio(): number {
    const base = Math.min(window.devicePixelRatio || 1, this.quality.settings.maxPixelRatio);
    return Math.max(0.4, base * this.renderScale);
  }

  /**
   * Watch the frame time and move the render scale to match.
   *
   * Uses a median rather than a mean: one stalled frame from a garbage
   * collection or a shader compile should not drop the resolution for everyone.
   */
  private updateRenderScale(dt: number, raw: number): void {
    if (!this.adaptiveResolution) return;

    this.frameSamples.push(raw);
    if (this.frameSamples.length > 40) this.frameSamples.shift();
    this.scaleCooldown -= dt;
    if (this.scaleCooldown > 0 || this.frameSamples.length < 20) return;

    const sorted = this.frameSamples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    const step = 0.1;
    let next = this.scaleTarget;
    if (median > this.targetFrameTime * 1.18) {
      next = Math.max(this.minScale, this.scaleTarget - step);
    } else if (median < this.targetFrameTime * 0.72) {
      // Climb back more slowly than we fall, so a scene that is only just
      // affordable does not oscillate.
      next = Math.min(1, this.scaleTarget + step * 0.5);
    }

    if (Math.abs(next - this.scaleTarget) > 0.001) {
      this.scaleTarget = next;
      this.renderScale = next;
      this.scaleCooldown = 1.1;
      this.frameSamples.length = 0;
      this.lastW = 0;      // force the resize path to re-apply
      this.handleResize();
    } else {
      this.scaleCooldown = 0.4;
    }
  }

  onUpdate(fn: Updatable): void {
    this.updates.push(fn);
  }

  /** Runs after all normal updates — for anything that must see final state. */
  onLateUpdate(fn: Updatable): void {
    this.lateUpdates.push(fn);
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize, { passive: true });
    window.addEventListener('orientationchange', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost as EventListener);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored as EventListener);

    // visualViewport catches mobile browser chrome sliding in and out, which
    // plain resize events miss on iOS.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.handleResize, { passive: true });
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(document.body);
    }
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
    this.handleResize();
  };

  private handleVisibility = (): void => {
    if (!document.hidden) {
      // Swallow the gap so the world resumes where it left off.
      this.clock.getDelta();
    }
  };

  private lastW = 0;
  private lastH = 0;

  handleResize = (): void => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;

    const pr = this.effectivePixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // On a tall phone a 52 degree horizontal-ish FOV crops the world badly.
    // Widening the vertical FOV in portrait keeps the composition intentional.
    const portrait = h > w;
    this.camera.fov = portrait ? clamp(52 * (h / w) * 0.62, 52, 76) : 52;
    this.camera.updateProjectionMatrix();

    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const d of [this.depthTextureA, this.depthTextureB]) {
      d.image.width = size.x;
      d.image.height = size.y;
      d.needsUpdate = true;
    }

    this.bloomPass?.setSize(w, h);
    this.finalPass.uniforms.uResolution.value.set(size.x, size.y);
    this.fxaaPass.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
  };

  start(): void {
    this.clock.start();
    this.lastW = 0;
    this.handleResize();
    const tick = (): void => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tick);
      this.frame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private frame(): void {
    // A lost context has no valid GL state; skip entirely until it comes back.
    if (this.contextLost) return;

    // Clamp to ~1/15s: long stalls advance the world slowly rather than
    // teleporting it, which keeps every integrator stable.
    const raw = this.clock.getDelta();
    const dt = clamp(raw, 0, 1 / 15);

    if (this.running) {
      this.elapsed += dt;
      for (let i = 0; i < this.updates.length; i++) this.updates[i](dt, this.elapsed);
      for (let i = 0; i < this.lateUpdates.length; i++) this.lateUpdates[i](dt, this.elapsed);
    }

    // The shadow map is filled before the world is drawn, so the same frame's
    // geometry and its shadow always agree.
    if (this.shadow.enabled) this.shadow.render(this.renderer, this.scene);

    this.finalPass.uniforms.uTime.value = this.elapsed;
    this.finalPass.uniforms.uNear.value = this.camera.near;
    this.finalPass.uniforms.uFar.value = this.camera.far;

    // The scene is about to be drawn into whichever buffer is currently the
    // read buffer, so that is the depth the grading pass must sample. The pair
    // alternates from frame to frame once a swapping pass is in the chain, so
    // this cannot be decided once at construction.
    const readTarget = this.composer.readBuffer as THREE.WebGLRenderTarget;
    if (readTarget?.depthTexture) {
      this.finalPass.uniforms.tDepth.value = readTarget.depthTexture;
    }

    this.composer.render(dt);
    this.quality.sampleFrame(raw);
    this.updateRenderScale(dt, raw);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.visualViewport?.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();
    this.shadow.dispose();
    this.depthTextureA.dispose();
    this.depthTextureB.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
