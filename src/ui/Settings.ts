import type { Quality, TierName } from '../core/Quality';
import type { AudioEngine } from '../systems/Audio';
import type { Memory } from '../systems/Memory';
import type { DayCycle } from '../systems/DayCycle';
import type { World } from '../world/World';
import type { Engine } from '../core/Engine';
import type { Heart } from '../systems/Heart';
import type { Weather } from '../systems/Weather';
import { bus } from '../core/Bus';

/**
 * The settings panel (brief §49, §50, §53).
 *
 * Hidden behind one small mark in the corner, and every control here changes
 * something real — quality genuinely rebuilds the field, reduced motion
 * genuinely stops the camera moving, the hour genuinely moves the sun. The
 * brief forbids dead buttons, so there are none: if a capability is not
 * available on this device the control is not rendered at all.
 */

export interface SettingsHooks {
  onReducedMotion: (v: boolean) => void;
  onZeroUi: (v: boolean) => void;
  onReplay: () => void;
}

export class Settings {
  readonly root: HTMLElement;
  private panel: HTMLElement;
  private open = false;
  private diagnostics: HTMLElement;

  constructor(
    parent: HTMLElement,
    private quality: Quality,
    private engine: Engine,
    private audio: AudioEngine,
    private memory: Memory,
    private day: DayCycle,
    private world: World,
    private heart: Heart,
    private weather: Weather,
    private hooks: SettingsHooks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'settings';
    parent.appendChild(this.root);

    const toggle = document.createElement('button');
    toggle.className = 'settings-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Settings');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = TULIP_MARK;
    toggle.addEventListener('click', () => this.setOpen(!this.open));
    this.root.appendChild(toggle);

