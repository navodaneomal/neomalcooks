import { bus } from '../core/Bus';
import type { CodeLine, Token } from '../narrative/CodePoem';
import { LOADING_STAGES, LOADING_FINAL } from '../narrative/CodePoem';

/**
 * Everything drawn as DOM rather than WebGL: the loader, the code, the
 * whispered messages, the titles.
 *
 * Text belongs in the document, not in a texture — it stays crisp at any
 * resolution, it can be selected and read by a screen reader, and it costs
 * nothing to animate. The rule the brief sets is restraint: at almost every
 * moment this layer is completely empty.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (parent) parent.appendChild(node);
  return node;
}

export class Overlay {
  readonly root: HTMLElement;

  private loader: HTMLElement;
  private loaderStage: HTMLElement;
  private loaderSprout: HTMLElement;
  private loaderHint: HTMLElement;
  private codeLayer: HTMLElement;
  private codePre: HTMLElement;
  private titleLayer: HTMLElement;
  private messageLayer: HTMLElement;
  private whisperLayer: HTMLElement;
  private cursorLayer: HTMLElement;

  /** True once the loader has actually been dismissed. */
  private entered = false;
  /**
   * True once the visitor has touched anything at all — even during loading.
   *
   * The listeners are bound from construction rather than when the loader is
   * ready for them, because someone who taps early would otherwise have their
   * gesture swallowed and be left sitting on a screen that says "touch
   * anywhere" having already done so. An early gesture is remembered and
   * honoured the moment the world is ready.
   */
  private entryRequested = false;
  /** Called on that first gesture, whenever it arrives, so audio can unlock. */
  onFirstGesture: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.className = 'ui';

    // --- Loader ------------------------------------------------------------
    this.loader = el('div', 'loader', root);
    const box = el('div', 'loader-box', this.loader);
    this.loaderSprout = el('div', 'sprout', box);
    this.loaderSprout.innerHTML = SPROUT_SVG;
    this.loaderStage = el('div', 'loader-stage', box);
    this.loaderStage.textContent = LOADING_STAGES[0];
    this.loaderHint = el('div', 'loader-hint', box);
    this.loaderHint.textContent = '';

    // --- Code --------------------------------------------------------------
    this.codeLayer = el('div', 'code-layer', root);
    this.codePre = el('pre', 'code', this.codeLayer);

    // --- Titles, messages, whispers ----------------------------------------
    this.titleLayer = el('div', 'title-layer', root);
    this.messageLayer = el('div', 'message-layer', root);
    this.whisperLayer = el('div', 'whisper-layer', root);
    this.cursorLayer = el('div', 'cursor-layer', root);

    window.addEventListener('pointerdown', this.noteGesture, { passive: true });
    window.addEventListener('keydown', this.noteGesture, { passive: true });
    window.addEventListener('touchstart', this.noteGesture, { passive: true });
  }

  private noteGesture = (): void => {
    if (this.entryRequested) return;
    this.entryRequested = true;
    this.onFirstGesture?.();
  };

  // -----------------------------------------------------------------------
  // Loader
  // -----------------------------------------------------------------------

  setLoaderStage(i: number): void {
    this.loaderStage.textContent = LOADING_STAGES[Math.min(i, LOADING_STAGES.length - 1)];
    this.loaderStage.classList.remove('flip');
    // Force a reflow so the animation restarts on every stage.
    void this.loaderStage.offsetWidth;
    this.loaderStage.classList.add('flip');
    this.loaderSprout.style.setProperty('--grow', String((i + 1) / LOADING_STAGES.length));
  }

  /**
   * The final beat. Audio cannot start without a gesture, so the loader asks
   * for one — unless the visitor already gave it while the world was building,
   * in which case it simply opens.
   */
  async awaitEntry(): Promise<void> {
    this.loaderStage.textContent = LOADING_FINAL;
    this.loaderStage.classList.add('final');
    this.loaderSprout.style.setProperty('--grow', '1');

    const dismiss = (): Promise<void> => {
      this.entered = true;
      this.loader.classList.add('gone');
      return new Promise<void>((resolve) => {
        window.setTimeout(() => {
          this.loader.style.display = 'none';
          resolve();
        }, 1400);
      });
    };

    if (this.entryRequested) {
      // They have already touched it. Let the last line land, then open.
      await wait(900);
      return dismiss();
    }

    this.loaderHint.textContent = 'touch anywhere';
    this.loaderHint.classList.add('show');

    await new Promise<void>((resolve) => {
      const go = (): void => {
        if (this.entered) return;
        window.removeEventListener('pointerdown', go);
        window.removeEventListener('keydown', go);
        resolve();
      };
      window.addEventListener('pointerdown', go);
      window.addEventListener('keydown', go);
    });
    return dismiss();
  }

  // -----------------------------------------------------------------------
  // Code
  // -----------------------------------------------------------------------

  private codeLines: HTMLElement[] = [];

  clearCode(): void {
    this.codePre.textContent = '';
    this.codeLines = [];
    this.codeLayer.classList.remove('show', 'centre');
  }

  showCode(centre = false): void {
    this.codeLayer.classList.add('show');
    this.codeLayer.classList.toggle('centre', centre);
  }

  hideCode(): void {
    this.codeLayer.classList.remove('show');
  }

  /** Append one line of the poem, typed out. */
  addCodeLine(line: CodeLine): HTMLElement {
    const div = el('div', 'code-line', this.codePre);
    if (line.length === 0) {
      div.innerHTML = '&nbsp;';
    } else {
      for (const [kind, text] of line as Token[]) {
        const span = el('span', `t-${kind}`, div);
        span.textContent = text;
      }
    }
    this.codeLines.push(div);
    // Keep the visible window short; this is atmosphere, not a listing.
    while (this.codeLines.length > 22) {
      const old = this.codeLines.shift();
      old?.remove();
    }
    // Reveal with a slight stagger via CSS.
    requestAnimationFrame(() => div.classList.add('in'));
    return div;
  }

  setCursorVisible(v: boolean): void {
    this.codePre.classList.toggle('caret', v);
  }

  // -----------------------------------------------------------------------
  // Titles and messages
  // -----------------------------------------------------------------------

  /** The big, restrained lines: "WORLD CREATED." / "FOR HER." */
  async title(text: string, holdMs = 2600, cls = ''): Promise<void> {
    const div = el('div', `title ${cls}`, this.titleLayer);
    div.textContent = text;
    requestAnimationFrame(() => div.classList.add('in'));
    await wait(holdMs);
    div.classList.remove('in');
    await wait(1500);
    div.remove();
  }

  /**
   * A message from a tulip. Rises from where the flower is and dissolves —
   * never a notification, never a box.
   */
  petalMessage(text: string, sx: number, sy: number): void {
    const div = el('div', 'petal-message', this.messageLayer);
    div.textContent = text;
    div.style.left = `${sx}px`;
    div.style.top = `${sy}px`;
    requestAnimationFrame(() => div.classList.add('in'));
    window.setTimeout(() => div.classList.remove('in'), 4200);
    window.setTimeout(() => div.remove(), 7000);
  }

  /**
   * A discovery. Deliberately tiny and low-contrast: the brief is explicit that
   * finding something must not feel like an achievement popup.
   */
  whisper(text: string): void {
    const div = el('div', 'whisper', this.whisperLayer);
    div.textContent = text;
    requestAnimationFrame(() => div.classList.add('in'));
    window.setTimeout(() => div.classList.remove('in'), 4600);
    window.setTimeout(() => div.remove(), 7200);
  }

  // -----------------------------------------------------------------------
  // The fourth wall
  // -----------------------------------------------------------------------

  /** A cursor that moves by itself and clicks RUN AGAIN (brief §41). */
  async fourthWall(): Promise<void> {
    this.cursorLayer.classList.add('show');
    const cursor = el('div', 'fake-cursor', this.cursorLayer);
    const button = el('div', 'run-again', this.cursorLayer);
    button.textContent = 'RUN AGAIN';

    // Start off-centre, then drift to the button as if someone were doing it.
    cursor.style.left = '28%';
    cursor.style.top = '72%';
    await wait(1400);
    button.classList.add('in');
    await wait(700);

    const rect = button.getBoundingClientRect();
    cursor.style.transition = 'left 1.9s cubic-bezier(.4,.1,.2,1), top 1.9s cubic-bezier(.4,.1,.2,1)';
    cursor.style.left = `${rect.left + rect.width * 0.5}px`;
    cursor.style.top = `${rect.top + rect.height * 0.55}px`;
    await wait(2200);

    cursor.classList.add('click');
    button.classList.add('pressed');
    await wait(600);

    this.cursorLayer.classList.remove('show');
    await wait(900);
    cursor.remove();
    button.remove();
  }

  setBlackout(on: boolean): void {
    this.root.classList.toggle('blackout', on);
  }

  /** Zero-UI mode: everything but the world disappears (brief §53). */
  setChromeVisible(v: boolean): void {
    this.root.classList.toggle('no-chrome', !v);
    bus.emit('ui:toggle', { visible: v });
  }
}

export const wait = (ms: number): Promise<void> =>
  new Promise((r) => window.setTimeout(r, ms));

/** A tulip that grows as the world loads — the loading bar the brief forbids. */
const SPROUT_SVG = `
<svg viewBox="0 0 120 150" aria-hidden="true">
  <g class="sprout-stem">
    <path d="M60 148 C 60 120, 60 100, 60 78" />
  </g>
  <g class="sprout-leaf">
    <path d="M60 120 C 40 116, 28 100, 26 84 C 44 88, 56 102, 60 120 Z" />
    <path d="M60 112 C 80 108, 92 92, 94 76 C 76 80, 64 94, 60 112 Z" />
  </g>
  <g class="sprout-bloom">
    <path d="M60 80 C 48 80, 41 70, 41 56 C 41 44, 48 34, 60 26 C 72 34, 79 44, 79 56 C 79 70, 72 80, 60 80 Z" />
    <path d="M60 78 C 52 74, 48 64, 49 52 C 53 60, 57 68, 60 78 Z" />
    <path d="M60 78 C 68 74, 72 64, 71 52 C 67 60, 63 68, 60 78 Z" />
  </g>
</svg>`;
