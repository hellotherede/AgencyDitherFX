import { getGsap, useGsap } from '../animation/gsapBridge';
import { isErrorDiffusion } from '../algorithms/dither';
import { CanvasRenderer } from '../renderers/CanvasRenderer';
import { SourceAdapter } from '../sources/SourceAdapter';
import { scheduler } from '../utils/scheduler';
import { DEFAULT_OPTIONS } from './defaults';
import type {
  AgencyDitherOptions,
  GsapLike,
  RenderStats,
  SourceInput
} from './types';

type Container = HTMLElement | HTMLCanvasElement;
type Listener = (event: CustomEvent<RenderStats>) => void;

export class AgencyDitherFX {
  static useGSAP(gsap: GsapLike): void {
    useGsap(gsap);
  }

  readonly element: Container;
  readonly canvas: HTMLCanvasElement;
  readonly params: AgencyDitherOptions;
  private readonly renderer: CanvasRenderer;
  private readonly source = new SourceAdapter();
  private readonly secondarySource = new SourceAdapter();
  private readonly maskSource = new SourceAdapter();
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private readonly reducedMotion: MediaQueryList;
  private running = false;
  private visible = false;
  private destroyed = false;
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
    this.pointer.active = false;
  };
  private readonly onClick = (event: PointerEvent): void => {
    if (!this.params.interaction.clickRipple) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.rippleX = event.clientX - rect.left;
    this.pointer.rippleY = event.clientY - rect.top;
    this.pointer.rippleStarted = performance.now();
    this.start();
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
    this.renderer = new CanvasRenderer(this.canvas);
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.canvas.setAttribute('role', 'img');
    if (this.params.decorative) this.canvas.setAttribute('aria-hidden', 'true');
    if (this.params.fallback && !(element instanceof HTMLCanvasElement)) {
      element.style.backgroundImage = `url("${this.params.fallback}")`;
      element.style.backgroundSize = 'cover';
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.requestRender();
    });
    this.resizeObserver.observe(element);
    this.visibilityObserver = new IntersectionObserver(
      entries => {
        this.visible = entries[0]?.isIntersecting ?? false;
        if (this.visible) {
          this.source.play();
          this.secondarySource.play();
          this.maskSource.play();
          if (this.shouldLoop()) this.start();
          else this.requestRender();
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
    this.resize();

    if (this.params.source) void this.setSource(this.params.source);
    if (this.params.immediate) {
      this.visible = true;
      this.start();
    }
  }

  async setSource(input: SourceInput, kind?: 'image' | 'video'): Promise<this> {
    this.assertAlive();
    await this.source.set(input, kind);
    this.dirty = true;
    if (this.visible || this.params.immediate) {
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
    await this.secondarySource.set(input, kind);
    if (this.visible || this.params.immediate) await this.secondarySource.play();
    this.requestRender();
    return this;
  }

  async setMaskSource(
    input: SourceInput,
    kind?: 'image' | 'video'
  ): Promise<this> {
    this.assertAlive();
    await this.maskSource.set(input, kind);
    if (this.visible || this.params.immediate) await this.maskSource.play();
    this.requestRender();
    return this;
  }

  clearSecondarySource(): this {
    this.secondarySource.release();
    this.requestRender();
    return this;
  }

  clearMaskSource(): this {
    this.maskSource.release();
    this.requestRender();
    return this;
  }

  set(options: Partial<AgencyDitherOptions>): this {
    this.assertAlive();
    const merged = this.mergeOptions(this.params, options);
    Object.assign(this.params, merged);
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
    next.fallback = this.params.fallback;
    next.worker = this.params.worker;
    if (this.params.source) next.source = this.params.source;
    Object.assign(this.params, next);
    this.resize();
    this.requestRender();
    return this;
  }

  async registerSymbol(name: string, svg: string | SVGElement): Promise<this> {
    const markup =
      typeof svg === 'string' ? svg : new XMLSerializer().serializeToString(svg);
    const blob = new Blob([markup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await image.decode();
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
    this.renderer.removeSymbol(name);
    this.requestRender();
    return this;
  }

  render(time = performance.now()): this {
    if (this.destroyed || !this.source.current?.ready) return this;
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
    if (this.visible || this.params.immediate) scheduler.add(this);
    return this;
  }

  stop(): this {
    this.running = false;
    scheduler.remove(this);
    return this;
  }

  tick(time: number): boolean {
    if (!this.running || this.destroyed || (!this.visible && !this.params.immediate)) return false;
    const fps = isErrorDiffusion(this.params.algorithm)
      ? Math.min(12, this.params.maxFps)
      : Math.min(this.params.animation.fps, this.params.maxFps);
    if (time - this.lastRender < 1000 / Math.max(1, fps)) return true;
    this.lastRender = time;
    if (this.pointer.rippleStarted > 0 && time - this.pointer.rippleStarted > 2200) {
      this.pointer.rippleStarted = 0;
    }
    if (this.dirty || this.shouldLoop()) this.render(time);
    if (!this.shouldLoop() && this.oneShot) {
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
      onUpdate: () => this.requestRender()
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.source.release();
    this.secondarySource.release();
    this.maskSource.release();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onClick);
    if (!(this.element instanceof HTMLCanvasElement)) this.canvas.remove();
  }

  private requestRender(): void {
    this.dirty = true;
    if (this.visible || this.params.immediate) {
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

  private resize(): void {
    const rect = this.element.getBoundingClientRect();
    this.renderer.resize(rect.width || 1, rect.height || 1, this.params);
  }

  private trackFps(time: number): void {
    this.frameTimes.push(time);
    while (this.frameTimes.length && time - (this.frameTimes[0] ?? time) > 1000) {
      this.frameTimes.shift();
    }
    this.stats.fps = Math.max(0, this.frameTimes.length - 1);
    if (isErrorDiffusion(this.params.algorithm) && this.source.current?.dynamic) {
      this.stats.warning = 'Error diffusion is throttled for animated sources';
    } else if (this.params.renderer !== 'canvas') {
      this.stats.warning = `${this.params.renderer} requested; Canvas fallback is active`;
    }
  }

  private mergeOptions(
    base: AgencyDitherOptions,
    update: Partial<AgencyDitherOptions>
  ): AgencyDitherOptions {
    return {
      ...base,
      ...update,
      animation: { ...base.animation, ...update.animation },
      interaction: { ...base.interaction, ...update.interaction },
      palette: update.palette ? [...update.palette] : base.palette,
      toneMap: update.toneMap
        ? update.toneMap.map(item => ({ ...item }))
        : base.toneMap
    };
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('AgencyDitherFX instance has been destroyed.');
  }
}
