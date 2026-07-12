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
  private pendingInitialSource: SourceInput | null = null;
  private dirty = true;
  private oneShot = false;
  private lastRender = 0;
  private frameTimes: number[] = [];
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
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = event.clientX - rect.left;
    this.pointer.y = event.clientY - rect.top;
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
      scheduler.remove(this);
      this.source.pause();
      this.secondarySource.pause();
      this.maskSource.pause();
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
          scheduler.remove(this);
          this.source.pause();
          this.secondarySource.pause();
          this.maskSource.pause();
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
    this.element.dispatchEvent(new CustomEvent<RenderStats>('agencydither:render', {
      detail: this.stats
    }));
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
    return gsap.to(this.params, {
      ...vars,
      ...gsapVars,
      onUpdate: () => {
        this.requestRender();
        const callback = gsapVars.onUpdate;
        if (typeof callback === 'function') callback();
      }
    });
  }

  fromTo(
    fromVars: Partial<AgencyDitherOptions>,
    toVars: Partial<AgencyDitherOptions>,
    gsapVars: Record<string, unknown> = {}
  ): unknown {
    return getGsap().fromTo(this.params, fromVars, {
      ...toVars,
      ...gsapVars,
      onUpdate: () => {
        this.requestRender();
        const callback = gsapVars.onUpdate;
        if (typeof callback === 'function') callback();
      }
    });
  }

  timeline(vars: Record<string, unknown> = {}): unknown {
    return getGsap().timeline(vars);
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
    return () => this.element.removeEventListener('agencydither:render', wrapped);
  }

  onError(listener: ErrorListener): () => void {
    const wrapped = listener as EventListener;
    this.element.addEventListener('agencydither:error', wrapped);
    return () => this.element.removeEventListener('agencydither:error', wrapped);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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
    return !document.hidden && (
      this.visible || (this.params.immediate && !this.intersectionKnown)
    );
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
        return new CanvasRenderer(canvas);
      }
    }
    return new CanvasRenderer(canvas);
  }

  private ensureRenderer(): void {
    const selected = this.selectedRendererKind();
    const selection = `${this.params.renderer}:${selected}`;
    if (selection === this.rendererSelection) return;
    this.rendererSelection = selection;
    if (selected === this.renderer.kind) return;
    if (this.element instanceof HTMLCanvasElement) {
      this.renderer.destroy();
      this.renderer = this.createRenderer(this.canvas, selected);
      this.restoreSymbols();
      return;
    }

    const nextCanvas = Object.assign(document.createElement('canvas'), {
      className: this.canvas.className
    });
    nextCanvas.setAttribute('role', this.canvas.getAttribute('role') ?? 'img');
    if (this.canvas.getAttribute('aria-hidden') === 'true') {
      nextCanvas.setAttribute('aria-hidden', 'true');
    }
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onClick);
    this.canvas.removeEventListener('agencydither:webglrestored', this.onWebGLRestored);
    this.renderer.destroy();
    this.canvas.replaceWith(nextCanvas);
    this.canvas = nextCanvas;
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.canvas.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    this.canvas.addEventListener('pointerdown', this.onClick, { passive: true });
    this.canvas.addEventListener('agencydither:webglrestored', this.onWebGLRestored);
    this.renderer = this.createRenderer(this.canvas, selected);
    this.restoreSymbols();
    this.updateAccessibility();
  }

  private selectedRendererKind(): RendererKind {
    if (this.params.renderer !== 'webgl') return 'canvas';
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
      this.stats.warning = reason ||
        `${this.params.renderer} requested; ${this.stats.renderer} fallback is active`;
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
