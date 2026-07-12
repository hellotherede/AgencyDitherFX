export type RenderMode =
  | 'dots'
  | 'blocks'
  | 'halftone'
  | 'ascii'
  | 'symbols'
  | 'hybrid'
  | 'raw-dither';

export type DitherAlgorithm =
  | 'threshold'
  | 'bayer2'
  | 'bayer4'
  | 'bayer8'
  | 'bayer16'
  | 'blue-noise'
  | 'random'
  | 'halftone'
  | 'floyd-steinberg'
  | 'atkinson'
  | 'stucki'
  | 'jarvis';

export type ColorMode = 'monochrome' | 'source' | 'palette' | 'brightness';
export type SourceFit = 'cover' | 'contain' | 'fill' | 'none' | 'stretch';
export type Primitive = 'dot' | 'block' | 'glyph' | 'symbol' | 'line' | 'none';
export type RendererKind = 'canvas' | 'webgl' | 'svg';
export type StaggerFrom =
  | 'start'
  | 'center'
  | 'end'
  | 'edges'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'random';
export type AmbientMode = 'drift' | 'wave' | 'orbit' | 'pulse' | 'jitter';

export interface ToneBand {
  min: number;
  max: number;
  primitive: Primitive;
  symbol?: string;
  glyph?: string;
  color?: string;
  scale?: number;
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  motionAmount?: number;
  motionSpeed?: number;
  revealOffset?: number;
}

export interface AnimationOptions {
  autoplay: boolean;
  fps: number;
  noiseSpeed: number;
  glyphScramble: number;
}

export interface InteractionOptions {
  pointer: boolean;
  clickRipple: boolean;
}

export interface AgencyDitherOptions {
  source?: SourceInput;
  mode: RenderMode;
  renderer: RendererKind;
  algorithm: DitherAlgorithm;
  fit: SourceFit;
  cellSize: number;
  responsive: boolean;
  responsiveMinCellSize: number;
  responsiveMaxCellSize: number;
  responsiveReferenceWidth: number;
  resolutionScale: number;
  maxDpr: number;
  maxCells: number;
  maxFps: number;
  background: string;
  foreground: string;
  transparent: boolean;
  backgroundTransparent: boolean;
  foregroundTransparent: boolean;
  threshold: number;
  ditherAmount: number;
  contrast: number;
  brightness: number;
  gamma: number;
  invert: boolean;
  blur: number;
  dotScale: number;
  symbolScale: number;
  rotation: number;
  noiseAmount: number;
  noiseSpeed: number;
  displacement: number;
  rippleStrength: number;
  mouseInfluence: number;
  paletteMix: number;
  glyphScramble: number;
  revealProgress: number;
  animationDuration: number;
  ambientEnabled: boolean;
  ambientMode: AmbientMode;
  ambientAmount: number;
  ambientSpeed: number;
  ambientFrequency: number;
  stagger: boolean;
  staggerAmount: number;
  staggerFrom: StaggerFrom;
  maskProgress: number;
  primitiveMix: number;
  sourceMix: number;
  maskInvert: boolean;
  maskThreshold: number;
  maskFeather: number;
  maskFit: SourceFit;
  maskPositionX: number;
  maskPositionY: number;
  maskScale: number;
  glyphRamp: string;
  fontFamily: string;
  fontWeight: string | number;
  colorMode: ColorMode;
  palette: string[];
  toneMap: ToneBand[];
  animation: AnimationOptions;
  interaction: InteractionOptions;
  immediate: boolean;
  decorative: boolean;
  ariaLabel?: string;
  fallback?: string;
  worker: boolean;
}

export type SourceInput =
  | string
  | Blob
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | SVGElement
  | MediaStream;

export interface SourceFrame {
  drawable: CanvasImageSource;
  width: number;
  height: number;
  dynamic: boolean;
  ready: boolean;
}

export interface RenderStats {
  fps: number;
  cells: number;
  width: number;
  height: number;
  renderer: RendererKind;
  warning: string;
  sampleMs?: number;
  ditherMs?: number;
  drawMs?: number;
}

export interface GsapLike {
  to(target: object, vars: Record<string, unknown>): unknown;
  fromTo(
    target: object,
    fromVars: Record<string, unknown>,
    toVars: Record<string, unknown>
  ): unknown;
  timeline(vars?: Record<string, unknown>): unknown;
}
