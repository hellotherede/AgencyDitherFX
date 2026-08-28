import { getGsap, useGsap } from '../animation/gsapBridge';
import { isErrorDiffusion } from '../algorithms/dither';
import { CanvasRenderer } from '../renderers/CanvasRenderer';
import { WebGLRenderer } from '../renderers/WebGLRenderer';
import type { DitherRenderer } from '../renderers/types';
import { SourceAdapter } from '../sources/SourceAdapter';
import { scheduler } from '../utils/scheduler';
import { DEFAULT_OPTIONS } from './defaults';
import type {
  AgencyDitherOptions,
  GsapLike,
  RendererKind,
  RenderStats,
  SourceInput
} from './types';

type Container = HTMLElement | HTMLCanvasElement;
type Listener = (event: CustomEvent<RenderStats>) => void;
type ErrorListener = (event: CustomEvent<Error>) => void;

/** The subset of a GSAP tween/timeline this class relies on. */
interface TrackedTween {
  kill?: () => void;
  isActive?: () => boolean;
  progress?: () => number;
}

/** Sweep finished tweens once the retained set reaches this size. */
const TWEEN_SWEEP_AT = 32;

/**
 * How long an inactive instance keeps its WebGL context before handing the slot
 * back. Long enough that scrolling past a section and back does not rebuild the
 * program, short enough that an off-screen section stops holding a scarce
 * resource.
 */
const GPU_RELEASE_DELAY_MS = 2000;

export class AgencyDitherFX {
  static useGSAP(gsap: GsapLike): void {
    useGsap(gsap);
  }

  readonly element: Container;
  canvas: HTMLCanvasElement;
  readonly params: AgencyDitherOptions;
  private renderer: DitherRenderer;
  private rendererSelection: string;
  private readonly source = new SourceAdapter();
  private readonly secondarySource = new SourceAdapter();
  private readonly maskSource = new SourceAdapter();
  private readonly symbols = new Map<string, CanvasImageSource>();
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private readonly reducedMotion: MediaQueryList;
  private running = false;
  private visible = false;
  private intersectionKnown = false;
  private destroyed = false;
  private suspended = false;
  // A WebGL context is a scarce per-page resource, so one is only held while
  // the instance is actually running. Instances start on Canvas and upgrade on
  // activation, which stops eight off-screen sections from consuming the whole
  // budget before the first one is even visible.
  private gpuAllowed = false;
  private gpuReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private rendererBudgetGeneration = -1;
  private pendingInitialSource: SourceInput | null = null;
  private dirty = true;
  private oneShot = false;
  private lastRender = 0;
  private renderListeners = 0;
  private fallbackNoticeKey = '';
  private fallbackNotice = '';
  private frameTimes: number[] = [];
  // Tweens target this.params, so they keep the instance (and its render
  // callback) alive after destroy() unless they are killed explicitly.
  private readonly tweens = new Set<TrackedTween>();
  private stats: RenderStats = {
    fps: 0, cells: 0, width: 0, height: 0, renderer: 'canvas', warning: ''
  };
  private pointer = {
    x: -10_000,
    y: -10_000,
    active: false,
    rippleX: 0,
    rippleY: 0,
    rippleStarted: 0
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    // offsetX/offsetY are already canvas-relative. Reading a bounding rect here
    // forced a synchronous layout on every pointer event, which is exactly the
    // wrong thing to do on a page that is also running scroll animations.
    this.pointer.x = event.offsetX;
    this.pointer.y = event.offsetY;
    this.pointer.active = true;
    if (this.params.interaction.pointer) this.requestRender();
  };
  private readonly onPointerLeave = (): void => {
    const wasActive = this.pointer.active;
    this.pointer.active = false;
    if (wasActive && this.params.interaction.pointer) this.requestRender();
  };
  private readonly onClick = (event: PointerEvent): void => {
    if (!this.params.interaction.clickRipple) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.rippleX = event.clientX - rect.left;
    this.pointer.rippleY = event.clientY - rect.top;
    this.pointer.rippleStarted = performance.now();
    this.start();
  };
  private readonly onReducedMotionChange = (): void => {
    if (!this.destroyed) this.requestRender();
  };
  private readonly onWebGLRestored = (): void => {
    this.requestRender();
  };
  private readonly onDocumentVisibilityChange = (): void => {
    if (document.hidden) {
      this.deactivate();
      return;
    }
    if (this.isActive()) this.activate();
  };

