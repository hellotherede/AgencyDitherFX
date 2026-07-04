import { ditherSamples } from '../algorithms/dither';
import type {
  AgencyDitherOptions,
  Primitive,
  RenderStats,
  SourceFrame,
  ToneBand
} from '../core/types';
import { hexToRgb, luminance } from '../utils/color';

interface PointerState {
  x: number;
  y: number;
  active: boolean;
  rippleX: number;
  rippleY: number;
  rippleStarted: number;
}

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
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
  private secondarySamples = new Float32Array(0);
  private secondaryColors = new Uint8ClampedArray(0);
  private maskSamples = new Float32Array(0);
  private maskColors = new Uint8ClampedArray(0);
  private rawImageData: ImageData | null = null;
  private maskActive = false;
  private glyphRampSource = '';
  private glyphRamp: string[] = [' '];
  private toneMapReference: ToneBand[] | null = null;
  private toneLookup = new Array<ToneBand | undefined>(256);
  private paletteReference: string[] | null = null;
  private paletteRgb: Array<[string, number, number, number]> = [];
  private sourceColorCache = new Map<number, string>();
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

  render(
    source: SourceFrame,
    options: AgencyDitherOptions,
    time: number,
    pointer: PointerState,
    secondary?: SourceFrame | null,
    mask?: SourceFrame | null
  ): RenderStats {
    this.prepareGrid(options);
    this.sampleInto(
      source,
      options,
      this.sampleCanvas,
      this.sampleContext,
      this.samples,
      this.colors
    );
    if (secondary?.ready && options.sourceMix > 0) {
      this.sampleInto(
        secondary,
        options,
        this.secondaryCanvas,
        this.secondaryContext,
        this.secondarySamples,
        this.secondaryColors
      );
      this.blendSources(options.sourceMix);
    }
    if (mask?.ready) {
      this.maskActive = true;
      this.sampleInto(
        mask,
        options,
        this.maskCanvas,
        this.maskContext,
        this.maskSamples,
        this.maskColors,
        {
          fit: options.maskFit,
          positionX: options.maskPositionX,
          positionY: options.maskPositionY,
          scale: options.maskScale
        }
      );
    } else {
      this.maskActive = false;
    }
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
    this.clear(options);
    if (options.mode === 'raw-dither') {
      this.drawRaw(options);
    } else {
      this.prepareToneLookup(options.toneMap);
      this.preparePalette(options.palette);
      this.drawCells(options, time, pointer);
    }
    return {
      fps: 0,
      cells: this.columns * this.rows,
      width: this.canvas.width,
      height: this.canvas.height,
      renderer: 'canvas',
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
    this.samples = new Float32Array(size);
    this.dithered = new Float32Array(size);
    this.colors = new Uint8ClampedArray(size * 4);
    this.secondarySamples = new Float32Array(size);
    this.secondaryColors = new Uint8ClampedArray(size * 4);
    this.maskSamples = new Float32Array(size);
    this.maskSamples.fill(1);
    this.maskColors = new Uint8ClampedArray(size * 4);
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

  private sampleInto(
    source: SourceFrame,
    options: AgencyDitherOptions,
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    samples: Float32Array,
    colors: Uint8ClampedArray,
    placement?: {
      fit: AgencyDitherOptions['fit'];
      positionX: number;
      positionY: number;
      scale: number;
    }
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
    colors.set(image.data);

    for (let index = 0; index < samples.length; index += 1) {
      const offset = index * 4;
      let value = luminance(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0
      );
      if (!isMask) {
        value = Math.pow(
          clamp((value - 0.5) * options.contrast + 0.5 + options.brightness),
          options.gamma
        );
        value = options.invert ? 1 - value : value;
      }
      samples[index] = value;
    }
  }

  private blendSources(mix: number): void {
    const amount = clamp(mix);
    for (let index = 0; index < this.samples.length; index += 1) {
      this.samples[index] =
        (this.samples[index] ?? 0) * (1 - amount) +
        (this.secondarySamples[index] ?? 0) * amount;
    }
    for (let index = 0; index < this.colors.length; index += 1) {
      this.colors[index] = Math.round(
        (this.colors[index] ?? 0) * (1 - amount) +
        (this.secondaryColors[index] ?? 0) * amount
      );
    }
  }

  private applyMask(options: AgencyDitherOptions): void {
    const threshold = clamp(options.maskThreshold);
    const feather = Math.max(0.001, options.maskFeather);
    for (let index = 0; index < this.dithered.length; index += 1) {
      let value = clamp(this.maskSamples[index] ?? 1);
      if (options.maskInvert) value = 1 - value;
      const alpha = threshold <= 0
        ? value
        : clamp((value - threshold) / feather);
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
    pointer: PointerState
  ): void {
    const cellWidth = this.cssWidth / this.columns;
    const cellHeight = this.cssHeight / this.rows;
    const reveal = clamp(options.revealProgress);
    if (options.glyphRamp !== this.glyphRampSource) {
      this.glyphRampSource = options.glyphRamp;
      this.glyphRamp = Array.from(options.glyphRamp || ' ');
    }
    const ramp = this.glyphRamp;
    this.context.textAlign = 'center';
    this.context.textBaseline = 'middle';
    this.context.font = `${options.fontWeight} ${Math.max(2, cellHeight * 0.98)}px ${options.fontFamily}`;

    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.columns; x += 1) {
        const index = y * this.columns + x;
        const sourceValue = clamp(this.samples[index] ?? 0);
        const value = clamp(this.dithered[index] ?? 0);
        const maskValue = this.maskActive
          ? clamp(this.maskSamples[index] ?? 1)
          : 1;
        if (maskValue <= 0) continue;
        const band = this.findToneBand(sourceValue);
        const revealAmount = this.cellReveal(
          x,
          y,
          index,
          clamp(reveal - (band?.revealOffset ?? 0)),
          options.stagger,
          options.staggerAmount,
          options.staggerFrom
        );
        if (revealAmount <= 0) continue;
        const primitive = band?.primitive ?? this.modePrimitive(options.mode, sourceValue, options.primitiveMix);
        if (primitive === 'none') continue;
        if (
          options.foregroundTransparent &&
          options.colorMode === 'monochrome' &&
          !band?.color
        ) {
          continue;
        }

        let px = (x + 0.5) * cellWidth;
        let py = (y + 0.5) * cellHeight;
        let ambientScale = 1;
        px += (band?.offsetX ?? 0) * cellWidth;
        py += (band?.offsetY ?? 0) * cellHeight;
        if ((band?.motionAmount ?? 0) > 0) {
          const phase =
            time * 0.001 * (band?.motionSpeed ?? 1) +
            x * 0.19 +
            y * 0.11;
          px += Math.cos(phase) * (band?.motionAmount ?? 0) * cellWidth;
          py += Math.sin(phase * 0.83) * (band?.motionAmount ?? 0) * cellHeight;
        }
        if (options.ambientEnabled && options.ambientAmount > 0) {
          const elapsed = time * 0.001 * options.ambientSpeed;
          const spatial =
            (x + y * 0.73) * Math.max(0.001, options.ambientFrequency);
          const amount = options.ambientAmount;
          if (options.ambientMode === 'wave') {
            py += Math.sin(elapsed * 2 + x * options.ambientFrequency) *
              amount *
              cellHeight;
          } else if (options.ambientMode === 'orbit') {
            const angle = elapsed + spatial;
            px += Math.cos(angle) * amount * cellWidth;
            py += Math.sin(angle) * amount * cellHeight;
          } else if (options.ambientMode === 'pulse') {
            ambientScale =
              1 + Math.sin(elapsed * 2 + spatial) * amount * 0.35;
          } else if (options.ambientMode === 'jitter') {
            const step = Math.floor(elapsed * 10);
            const hashX = Math.imul(index + step * 101, 2654435761);
            const hashY = Math.imul(index + step * 211, 1597334677);
            px += ((((hashX ^ (hashX >>> 16)) >>> 0) / 4294967295) - 0.5) *
              amount *
              cellWidth;
            py += ((((hashY ^ (hashY >>> 16)) >>> 0) / 4294967295) - 0.5) *
              amount *
              cellHeight;
          } else {
            px += Math.cos(elapsed + spatial) * amount * cellWidth;
            py += Math.sin(elapsed * 0.83 + spatial) * amount * cellHeight;
          }
        }
        if (pointer.active && options.mouseInfluence > 0) {
          const distance = Math.hypot(px - pointer.x, py - pointer.y);
          if (distance < 140) {
            const force =
              (1 - distance / 140) * options.mouseInfluence * cellWidth;
            const angle = Math.atan2(py - pointer.y, px - pointer.x);
            px += Math.cos(angle) * force;
            py += Math.sin(angle) * force;
          }
        }
        if (pointer.rippleStarted > 0 && options.rippleStrength > 0) {
          const age = (time - pointer.rippleStarted) / 1000;
          const radius = age * 240;
          const rippleDistance = Math.hypot(px - pointer.rippleX, py - pointer.rippleY);
          const wave = Math.exp(-Math.abs(rippleDistance - radius) / 30) * Math.sin(rippleDistance * 0.12 - age * 16);
          py += wave * options.rippleStrength * cellHeight;
        }

        const color = band?.color ?? this.cellColor(index, value, options);
        const scale =
          (band?.scale ?? 1) *
          (0.15 + value * 0.85) *
          (0.35 + revealAmount * 0.65) *
          ambientScale;
        this.context.globalAlpha = revealAmount * maskValue;
        this.context.fillStyle = color;
        this.context.strokeStyle = color;
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
          time
        );
        this.context.globalAlpha = 1;
      }
    }
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
    time: number
  ): void {
    const size = Math.min(width, height);
    if (primitive === 'dot') {
      this.context.beginPath();
      this.context.arc(x, y, size * 0.5 * scale * options.dotScale, 0, Math.PI * 2);
      this.context.fill();
      return;
    }
    if (primitive === 'block') {
      this.context.save();
      this.context.translate(x, y);
      this.context.rotate((options.rotation + (band?.rotation ?? 0)) * Math.PI / 180);
      this.context.fillRect(-width * scale * 0.5, -height * scale * 0.5, width * scale, height * scale);
      this.context.restore();
      return;
    }
    if (primitive === 'line') {
      this.context.lineWidth = Math.max(1, size * 0.12 * scale);
      this.context.beginPath();
      this.context.moveTo(x - width * 0.4, y + height * 0.4);
      this.context.lineTo(x + width * 0.4, y - height * 0.4);
      this.context.stroke();
      return;
    }
    if (primitive === 'symbol') {
      const symbolName = band?.symbol ?? this.firstSymbol;
      const symbol = band?.color
        ? this.getTintedSymbol(symbolName, band.color)
        : this.symbols.get(symbolName);
      if (symbol) {
        const symbolScale = scale * options.symbolScale;
        this.context.drawImage(
          symbol,
          x - width * symbolScale * 0.5,
          y - height * symbolScale * 0.5,
          width * symbolScale,
          height * symbolScale
        );
      }
      return;
    }
    const scramble = options.glyphScramble > 0 &&
      ((index * 16807 + Math.floor(time / 70)) % 100) / 100 < options.glyphScramble;
    const glyphIndex = scramble
      ? (index + Math.floor(time / 80)) % ramp.length
      : Math.round(value * (ramp.length - 1));
    this.context.fillText(band?.glyph ?? ramp[glyphIndex] ?? ' ', x, y);
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
      const r = (this.colors[offset] ?? 0) >> 4;
      const g = (this.colors[offset + 1] ?? 0) >> 4;
      const b = (this.colors[offset + 2] ?? 0) >> 4;
      const key = (r << 8) | (g << 4) | b;
      const cached = this.sourceColorCache.get(key);
      if (cached) return cached;
      const color = `rgb(${r * 17} ${g * 17} ${b * 17})`;
      this.sourceColorCache.set(key, color);
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
      const r = this.colors[offset] ?? value * 255;
      const g = this.colors[offset + 1] ?? value * 255;
      const b = this.colors[offset + 2] ?? value * 255;
      let nearest = options.foreground;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const [color, pr, pg, pb] of this.paletteRgb) {
        const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (distance < nearestDistance) {
          nearest = color;
          nearestDistance = distance;
        }
      }
      return nearest;
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
  }
}
