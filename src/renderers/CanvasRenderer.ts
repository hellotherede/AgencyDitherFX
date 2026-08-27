import { ditherSamples } from '../algorithms/dither';
import type {
  AgencyDitherOptions,
  Primitive,
  RenderStats,
  SourceFrame,
  ToneBand
} from '../core/types';
import { hexToRgb, luminance } from '../utils/color';
import type { DitherRenderer, RendererPointerState } from './types';

const TAU = Math.PI * 2;

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

const hash = (x: number, y: number, seed: number): number => {
  let value = Math.imul(x + seed * 1013, 374761393) ^
    Math.imul(y + seed * 7919, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
};

type SamplePlacement = {
  fit: AgencyDitherOptions['fit'];
  positionX: number;
  positionY: number;
  scale: number;
};

type SampleCache = {
  source: SourceFrame | null;
  signature: string;
};

export class CanvasRenderer implements DitherRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly kind = 'canvas';
  private readonly context: CanvasRenderingContext2D;
  private readonly sampleCanvas = document.createElement('canvas');
  private readonly sampleContext: CanvasRenderingContext2D;
  private readonly secondaryCanvas = document.createElement('canvas');
  private readonly secondaryContext: CanvasRenderingContext2D;
  private readonly maskCanvas = document.createElement('canvas');
  private readonly maskContext: CanvasRenderingContext2D;
  private readonly rawCanvas = document.createElement('canvas');
  private readonly rawContext: CanvasRenderingContext2D;
  private samples = new Float32Array(0);
  private dithered = new Float32Array(0);
  private colors = new Uint8ClampedArray(0);
  private blendedSamples = new Float32Array(0);
  private blendedColors = new Uint8ClampedArray(0);
  private primarySamples = new Float32Array(0);
  private primaryColors = new Uint8ClampedArray(0);
  private secondarySamples = new Float32Array(0);
  private secondaryColors = new Uint8ClampedArray(0);
  private rawMaskSamples = new Float32Array(0);
  private maskSamples = new Float32Array(0);
  private primaryCache: SampleCache = { source: null, signature: '' };
  private secondaryCache: SampleCache = { source: null, signature: '' };
  private maskCache: SampleCache = { source: null, signature: '' };
  private rawImageData: ImageData | null = null;
  private maskActive = false;
  private glyphRampSource = '';
  private glyphRamp: string[] = [' '];
  private toneMapReference: ToneBand[] | null = null;
  private toneLookup = new Array<ToneBand | undefined>(256);
  private paletteReference: string[] | null = null;
  private paletteRgb: Array<[string, number, number, number]> = [];
  // The source-colour cache is keyed by the same 12-bit quantisation the
  // original used, so a flat array replaces a Map hash on every cell.
  private sourceColorCache = new Array<string | undefined>(4096);
  private paletteNearest = new Map<number, number>();
  private styleColor = '';
  private styleAlpha = -1;
  private columns = 0;
  private rows = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private symbols = new Map<string, CanvasImageSource>();
  private tintedSymbols = new Map<string, HTMLCanvasElement>();
  private firstSymbol = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: true });
    const sampleContext = this.sampleCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true
    });
    const secondaryContext = this.secondaryCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true
    });
    const maskContext = this.maskCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true
    });
    const rawContext = this.rawCanvas.getContext('2d', { alpha: true });
    if (
      !context ||
      !sampleContext ||
      !secondaryContext ||
      !maskContext ||
      !rawContext
    ) {
      throw new Error('AgencyDitherFX requires Canvas 2D support.');
    }
    this.context = context;
    this.sampleContext = sampleContext;
    this.secondaryContext = secondaryContext;
    this.maskContext = maskContext;
    this.rawContext = rawContext;
  }

  resize(width: number, height: number, options: AgencyDitherOptions): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr);
    const pixelWidth = Math.round(this.cssWidth * this.dpr * options.resolutionScale);
    const pixelHeight = Math.round(this.cssHeight * this.dpr * options.resolutionScale);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.canvas.style.width = `${this.cssWidth}px`;
      this.canvas.style.height = `${this.cssHeight}px`;
    }
  }

  setSymbol(name: string, image: CanvasImageSource): void {
    this.symbols.set(name, image);
    this.clearSymbolTints(name);
    if (!this.firstSymbol) this.firstSymbol = name;
  }

  removeSymbol(name: string): void {
    this.symbols.delete(name);
    this.clearSymbolTints(name);
    if (this.firstSymbol === name) this.firstSymbol = this.symbols.keys().next().value ?? '';
  }

  destroy(): void {
    this.symbols.clear();
    this.tintedSymbols.clear();
    this.sourceColorCache.fill(undefined);
    this.sampleCanvas.width = 0;
    this.secondaryCanvas.width = 0;
    this.maskCanvas.width = 0;
    this.rawCanvas.width = 0;
  }

  render(
    source: SourceFrame,
    options: AgencyDitherOptions,
    time: number,
    pointer: RendererPointerState,
    secondary?: SourceFrame | null,
    mask?: SourceFrame | null
  ): RenderStats {
    this.prepareGrid(options);
    const sampleStarted = performance.now();
    // Per-cell RGB is only read back by the source and palette colour modes.
    // Capturing it otherwise copied the full grid twice per frame for nothing.
    const wantsColors =
      options.colorMode === 'source' || options.colorMode === 'palette';
    this.sampleIntoCached(
      source,
      options,
      time,
      this.sampleCanvas,
      this.sampleContext,
      this.primarySamples,
      wantsColors ? this.primaryColors : undefined,
      this.primaryCache
    );
    if (secondary?.ready && options.sourceMix > 0) {
      this.sampleIntoCached(
        secondary,
        options,
        time,
        this.secondaryCanvas,
        this.secondaryContext,
        this.secondarySamples,
        wantsColors ? this.secondaryColors : undefined,
        this.secondaryCache
      );
      // Blending is the only path that needs a scratch copy; without it the
      // primary buffers are read directly instead of being memcpy'd each frame.
      this.blendedSamples.set(this.primarySamples);
      this.samples = this.blendedSamples;
      if (wantsColors) {
        this.blendedColors.set(this.primaryColors);
        this.colors = this.blendedColors;
      } else {
        this.colors = this.primaryColors;
      }
      this.blendSources(options.sourceMix, wantsColors);
    } else {
      this.samples = this.primarySamples;
      this.colors = this.primaryColors;
    }
    if (mask?.ready) {
      this.maskActive = true;
      this.sampleIntoCached(
        mask,
        options,
        time,
        this.maskCanvas,
        this.maskContext,
        this.rawMaskSamples,
        undefined,
        this.maskCache,
        {
          fit: options.maskFit,
          positionX: options.maskPositionX,
          positionY: options.maskPositionY,
          scale: options.maskScale
        }
      );
      this.maskSamples.set(this.rawMaskSamples);
    } else {
      this.maskActive = false;
    }
    const sampleFinished = performance.now();
    ditherSamples(
      this.samples,
      this.dithered,
      this.columns,
      this.rows,
      options.algorithm,
      options.ditherAmount,
      options.threshold,
      Math.floor(time * options.noiseSpeed * 0.02)
    );
    if (this.maskActive) this.applyMask(options);
    const ditherFinished = performance.now();
    this.clear(options);
    if (options.mode === 'raw-dither') {
      this.drawRaw(options);
    } else {
      this.prepareToneLookup(options.toneMap);
      this.preparePalette(options.palette);
      this.drawCells(options, time, pointer);
    }
    const drawFinished = performance.now();
    return {
      fps: 0,
      cells: this.columns * this.rows,
      width: this.canvas.width,
      height: this.canvas.height,
      renderer: this.kind,
      sampleMs: sampleFinished - sampleStarted,
      ditherMs: ditherFinished - sampleFinished,
      drawMs: drawFinished - ditherFinished,
      warning:
        this.columns * this.rows >= options.maxCells
          ? 'Cell count capped for performance'
          : ''
    };
  }

  private prepareGrid(options: AgencyDitherOptions): void {
    const responsiveScale = options.responsive
      ? Math.sqrt(this.cssWidth / Math.max(1, options.responsiveReferenceWidth))
      : 1;
    const effectiveCell = options.responsive
      ? clamp(
          options.cellSize * responsiveScale,
          options.responsiveMinCellSize,
          options.responsiveMaxCellSize
        )
      : Math.max(2, options.cellSize);
    let columns = Math.max(1, Math.ceil(this.cssWidth / effectiveCell));
    let rows = Math.max(1, Math.ceil(this.cssHeight / effectiveCell));
    const count = columns * rows;
    if (count > options.maxCells) {
      const scale = Math.sqrt(options.maxCells / count);
      columns = Math.max(1, Math.floor(columns * scale));
      rows = Math.max(1, Math.floor(rows * scale));
    }
    if (columns === this.columns && rows === this.rows) return;
    this.columns = columns;
    this.rows = rows;
    const size = columns * rows;
    this.dithered = new Float32Array(size);
    this.blendedSamples = new Float32Array(size);
    this.blendedColors = new Uint8ClampedArray(size * 4);
    this.primarySamples = new Float32Array(size);
    this.primaryColors = new Uint8ClampedArray(size * 4);
    this.samples = this.primarySamples;
    this.colors = this.primaryColors;
    this.secondarySamples = new Float32Array(size);
    this.secondaryColors = new Uint8ClampedArray(size * 4);
    this.rawMaskSamples = new Float32Array(size);
    this.rawMaskSamples.fill(1);
    this.maskSamples = new Float32Array(size);
    this.maskSamples.fill(1);
    this.primaryCache = { source: null, signature: '' };
    this.secondaryCache = { source: null, signature: '' };
    this.maskCache = { source: null, signature: '' };
    this.sampleCanvas.width = columns;
    this.sampleCanvas.height = rows;
    this.secondaryCanvas.width = columns;
    this.secondaryCanvas.height = rows;
    this.maskCanvas.width = columns;
    this.maskCanvas.height = rows;
    this.rawCanvas.width = columns;
    this.rawCanvas.height = rows;
    this.rawImageData = this.rawContext.createImageData(columns, rows);
  }

  private sampleIntoCached(
    source: SourceFrame,
    options: AgencyDitherOptions,
    time: number,
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    samples: Float32Array,
    colors: Uint8ClampedArray | undefined,
    cache: SampleCache,
    placement?: SamplePlacement
  ): void {
    // The colour buffer is only filled on demand, so a cached pass that skipped
    // it must not satisfy a later frame that needs it.
    const signature =
      `${this.sampleSignature(options, time, canvas, placement)}|${colors ? 1 : 0}`;
    if (!source.dynamic && cache.source === source && cache.signature === signature) return;
    this.sampleInto(source, options, time, canvas, context, samples, colors, placement);
    cache.source = source;
    cache.signature = signature;
  }

  private sampleSignature(
    options: AgencyDitherOptions,
    time: number,
    canvas: HTMLCanvasElement,
    placement?: SamplePlacement
  ): string {
    const active = placement ?? {
      fit: options.fit,
      positionX: 0.5,
      positionY: 0.5,
      scale: 1
    };
    const transform = placement
      ? 'mask'
      : [
          options.background,
          options.blur,
          options.contrast,
          options.brightness,
          options.gamma,
          options.invert,
          options.noiseAmount,
          options.noiseAmount > 0
            ? Math.floor(time * options.noiseSpeed * 0.02)
            : 0
        ].join(':');
    return [
      canvas.width,
      canvas.height,
      this.cssWidth,
      this.cssHeight,
      active.fit,
      active.positionX,
      active.positionY,
      active.scale,
      transform
    ].join('|');
  }

  private sampleInto(
    source: SourceFrame,
    options: AgencyDitherOptions,
    time: number,
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    samples: Float32Array,
    colors?: Uint8ClampedArray,
    placement?: SamplePlacement
  ): void {
    const { width, height } = canvas;
    const isMask = Boolean(placement);
    const activePlacement = placement ?? {
      fit: options.fit,
      positionX: 0.5,
      positionY: 0.5,
      scale: 1
    };
    const fit = activePlacement.fit === 'stretch' ? 'fill' : activePlacement.fit;
    let drawWidth = width;
    let drawHeight = height;
    if (fit === 'cover' || fit === 'contain') {
      const fitScale = fit === 'cover'
        ? Math.max(width / source.width, height / source.height)
        : Math.min(width / source.width, height / source.height);
      drawWidth = source.width * fitScale * activePlacement.scale;
      drawHeight = source.height * fitScale * activePlacement.scale;
    } else if (fit === 'none') {
      const sampleScale = Math.min(
        width / Math.max(1, this.cssWidth),
        height / Math.max(1, this.cssHeight)
      );
      drawWidth = source.width * sampleScale * activePlacement.scale;
      drawHeight = source.height * sampleScale * activePlacement.scale;
    } else {
      drawWidth = width * activePlacement.scale;
      drawHeight = height * activePlacement.scale;
    }
    const dx = (width - drawWidth) * clamp(activePlacement.positionX);
    const dy = (height - drawHeight) * clamp(activePlacement.positionY);

    context.save();
    context.fillStyle = isMask ? '#000000' : options.background;
    context.fillRect(0, 0, width, height);
    context.filter =
      !isMask && options.blur > 0 ? `blur(${options.blur}px)` : 'none';
    context.drawImage(source.drawable, dx, dy, drawWidth, drawHeight);
    context.restore();
    const image = context.getImageData(0, 0, width, height);
    const data = image.data;
    colors?.set(data);

    const count = samples.length;
    if (isMask) {
      for (let index = 0, offset = 0; index < count; index += 1, offset += 4) {
        samples[index] = clamp(luminance(data[offset]!, data[offset + 1]!, data[offset + 2]!));
      }
      return;
    }

    // The arithmetic below is deliberately bit-identical to the original
    // expression. A lookup table keyed on quantised luminance was measurably
    // faster but shifted samples by up to 1/1024, which is enough to flip cells
    // across the dither threshold and visibly change the output.
    // Math.pow(x, 1) === x, so skipping it when gamma is 1 (the default) is the
    // one part of the tone curve that can be optimised for free.
    const { contrast, brightness, gamma, invert, noiseAmount } = options;
    const linearGamma = gamma === 1;

    if (noiseAmount <= 0) {
      for (let index = 0, offset = 0; index < count; index += 1, offset += 4) {
        const lum =
          (data[offset]! * 0.2126 +
            data[offset + 1]! * 0.7152 +
            data[offset + 2]! * 0.0722) / 255;
        const shaped = clamp((lum - 0.5) * contrast + 0.5 + brightness);
        const toned = linearGamma ? shaped : Math.pow(shaped, gamma);
        samples[index] = invert ? 1 - toned : toned;
      }
      return;
    }

    // `frame` used to be recomputed for every pixel of every frame, and the
    // x/y reconstruction cost an integer divide per pixel.
    const frame = Math.floor(time * options.noiseSpeed * 0.02);
    let index = 0;
    let offset = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1, index += 1, offset += 4) {
        const lum =
          (data[offset]! * 0.2126 +
            data[offset + 1]! * 0.7152 +
            data[offset + 2]! * 0.0722) / 255;
        const shaped = clamp((lum - 0.5) * contrast + 0.5 + brightness);
        const toned = linearGamma ? shaped : Math.pow(shaped, gamma);
        const value =
          (invert ? 1 - toned : toned) + (hash(x, y, frame) - 0.5) * noiseAmount;
        samples[index] = clamp(value);
      }
    }
  }

  private blendSources(mix: number, withColors: boolean): void {
    const amount = clamp(mix);
    const inverse = 1 - amount;
    const samples = this.samples;
    const secondary = this.secondarySamples;
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = samples[index]! * inverse + secondary[index]! * amount;
    }
    if (!withColors) return;
    const colors = this.colors;
    const secondaryColors = this.secondaryColors;
    for (let index = 0; index < colors.length; index += 1) {
      colors[index] = Math.round(
        colors[index]! * inverse + secondaryColors[index]! * amount
      );
    }
  }

  private applyMask(options: AgencyDitherOptions): void {
    const threshold = clamp(options.maskThreshold);
    const feather = Math.max(0.001, options.maskFeather);
    for (let index = 0; index < this.dithered.length; index += 1) {
      let value = clamp(this.maskSamples[index] ?? 1);
      if (options.maskInvert) value = 1 - value;
      const alpha = (threshold <= 0
        ? value
        : clamp((value - threshold) / feather)) * clamp(options.maskProgress);
      this.maskSamples[index] = alpha;
      this.dithered[index] = (this.dithered[index] ?? 0) * alpha;
    }
  }

  private clear(options: AgencyDitherOptions): void {
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!options.transparent && !options.backgroundTransparent) {
      this.context.fillStyle = options.background;
      this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.context.scale(
      this.canvas.width / this.cssWidth,
      this.canvas.height / this.cssHeight
    );
  }

  private drawRaw(options: AgencyDitherOptions): void {
    const image =
      this.rawImageData ?? this.rawContext.createImageData(this.columns, this.rows);
    for (let index = 0; index < this.dithered.length; index += 1) {
      const value = Math.round(clamp(this.dithered[index] ?? 0) * 255);
      const offset = index * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
    this.rawContext.putImageData(image, 0, 0);
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(this.rawCanvas, 0, 0, this.cssWidth, this.cssHeight);
    this.context.imageSmoothingEnabled = true;
    if (options.colorMode !== 'monochrome') this.context.globalCompositeOperation = 'source-over';
  }

  private drawCells(
    options: AgencyDitherOptions,
    time: number,
    pointer: RendererPointerState
  ): void {
    const ctx = this.context;
    const cellWidth = this.cssWidth / this.columns;
    const cellHeight = this.cssHeight / this.rows;
    const reveal = clamp(options.revealProgress);
    if (options.glyphRamp !== this.glyphRampSource) {
      this.glyphRampSource = options.glyphRamp;
      this.glyphRamp = Array.from(options.glyphRamp || ' ');
    }
    const ramp = this.glyphRamp;
    const fontSize = Math.max(2, cellHeight * 0.98);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${options.fontWeight} ${fontSize}px ${options.fontFamily}`;

    // Every switch below is constant for the whole frame. Reading them once
    // keeps the per-cell loop down to the work that actually varies.
    const monochrome = options.colorMode === 'monochrome';
    const bands = options.toneMap.length > 0;
    const ambient = options.ambientEnabled && options.ambientAmount > 0;
    const displaced = options.displacement > 0;
    const pushes = pointer.active && options.mouseInfluence > 0;
    const ripples = pointer.rippleStarted > 0 && options.rippleStrength > 0;
    const skipTransparent = options.foregroundTransparent && monochrome;
    const fixedPrimitive =
      options.mode === 'hybrid'
        ? null
        : this.modePrimitive(options.mode, 0, options.primitiveMix);
    const flatToneScale =
      options.mode === 'ascii' && options.glyphSelection === 'random';
    const staggered = options.stagger;
    const staggerAmount = options.staggerAmount;
    const staggerFrom = options.staggerFrom;
    const foreground = options.foreground;
    const ambientMode = options.ambientMode;
    const ambientAmount = options.ambientAmount;
    const ambientFrequency = Math.max(0.001, options.ambientFrequency);
    const ambientElapsed = time * 0.001 * options.ambientSpeed;
    const displacement = options.displacement;
    const displacePhase = time * 0.0004;
    const rippleAge = (time - pointer.rippleStarted) / 1000;
    const rippleRadius = rippleAge * 240;
    const rippleStrength = options.rippleStrength;
    const mouseInfluence = options.mouseInfluence;

    this.styleColor = '';
    this.styleAlpha = -1;

    for (let y = 0; y < this.rows; y += 1) {
      const rowStart = y * this.columns;
      for (let x = 0; x < this.columns; x += 1) {
        const index = rowStart + x;
        const sourceValue = clamp(this.samples[index]!);
        const value = clamp(this.dithered[index]!);
        const maskValue = this.maskActive ? clamp(this.maskSamples[index]!) : 1;
        if (maskValue <= 0) continue;
        const band = bands ? this.findToneBand(sourceValue) : undefined;
        const revealAmount = this.cellReveal(
          x,
          y,
          index,
          band ? clamp(reveal - (band.revealOffset ?? 0)) : reveal,
          staggered,
          staggerAmount,
          staggerFrom
        );
        if (revealAmount <= 0) continue;
        const primitive =
          band?.primitive ??
          fixedPrimitive ??
          this.modePrimitive(options.mode, sourceValue, options.primitiveMix);
        if (primitive === 'none') continue;
        if (skipTransparent && !band?.color) continue;

        let px = (x + 0.5) * cellWidth;
        let py = (y + 0.5) * cellHeight;
        let ambientScale = 1;
        if (band) {
          px += (band.offsetX ?? 0) * cellWidth;
          py += (band.offsetY ?? 0) * cellHeight;
          const motionAmount = band.motionAmount ?? 0;
          if (motionAmount > 0) {
            const phase =
              time * 0.001 * (band.motionSpeed ?? 1) + x * 0.19 + y * 0.11;
            px += Math.cos(phase) * motionAmount * cellWidth;
            py += Math.sin(phase * 0.83) * motionAmount * cellHeight;
          }
        }
        if (ambient) {
          const spatial = (x + y * 0.73) * ambientFrequency;
          if (ambientMode === 'wave') {
            py += Math.sin(ambientElapsed * 2 + x * ambientFrequency) *
              ambientAmount *
              cellHeight;
          } else if (ambientMode === 'orbit') {
            const angle = ambientElapsed + spatial;
            px += Math.cos(angle) * ambientAmount * cellWidth;
            py += Math.sin(angle) * ambientAmount * cellHeight;
          } else if (ambientMode === 'pulse') {
            ambientScale =
              1 + Math.sin(ambientElapsed * 2 + spatial) * ambientAmount * 0.35;
          } else if (ambientMode === 'jitter') {
            const step = Math.floor(ambientElapsed * 10);
            const hashX = Math.imul(index + step * 101, 2654435761);
            const hashY = Math.imul(index + step * 211, 1597334677);
            px += ((((hashX ^ (hashX >>> 16)) >>> 0) / 4294967295) - 0.5) *
              ambientAmount *
              cellWidth;
            py += ((((hashY ^ (hashY >>> 16)) >>> 0) / 4294967295) - 0.5) *
              ambientAmount *
              cellHeight;
          } else {
            px += Math.cos(ambientElapsed + spatial) * ambientAmount * cellWidth;
            py += Math.sin(ambientElapsed * 0.83 + spatial) *
              ambientAmount *
              cellHeight;
          }
        }
        if (displaced) {
          const phase = sourceValue * Math.PI * 2 + displacePhase;
          px += Math.cos(phase + x * 0.17) * displacement * cellWidth;
          py += Math.sin(phase + y * 0.13) * displacement * cellHeight;
        }
        if (pushes) {
          const distance = Math.hypot(px - pointer.x, py - pointer.y);
          if (distance < 140) {
            const force = (1 - distance / 140) * mouseInfluence * cellWidth;
            const angle = Math.atan2(py - pointer.y, px - pointer.x);
            px += Math.cos(angle) * force;
            py += Math.sin(angle) * force;
          }
        }
        if (ripples) {
          const rippleDistance = Math.hypot(px - pointer.rippleX, py - pointer.rippleY);
          const wave = Math.exp(-Math.abs(rippleDistance - rippleRadius) / 30) *
            Math.sin(rippleDistance * 0.12 - rippleAge * 16);
          py += wave * rippleStrength * cellHeight;
        }

        const color = band?.color ??
          (monochrome ? foreground : this.cellColor(index, value, options));
        const toneScale = flatToneScale ? 1 : 0.15 + value * 0.85;
        const scale =
          (band?.scale ?? 1) *
          toneScale *
          (0.35 + revealAmount * 0.65) *
          ambientScale;
        const alpha = revealAmount * maskValue;

        this.drawPrimitive(
          primitive,
          px,
          py,
          cellWidth,
          cellHeight,
          value,
          scale,
          band,
          ramp,
          options,
          index,
          time,
          color,
          alpha
        );
      }
    }
    if (this.styleAlpha !== 1) ctx.globalAlpha = 1;
  }

  private cellReveal(
    x: number,
    y: number,
    index: number,
    progress: number,
    stagger: boolean,
    amount: number,
    from: AgencyDitherOptions['staggerFrom']
  ): number {
    if (!stagger || progress >= 1) return progress;
    if (progress <= 0) return 0;
    const nx = this.columns > 1 ? x / (this.columns - 1) : 0;
    const ny = this.rows > 1 ? y / (this.rows - 1) : 0;
    let order = index / Math.max(1, this.dithered.length - 1);

    if (from === 'end') {
      order = 1 - order;
    } else if (from === 'center') {
      order = Math.min(1, Math.hypot(nx - 0.5, ny - 0.5) / Math.SQRT1_2);
    } else if (from === 'edges') {
      order = 1 - Math.min(1, Math.hypot(nx - 0.5, ny - 0.5) / Math.SQRT1_2);
    } else if (from === 'left') {
      order = nx;
    } else if (from === 'right') {
      order = 1 - nx;
    } else if (from === 'top') {
      order = ny;
    } else if (from === 'bottom') {
      order = 1 - ny;
    } else if (from === 'top-left') {
      order = (nx + ny) * 0.5;
    } else if (from === 'top-right') {
      order = (1 - nx + ny) * 0.5;
    } else if (from === 'bottom-left') {
      order = (nx + 1 - ny) * 0.5;
    } else if (from === 'bottom-right') {
      order = (2 - nx - ny) * 0.5;
    } else if (from === 'random') {
      const value = Math.imul(index + 1, 2654435761);
      order = ((value ^ (value >>> 16)) >>> 0) / 4294967295;
    }

    const spread = clamp(amount);
    const start = order * spread;
    const duration = Math.max(0.001, 1 - spread);
    const local = clamp((progress - start) / duration);
    return 1 - (1 - local) ** 3;
  }

  /**
   * Draws one cell. Everything here deliberately stays on Skia's dedicated
   * fast paths: fillRect for blocks, a single-arc path for dots, and fillText
   * for glyphs. Accumulating cells into one large path, or blitting glyphs from
   * a hand-rolled atlas, both measured substantially slower - Chrome already
   * batches small fills and keeps its own GPU glyph atlas internally.
   */
  private drawPrimitive(
    primitive: Primitive,
    x: number,
    y: number,
    width: number,
    height: number,
    value: number,
    scale: number,
    band: ToneBand | undefined,
    ramp: string[],
    options: AgencyDitherOptions,
    index: number,
    time: number,
    color: string,
    alpha: number
  ): void {
    const ctx = this.context;
    this.applyStyle(color, alpha);
    const size = Math.min(width, height);

    if (primitive === 'dot') {
      ctx.beginPath();
      ctx.arc(x, y, size * 0.5 * scale * options.dotScale, 0, TAU);
      ctx.fill();
      return;
    }

    if (primitive === 'block') {
      const rotation = options.rotation + (band?.rotation ?? 0);
      const scaledWidth = width * scale;
      const scaledHeight = height * scale;
      if (rotation === 0) {
        ctx.fillRect(
          x - scaledWidth * 0.5,
          y - scaledHeight * 0.5,
          scaledWidth,
          scaledHeight
        );
        return;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.fillRect(
        -scaledWidth * 0.5,
        -scaledHeight * 0.5,
        scaledWidth,
        scaledHeight
      );
      ctx.restore();
      return;
    }

    if (primitive === 'line') {
      ctx.lineWidth = Math.max(1, size * 0.12 * scale);
      ctx.beginPath();
      ctx.moveTo(x - width * 0.4, y + height * 0.4);
      ctx.lineTo(x + width * 0.4, y - height * 0.4);
      ctx.stroke();
      return;
    }

    if (primitive === 'symbol') {
      const symbolName = band?.symbol ?? this.firstSymbol;
      const symbol = band?.color
        ? this.getTintedSymbol(symbolName, band.color)
        : this.symbols.get(symbolName);
      if (!symbol) return;
      const symbolScale = scale * options.symbolScale;
      ctx.drawImage(
        symbol,
        x - width * symbolScale * 0.5,
        y - height * symbolScale * 0.5,
        width * symbolScale,
        height * symbolScale
      );
      return;
    }

    const override = band?.glyph;
    if (override !== undefined) {
      ctx.fillText(override, x, y);
      return;
    }
    const glyphIndex = this.glyphIndexFor(value, ramp, options, index, time);
    ctx.fillText(ramp[glyphIndex] ?? ' ', x, y);
  }

  private glyphIndexFor(
    value: number,
    ramp: string[],
    options: AgencyDitherOptions,
    index: number,
    time: number
  ): number {
    let glyphIndex = Math.round(value * (ramp.length - 1));
    if (options.glyphSelection === 'random') {
      const randomGlyph = hash(
        index % this.columns,
        (index / this.columns) | 0,
        Math.round(options.glyphSeed)
      );
      glyphIndex = ramp.length === 2
        ? (randomGlyph < clamp(options.glyphProbability) ? 1 : 0)
        : Math.min(ramp.length - 1, Math.floor(randomGlyph * ramp.length));
    }
    if (
      options.glyphScramble > 0 &&
      ((index * 16807 + Math.floor(time / 70)) % 100) / 100 < options.glyphScramble
    ) {
      glyphIndex = (index + Math.floor(time / 80)) % ramp.length;
    }
    return glyphIndex;
  }

  /**
   * Applies fill/stroke state only when it actually changes. `styleColor` and
   * `styleAlpha` mirror what is currently set on the context.
   */
  private applyStyle(color: string, alpha: number): void {
    const ctx = this.context;
    if (this.styleAlpha !== alpha) {
      ctx.globalAlpha = alpha;
      this.styleAlpha = alpha;
    }
    if (this.styleColor !== color) {
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      this.styleColor = color;
    }
  }

  private prepareToneLookup(toneMap: ToneBand[]): void {
    if (toneMap === this.toneMapReference) return;
    this.toneMapReference = toneMap;
    for (let index = 0; index < this.toneLookup.length; index += 1) {
      const value = index / (this.toneLookup.length - 1);
      this.toneLookup[index] = toneMap.find(
        band => value >= band.min && value <= band.max
      );
    }
  }

  private findToneBand(value: number): ToneBand | undefined {
    return this.toneLookup[Math.round(clamp(value) * 255)];
  }

  private getTintedSymbol(name: string, color: string): CanvasImageSource | undefined {
    const key = `${name}:${color}`;
    const cached = this.tintedSymbols.get(key);
    if (cached) return cached;
    const source = this.symbols.get(name);
    if (!source) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) return source;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.tintedSymbols.set(key, canvas);
    return canvas;
  }

  private clearSymbolTints(name: string): void {
    for (const key of this.tintedSymbols.keys()) {
      if (key.startsWith(`${name}:`)) this.tintedSymbols.delete(key);
    }
  }

  private modePrimitive(
    mode: AgencyDitherOptions['mode'],
    value: number,
    mix: number
  ): Primitive {
    if (mode === 'dots' || mode === 'halftone') return 'dot';
    if (mode === 'blocks') return 'block';
    if (mode === 'ascii') return 'glyph';
    if (mode === 'symbols') return 'symbol';
    if (mode === 'hybrid') return value < mix * 0.5 ? 'block' : value < 0.75 ? 'dot' : 'glyph';
    return 'block';
  }

  private cellColor(index: number, value: number, options: AgencyDitherOptions): string {
    if (options.colorMode === 'source') {
      const offset = index * 4;
      const r = this.colors[offset]! >> 4;
      const g = this.colors[offset + 1]! >> 4;
      const b = this.colors[offset + 2]! >> 4;
      const key = (r << 8) | (g << 4) | b;
      const cached = this.sourceColorCache[key];
      if (cached !== undefined) return cached;
      const color = `rgb(${r * 17} ${g * 17} ${b * 17})`;
      this.sourceColorCache[key] = color;
      return color;
    }
    if (options.colorMode === 'brightness') {
      const paletteIndex = Math.min(
        options.palette.length - 1,
        Math.floor(clamp(this.samples[index] ?? value) * options.palette.length)
      );
      return options.palette[Math.max(0, paletteIndex)] ?? options.foreground;
    }
    if (options.colorMode === 'palette') {
      const offset = index * 4;
      const r = this.colors[offset]!;
      const g = this.colors[offset + 1]!;
      const b = this.colors[offset + 2]!;
      // Memoised on the exact colour, not a quantised one: quantising here
      // moved pixels across palette Voronoi boundaries and changed the output.
      const key = (r << 16) | (g << 8) | b;
      let slot = this.paletteNearest.get(key) ?? -1;
      if (slot < 0) {
        let nearestDistance = Number.POSITIVE_INFINITY;
        slot = 0;
        for (let entry = 0; entry < this.paletteRgb.length; entry += 1) {
          const [, pr, pg, pb] = this.paletteRgb[entry]!;
          const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            slot = entry;
          }
        }
        this.paletteNearest.set(key, slot);
        // Bounded by the distinct colours a frame actually contains.
        if (this.paletteNearest.size > 1 << 16) this.paletteNearest.clear();
      }
      const nearest = this.paletteRgb[slot];
      if (!nearest) return options.foreground;
      const mix = clamp(options.paletteMix);
      if (mix < 1) {
        const inverse = 1 - mix;
        const mixedR = Math.round(r * inverse + nearest[1] * mix);
        const mixedG = Math.round(g * inverse + nearest[2] * mix);
        const mixedB = Math.round(b * inverse + nearest[3] * mix);
        return `rgb(${mixedR} ${mixedG} ${mixedB})`;
      }
      return nearest[0];
    }
    return options.foreground;
  }

  private preparePalette(palette: string[]): void {
    if (palette === this.paletteReference) return;
    this.paletteReference = palette;
    this.paletteRgb = palette.map(color => {
      const [r, g, b] = hexToRgb(color);
      return [color, r, g, b];
    });
    this.paletteNearest.clear();
  }
}