  constructor(target: string | Container, options: Partial<AgencyDitherOptions> = {}) {
    if (typeof document === 'undefined') {
      throw new Error('AgencyDitherFX instances require a browser DOM. Imports are SSR-safe.');
    }
    const element =
      typeof target === 'string' ? document.querySelector<Container>(target) : target;
    if (!element) throw new Error(`AgencyDitherFX target not found: ${String(target)}`);
    this.element = element;
    this.canvas =
      element instanceof HTMLCanvasElement
        ? element
        : Object.assign(document.createElement('canvas'), {
            className: 'agency-dither-fx'
          });
    if (!(element instanceof HTMLCanvasElement)) element.append(this.canvas);
    this.params = this.mergeOptions(DEFAULT_OPTIONS, options);
    this.pendingInitialSource = this.params.source ?? null;
    const initialRenderer = this.selectedRendererKind();
    this.renderer = this.createRenderer(this.canvas, initialRenderer);
    this.rendererSelection = `${this.params.renderer}:${initialRenderer}`;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.addEventListener('change', this.onReducedMotionChange);
    this.updateAccessibility();
    this.updateFallback();

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.requestRender();
    });
    this.resizeObserver.observe(element);
    this.visibilityObserver = new IntersectionObserver(
      entries => {
        this.intersectionKnown = true;
        this.visible = entries[0]?.isIntersecting ?? false;
        if (this.visible) {
          this.activate();
        } else {
          this.deactivate();
        }
      },
      { rootMargin: '160px' }
    );
    this.visibilityObserver.observe(element);
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.canvas.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    this.canvas.addEventListener('pointerdown', this.onClick, { passive: true });
    this.canvas.addEventListener('agencydither:webglrestored', this.onWebGLRestored);
    document.addEventListener('visibilitychange', this.onDocumentVisibilityChange);
    this.resize();

    if (this.params.immediate) {
      this.visible = true;
      this.activate();
    }
  }

  async setSource(input: SourceInput, kind?: 'image' | 'video'): Promise<this> {
    this.assertAlive();
    this.pendingInitialSource = null;
    const frame = await this.source.set(input, kind);
    if (!frame || this.destroyed) return this;
    this.dirty = true;
    if (this.isActive()) {
      await this.source.play();
      if (this.shouldLoop()) this.start();
      else this.render();
    }
    return this;
  }

  async setSecondarySource(
    input: SourceInput,
    kind?: 'image' | 'video'
  ): Promise<this> {
    this.assertAlive();
    const frame = await this.secondarySource.set(input, kind);
    if (!frame || this.destroyed) return this;
    if (this.isActive()) await this.secondarySource.play();
    this.ensureRenderer();
    this.resize();
    this.requestRender();
    return this;
  }

  async setMaskSource(
    input: SourceInput,
    kind?: 'image' | 'video'
  ): Promise<this> {
    this.assertAlive();
    const frame = await this.maskSource.set(input, kind);
    if (!frame || this.destroyed) return this;
    if (this.isActive()) await this.maskSource.play();
    this.ensureRenderer();
    this.resize();
    this.requestRender();
    return this;
  }

  clearSecondarySource(): this {
    this.secondarySource.release();
    this.ensureRenderer();
    this.resize();
    this.requestRender();
    return this;
  }

  clearMaskSource(): this {
    this.maskSource.release();
    this.ensureRenderer();
    this.resize();
    this.requestRender();
    return this;
  }

  set(options: Partial<AgencyDitherOptions>): this {
    this.assertAlive();
    const merged = this.mergeOptions(this.params, options);
    Object.assign(this.params, merged);
    this.updateAccessibility();
    this.updateFallback();
    // Switching an already-running instance to 'webgl' has to claim a context;
    // activation alone would not have done it while renderer was 'canvas'.
    if (this.isActive()) this.acquireGpu();
    this.ensureRenderer();
    this.resize();
    this.requestRender();
    return this;
  }

  setOptions(options: Partial<AgencyDitherOptions>): this {
    return this.set(options);
  }

  applyPreset(preset: Partial<AgencyDitherOptions>): this {
    this.assertAlive();
    const next = this.mergeOptions(DEFAULT_OPTIONS, preset);
    next.immediate = this.params.immediate;
    next.decorative = this.params.decorative;
    next.ariaLabel = this.params.ariaLabel;
    next.fallback = this.params.fallback;
    next.worker = this.params.worker;
    if (this.params.source) next.source = this.params.source;
    Object.assign(this.params, next);
    this.updateAccessibility();
    this.updateFallback();
    if (this.isActive()) this.acquireGpu();
    this.ensureRenderer();
    this.resize();
    this.requestRender();
    return this;
  }

  async registerSymbol(name: string, svg: string | SVGElement): Promise<this> {
    this.assertAlive();
    const markup =
      typeof svg === 'string' ? svg : new XMLSerializer().serializeToString(svg);
    const blob = new Blob([markup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await image.decode();
      if (this.destroyed) return this;
      this.symbols.set(name, image);
      this.renderer.setSymbol(name, image);
    } catch {
      throw new Error(`AgencyDitherFX could not decode SVG symbol "${name}".`);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.requestRender();
    return this;
  }

  async registerSymbols(
    symbols: Record<string, string | SVGElement>
  ): Promise<this> {
    for (const [name, svg] of Object.entries(symbols)) {
      await this.registerSymbol(name, svg);
    }
    return this;
  }

  unregisterSymbol(name: string): this {
    this.symbols.delete(name);
    this.renderer.removeSymbol(name);
    this.requestRender();
    return this;
  }

  render(time = performance.now()): this {
    if (this.destroyed || !this.source.current?.ready) return this;
    const previousRenderer = this.renderer;
    this.ensureRenderer();
    if (previousRenderer !== this.renderer) this.resize();
    this.stats = this.renderer.render(
      this.source.current,
      this.params,
      time,
      this.pointer,
      this.secondarySource.current,
      this.maskSource.current
    );
    this.trackFps(time);
    this.dirty = false;
    // Constructing and dispatching a DOM event every frame was noise next to a
    // 27 ms Canvas frame, but it is a real share of a 0.2 ms WebGL one. Only
    // instances that someone is listening to pay for it.
    if (this.renderListeners > 0) {
      this.element.dispatchEvent(new CustomEvent<RenderStats>('agencydither:render', {
        detail: this.stats
      }));
    }
    return this;
  }

  start(): this {
    if (this.destroyed) return this;
    this.running = true;
    if (this.isActive()) scheduler.add(this);
    return this;
  }

  stop(): this {
    this.running = false;
    scheduler.remove(this);
    return this;
  }

  tick(time: number): boolean {
    if (!this.running || this.destroyed || !this.isActive()) return false;
    const fps = isErrorDiffusion(this.params.algorithm)
      ? Math.min(12, this.params.maxFps)
      : Math.min(this.params.animation.fps, this.params.maxFps);
    if (time - this.lastRender < 1000 / Math.max(1, fps)) return true;
    this.lastRender = time;
    if (this.pointer.rippleStarted > 0 && time - this.pointer.rippleStarted > 2200) {
      this.pointer.rippleStarted = 0;
    }
    const shouldLoop = this.shouldLoop();
    if (this.dirty || shouldLoop) this.render(time);
    if (!shouldLoop && this.oneShot) {
      this.oneShot = false;
      this.running = false;
      return false;
    }
    return this.running;
  }

  to(vars: Partial<AgencyDitherOptions>, gsapVars: Record<string, unknown> = {}): unknown {
    const gsap = getGsap();
    let handle: TrackedTween | null = null;
    const tween = gsap.to(this.params, {
      ...vars,
      ...gsapVars,
      onUpdate: () => {
        this.requestRender();
        const callback = gsapVars.onUpdate;
        if (typeof callback === 'function') callback();
      },
      onComplete: () => {
        this.releaseTween(handle);
        const callback = gsapVars.onComplete;
        if (typeof callback === 'function') callback();
      }
    });
    handle = tween as TrackedTween;
    return this.track(tween);
  }

  fromTo(
    fromVars: Partial<AgencyDitherOptions>,
    toVars: Partial<AgencyDitherOptions>,
    gsapVars: Record<string, unknown> = {}
  ): unknown {
    let handle: TrackedTween | null = null;
    const tween = getGsap().fromTo(this.params, fromVars, {
      ...toVars,
      ...gsapVars,
      onUpdate: () => {
        this.requestRender();
        const callback = gsapVars.onUpdate;
        if (typeof callback === 'function') callback();
      },
      onComplete: () => {
        this.releaseTween(handle);
        const callback = gsapVars.onComplete;
        if (typeof callback === 'function') callback();
      }
    });
    handle = tween as TrackedTween;
    return this.track(tween);
  }

  timeline(vars: Record<string, unknown> = {}): unknown {
    return this.track(getGsap().timeline(vars));
  }

  scrollTrigger(options: Record<string, unknown>): unknown {
    return this.to({ revealProgress: 1 }, {
      scrollTrigger: { trigger: this.element, ...options }
    });
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }

  exportConfig(): string {
    const { source: _source, ...serializable } = this.params;
    return JSON.stringify(serializable, null, 2);
  }

  exportMarkup(): string {
    const config = this.exportConfig().replace(/</g, '\\u003c');
    return `<div data-agency-dither><script type="application/json" data-agency-dither-config>${config}</script></div>`;
  }

  onRender(listener: Listener): () => void {
    const wrapped = listener as EventListener;
    this.element.addEventListener('agencydither:render', wrapped);
    this.renderListeners += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.renderListeners -= 1;
      this.element.removeEventListener('agencydither:render', wrapped);
    };
  }

  /**
   * Opts an instance into per-frame render events for listeners attached with
   * `addEventListener` directly, which this class cannot count. `onRender()`
   * enables them automatically.
   */
  emitRenderEvents(enabled = true): this {
    this.renderListeners += enabled ? 1 : -1;
    if (this.renderListeners < 0) this.renderListeners = 0;
    return this;
  }

  onError(listener: ErrorListener): () => void {
    const wrapped = listener as EventListener;
    this.element.addEventListener('agencydither:error', wrapped);
    return () => this.element.removeEventListener('agencydither:error', wrapped);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Tweens hold this.params and this instance's onUpdate closure, so they
    // must be killed before anything else is torn down.
    for (const tween of this.tweens) tween.kill?.();
    this.tweens.clear();
    if (this.gpuReleaseTimer !== null) {
      clearTimeout(this.gpuReleaseTimer);
      this.gpuReleaseTimer = null;
    }
    this.stop();
    this.source.release();
    this.secondarySource.release();
    this.maskSource.release();
    this.renderer.destroy();
    this.symbols.clear();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.reducedMotion.removeEventListener('change', this.onReducedMotionChange);
    document.removeEventListener('visibilitychange', this.onDocumentVisibilityChange);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onClick);
    this.canvas.removeEventListener('agencydither:webglrestored', this.onWebGLRestored);
    if (!(this.element instanceof HTMLCanvasElement)) this.canvas.remove();
  }

  /** Retains any tween that exposes kill() so destroy() can release it. */
  private track(tween: unknown): unknown {
    const entry = tween as TrackedTween | null;
    if (!entry || typeof entry.kill !== 'function') return tween;
    if (this.tweens.size >= TWEEN_SWEEP_AT) this.pruneTweens();
    this.tweens.add(entry);
    return tween;
  }

  /**
   * Only live tweens need killing at destroy(), so finished ones are dropped.
   * Without this a page that retweens on every tab change would grow the set
   * for the lifetime of the instance.
   */
  private pruneTweens(): void {
    for (const tween of this.tweens) {
      if (typeof tween.isActive !== 'function') continue;
      if (tween.isActive()) continue;
      // A tween that is idle at the end of its timeline is done. One that is
      // idle at the start is merely delayed or paused, so it is kept.
      if ((tween.progress?.() ?? 0) >= 1) this.tweens.delete(tween);
    }
  }

  /** Removes one tween as soon as it reports completion. */
  private releaseTween(tween: TrackedTween | null): void {
    if (tween) this.tweens.delete(tween);
  }

  private requestRender(): void {
    this.dirty = true;
    if (this.isActive()) {
      this.oneShot = !this.shouldLoop();
      this.start();
    }
  }

  private shouldLoop(): boolean {
    if (this.reducedMotion.matches) return Boolean(this.source.current?.dynamic);
    return Boolean(
      this.source.current?.dynamic ||
      this.secondarySource.current?.dynamic ||
      this.maskSource.current?.dynamic ||
      this.params.animation.autoplay ||
      this.params.algorithm === 'random' ||
      this.params.glyphScramble > 0 ||
      this.pointer.rippleStarted > 0 ||
      (this.params.ambientEnabled && this.params.ambientAmount > 0) ||
      this.params.toneMap.some(band => (band.motionAmount ?? 0) > 0)
    );
  }

  private activate(): void {
    if (!this.isActive()) return;
    this.acquireGpu();
    const pendingSource = this.pendingInitialSource;
    if (pendingSource) {
      this.pendingInitialSource = null;
      void this.setSource(pendingSource).catch(error => this.reportError(error));
      return;
    }
    void this.source.play();
    void this.secondarySource.play();
    void this.maskSource.play();
    if (this.shouldLoop()) this.start();
    else this.requestRender();
  }

  private isActive(): boolean {
    return !this.suspended && !document.hidden && (
      this.visible || (this.params.immediate && !this.intersectionKnown)
    );
  }

  /**
   * Upgrades to the GPU renderer if this instance wants one. Called on every
   * activation, so a section that lost the context race earlier picks one up as
   * soon as another instance releases its slot.
   */
  private acquireGpu(): void {
    if (this.gpuReleaseTimer !== null) {
      clearTimeout(this.gpuReleaseTimer);
      this.gpuReleaseTimer = null;
    }
    if (this.params.renderer !== 'webgl' || this.gpuAllowed) return;
    this.gpuAllowed = true;
    const previous = this.renderer;
    this.ensureRenderer();
    if (previous !== this.renderer) this.resize();
  }

  /** Hands the WebGL slot back after a grace period of continuous inactivity. */
  private scheduleGpuRelease(): void {
    if (!this.gpuAllowed || this.gpuReleaseTimer !== null) return;
    this.gpuReleaseTimer = setTimeout(() => {
      this.gpuReleaseTimer = null;
      if (this.destroyed || this.isActive()) return;
      this.gpuAllowed = false;
      const previous = this.renderer;
      this.ensureRenderer();
      if (previous !== this.renderer) this.resize();
    }, GPU_RELEASE_DELAY_MS);
  }

  /** Everything that must stop when an instance goes idle. */
  private deactivate(): void {
    scheduler.remove(this);
    this.source.pause();
    this.secondarySource.pause();
    this.maskSource.pause();
    this.scheduleGpuRelease();
  }

  /**
   * Stops rendering and media playback until `resume()`. IntersectionObserver
   * cannot see a tab panel hidden with opacity or visibility while its geometry
   * still intersects the viewport, so carousels, tabs and sliders need to say
   * so explicitly.
   */
  suspend(): this {
    if (this.destroyed || this.suspended) return this;
    this.suspended = true;
    this.deactivate();
    return this;
  }

  /** Reverses `suspend()`, restarting only if the instance is otherwise active. */
  resume(): this {
    if (this.destroyed || !this.suspended) return this;
    this.suspended = false;
    if (this.isActive()) this.activate();
    return this;
  }

  /** Whether `suspend()` is currently holding this instance idle. */
  get isSuspended(): boolean {
    return this.suspended;
  }

  private resize(): void {
    const rect = this.element.getBoundingClientRect();
    this.renderer.resize(rect.width || 1, rect.height || 1, this.params);
  }

  private createRenderer(canvas: HTMLCanvasElement, kind = this.params.renderer): DitherRenderer {
    if (kind === 'webgl') {
      try {
        return new WebGLRenderer(canvas);
      } catch {
        // Getting the GL context can succeed and shader or buffer setup still
        // fail, which permanently denies this canvas a 2D context. Falling back
        // on the same element would then throw and take the instance with it,
        // so a poisoned canvas is swapped for a clean one first.
        if (!canvas.getContext('2d')) return new CanvasRenderer(this.swapCanvas());
        return new CanvasRenderer(canvas);
      }
    }
    return new CanvasRenderer(canvas);
  }

  /**
   * Replaces `this.canvas` with a fresh element, carrying over class, ARIA
   * state and pointer listeners. Returns the new canvas.
   */
  private swapCanvas(): HTMLCanvasElement {
    if (this.element instanceof HTMLCanvasElement) return this.canvas;
    const next = Object.assign(document.createElement('canvas'), {
      className: this.canvas.className
    });
    const role = this.canvas.getAttribute('role');
    if (role) next.setAttribute('role', role);
    if (this.canvas.getAttribute('aria-hidden') === 'true') {
      next.setAttribute('aria-hidden', 'true');
    }
    const label = this.canvas.getAttribute('aria-label');
    if (label) next.setAttribute('aria-label', label);
    this.detachCanvasListeners();
    if (this.canvas.parentNode) this.canvas.replaceWith(next);
    else this.element.append(next);
    this.canvas = next;
    this.attachCanvasListeners();
    return next;
  }

  private attachCanvasListeners(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.canvas.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    this.canvas.addEventListener('pointerdown', this.onClick, { passive: true });
    this.canvas.addEventListener('agencydither:webglrestored', this.onWebGLRestored);
  }

  private detachCanvasListeners(): void {
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onClick);
    this.canvas.removeEventListener('agencydither:webglrestored', this.onWebGLRestored);
  }

  private ensureRenderer(): void {
    const selected = this.selectedRendererKind();
    const selection = `${this.params.renderer}:${selected}`;
    // The generation check lets an instance that lost the context race retry
    // once a slot is freed. Without it a Canvas fallback was permanent, because
    // the selection string alone never changes back.
    const generation = WebGLRenderer.budgetGeneration;
    if (
      selection === this.rendererSelection &&
      generation === this.rendererBudgetGeneration
    ) {
      return;
    }
    this.rendererSelection = selection;
    this.rendererBudgetGeneration = generation;
    if (selected === this.renderer.kind) return;
    if (this.element instanceof HTMLCanvasElement) {
      this.renderer.destroy();
      this.renderer = this.createRenderer(this.canvas, selected);
      this.restoreSymbols();
      return;
    }

    // A canvas keeps the context type it was first given, so switching
    // renderers means starting from a fresh element.
    this.renderer.destroy();
    this.swapCanvas();
    this.renderer = this.createRenderer(this.canvas, selected);
    this.restoreSymbols();
    this.updateAccessibility();
  }

  private selectedRendererKind(): RendererKind {
    if (this.params.renderer !== 'webgl') return 'canvas';
    if (!this.gpuAllowed) return 'canvas';
    return WebGLRenderer.fallbackReason(
      this.params,
      this.secondarySource.current,
      this.maskSource.current
    )
      ? 'canvas'
      : 'webgl';
  }

  private restoreSymbols(): void {
    for (const [name, image] of this.symbols) this.renderer.setSymbol(name, image);
  }

  private updateAccessibility(): void {
    if (this.params.decorative) {
      this.canvas.setAttribute('aria-hidden', 'true');
      this.canvas.removeAttribute('role');
      this.canvas.removeAttribute('aria-label');
      return;
    }
    this.canvas.removeAttribute('aria-hidden');
    this.canvas.setAttribute('role', 'img');
    if (this.params.ariaLabel) this.canvas.setAttribute('aria-label', this.params.ariaLabel);
    else this.canvas.removeAttribute('aria-label');
  }

  private updateFallback(): void {
    if (this.element instanceof HTMLCanvasElement) return;
    this.element.style.backgroundImage = this.params.fallback
      ? `url("${this.params.fallback}")`
      : '';
    if (this.params.fallback) this.element.style.backgroundSize = 'cover';
  }

  private reportError(error: unknown): void {
    const detail = error instanceof Error ? error : new Error(String(error));
    this.element.dispatchEvent(new CustomEvent<Error>('agencydither:error', { detail }));
  }

  private trackFps(time: number): void {
    this.frameTimes.push(time);
    while (this.frameTimes.length && time - (this.frameTimes[0] ?? time) > 1000) {
      this.frameTimes.shift();
    }
    this.stats.fps = Math.max(0, this.frameTimes.length - 1);
    if (isErrorDiffusion(this.params.algorithm) && this.source.current?.dynamic) {
      this.stats.warning = 'Error diffusion is throttled for animated sources';
    } else if (this.params.renderer !== this.stats.renderer) {
      const reason = this.params.renderer === 'webgl'
        ? WebGLRenderer.fallbackReason(
            this.params,
            this.secondarySource.current,
            this.maskSource.current
          )
        : '';
      if (reason) {
        this.stats.warning = reason;
      } else {
        // Built once per renderer pairing rather than on every frame.
        const pair = `${this.params.renderer}:${this.stats.renderer}`;
        if (pair !== this.fallbackNoticeKey) {
          this.fallbackNoticeKey = pair;
          this.fallbackNotice =
            `${this.params.renderer} requested; ${this.stats.renderer} fallback is active`;
        }
        this.stats.warning = this.fallbackNotice;
      }
    }
  }

  private mergeOptions(
    base: AgencyDitherOptions,
    update: Partial<AgencyDitherOptions>
  ): AgencyDitherOptions {
    const animation = { ...base.animation, ...update.animation };
    const merged: AgencyDitherOptions = {
      ...base,
      ...update,
      animation,
      interaction: { ...base.interaction, ...update.interaction },
      palette: update.palette ? [...update.palette] : base.palette,
      toneMap: update.toneMap
        ? update.toneMap.map(item => ({ ...item }))
        : base.toneMap
    };
    if (update.animation?.noiseSpeed !== undefined && update.noiseSpeed === undefined) {
      merged.noiseSpeed = update.animation.noiseSpeed;
    }
    if (update.noiseSpeed !== undefined && update.animation?.noiseSpeed === undefined) {
      merged.animation.noiseSpeed = update.noiseSpeed;
    }
    if (
      update.animation?.glyphScramble !== undefined &&
      update.glyphScramble === undefined
    ) {
      merged.glyphScramble = update.animation.glyphScramble;
    }
    if (
      update.glyphScramble !== undefined &&
      update.animation?.glyphScramble === undefined
    ) {
      merged.animation.glyphScramble = update.glyphScramble;
    }
    return merged;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('AgencyDitherFX instance has been destroyed.');
  }
}