    this.panel = document.createElement('div');
    this.panel.className = 'settings-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Settings');
    this.root.appendChild(this.panel);

    this.build();

    this.diagnostics = document.createElement('div');
    this.diagnostics.className = 'diagnostics';
    this.panel.appendChild(this.diagnostics);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Escape is the brief's way back from cinematic mode, and out of here.
        if (this.open) this.setOpen(false);
        else this.hooks.onZeroUi(false);
      }
    });
  }

  private setOpen(v: boolean): void {
    this.open = v;
    this.root.classList.toggle('open', v);
    this.root.querySelector('.settings-toggle')?.setAttribute('aria-expanded', String(v));
  }

  private section(title: string): HTMLElement {
    const s = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = title;
    s.appendChild(h);
    this.panel.appendChild(s);
    return s;
  }

  private row(parent: HTMLElement, label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);
    parent.appendChild(row);
    return row;
  }

  private toggleRow(
    parent: HTMLElement, label: string, initial: boolean, onChange: (v: boolean) => void,
  ): HTMLInputElement {
    const row = this.row(parent, label);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.className = 'switch';
    const id = `s-${label.replace(/\W+/g, '-').toLowerCase()}`;
    input.id = id;
    row.querySelector('label')?.setAttribute('for', id);
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(input);
    return input;
  }

  private sliderRow(
    parent: HTMLElement, label: string, min: number, max: number, step: number,
    initial: number, onInput: (v: number) => void, format?: (v: number) => string,
  ): HTMLInputElement {
    const row = this.row(parent, label);
    const value = document.createElement('span');
    value.className = 'value';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    const id = `s-${label.replace(/\W+/g, '-').toLowerCase()}`;
    input.id = id;
    row.querySelector('label')?.setAttribute('for', id);
    const render = (): void => {
      value.textContent = format ? format(Number(input.value)) : input.value;
    };
    input.addEventListener('input', () => {
      render();
      onInput(Number(input.value));
    });
    render();
    row.appendChild(value);
    row.appendChild(input);
    return input;
  }

  private build(): void {
    const prefs = this.memory.data.prefs;

    // --- Sound ---------------------------------------------------------------
    const sound = this.section('Sound');
    this.toggleRow(sound, 'Muted', prefs.muted, (v) => {
      this.audio.setMuted(v);
      this.memory.setPref('muted', v);
    });
    this.sliderRow(sound, 'Volume', 0, 1, 0.01, prefs.volume, (v) => {
      this.audio.setVolume(v);
      this.memory.setPref('volume', v);
    }, (v) => `${Math.round(v * 100)}%`);

    // Bring your own music. The garden listens to whatever it is given.
    const musicRow = this.row(sound, 'Your music');
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'audio/*';
    file.id = 's-track';
    file.className = 'file';
    musicRow.querySelector('label')?.setAttribute('for', 's-track');
    const status = document.createElement('span');
    status.className = 'value';
    status.textContent = 'none';
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      status.textContent = 'listening…';
      const ok = await this.audio.loadTrack(f);
      status.textContent = ok ? f.name.slice(0, 22) : 'could not read that';
    });
    musicRow.appendChild(status);
    musicRow.appendChild(file);

    // --- The world -----------------------------------------------------------
    const worldSec = this.section('The garden');

    // Hour: the brief makes time central, so being able to visit any hour is a
    // real feature, not a debug control.
    const hourRow = this.sliderRow(
      worldSec, 'Hour', 0, 23.75, 0.25,
      prefs.hour ?? this.day.dayT * 24,
      (v) => {
        this.day.manualHour = v;
        this.memory.setPref('hour', v);
      },
      (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
    );
    if (prefs.hour !== null) this.day.manualHour = prefs.hour;

    const followRow = this.row(worldSec, 'Follow my clock');
    const follow = document.createElement('input');
    follow.type = 'checkbox';
    follow.className = 'switch';
    follow.id = 's-follow-clock';
    follow.checked = prefs.hour === null;
    followRow.querySelector('label')?.setAttribute('for', 's-follow-clock');
    follow.addEventListener('change', () => {
      if (follow.checked) {
        this.day.manualHour = null;
        this.memory.setPref('hour', null);
      } else {
        const h = this.day.dayT * 24;
        hourRow.value = String(h);
        hourRow.dispatchEvent(new Event('input'));
      }
    });
    followRow.appendChild(follow);
    hourRow.addEventListener('input', () => {
      follow.checked = false;
    });

    // --- Motion and access ---------------------------------------------------
    const access = this.section('Comfort');
    this.toggleRow(access, 'Reduced motion',
      prefs.reducedMotion ?? this.quality.device.prefersReducedMotion, (v) => {
        this.quality.reducedMotion = v;
        this.memory.setPref('reducedMotion', v);
        this.hooks.onReducedMotion(v);
      });
    this.toggleRow(access, 'Hide everything', false, (v) => this.hooks.onZeroUi(v));

    // --- Quality -------------------------------------------------------------
    const perf = this.section('Detail');
    const tierRow = this.row(perf, 'Quality');
    const select = document.createElement('select');
    select.id = 's-quality';
    tierRow.querySelector('label')?.setAttribute('for', 's-quality');
    for (const [value, label] of [
      ['cinematic', 'Cinematic'], ['beautiful', 'Beautiful'], ['performance', 'Performance'],
    ] as const) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
    }
    select.value = this.quality.tier;
    select.addEventListener('change', () => {
      // This genuinely rebuilds the field at the new density.
      this.world.setTier(select.value as TierName);
      this.memory.setPref('tier', select.value);
    });
    tierRow.appendChild(select);

    // Resolution adapts to hold a framerate. Worth exposing, because someone on
    // a big screen may prefer a sharp image at a lower framerate.
    this.toggleRow(perf, 'Adapt resolution', this.engine.adaptiveResolution, (v) => {
      this.engine.adaptiveResolution = v;
      if (!v) {
        this.engine.renderScale = 1;
        this.engine.applyQuality();
      }
    });

    this.toggleRow(perf, 'Smooth edges', true, (v) => {
      this.engine.fxaaPass.uniforms.uEnabled.value = v ? 1 : 0;
    });

    // Only offered where it can actually be afforded, which is a property of
    // the tier — and the tier can change under us, so the row comes and goes.
    const shadowInput = this.toggleRow(perf, 'Shadows', this.engine.shadow.enabled,
      (v) => this.engine.shadow.setEnabled(v));
    const shadowRow = shadowInput.parentElement as HTMLElement;
    const syncShadowRow = (): void => {
      shadowRow.hidden = !this.engine.shadow.available;
      shadowInput.checked = this.engine.shadow.enabled;
    };
    syncShadowRow();

    bus.on('quality:change', ({ tier }) => {
      select.value = tier;
      syncShadowRow();
    });

    // --- Memory --------------------------------------------------------------
    const mem = this.section('Memory');
    const memRow = this.row(mem, this.memory.ephemeral
      ? 'This browser is not saving'
      : 'The garden remembers you');
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'text-button';
    forget.textContent = 'Forget everything';
    forget.addEventListener('click', () => {
      this.memory.forget();
      forget.textContent = 'Forgotten';
      forget.disabled = true;
    });
    memRow.appendChild(forget);

    const replayRow = this.row(mem, 'Watch it grow again');
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'text-button';
    replay.textContent = 'From the first seed';
    replay.addEventListener('click', () => {
      this.setOpen(false);
      this.hooks.onReplay();
    });
    replayRow.appendChild(replay);
  }

  /** Live readout. Refreshed only while the panel is open. */
  update(fps: number): void {
    if (!this.open) return;
    const stats = this.world.tulips.stats();
    const lod = this.world.tulips.lodCounts();
    const scale = Math.round(this.engine.renderScale * 100);
    this.diagnostics.textContent =
      `${Math.round(fps)} fps · ${scale}% res · ${stats.tulips.toLocaleString()} tulips · ` +
      `${stats.chunks} chunks (${lod.high}/${lod.mid}/${lod.low}) · ` +
      `${this.day.label()} · ${this.weather.label()} · ${this.heart.label()}` +
      (this.audio.ready ? '' : ' · silent');
  }
}

const TULIP_MARK = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 22V12" />
  <path d="M12 13c-3 0-5-2.5-5-6 0-2.6 1.6-5 5-7 3.4 2 5 4.4 5 7 0 3.5-2 6-5 6z" />
</svg>`;
