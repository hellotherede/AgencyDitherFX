import type { AgencyDitherOptions, RenderStats, SourceFrame } from '../core/types';

export interface RendererPointerState {
  x: number;
  y: number;
  active: boolean;
  rippleX: number;
  rippleY: number;
  rippleStarted: number;
}

export interface DitherRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly kind: AgencyDitherOptions['renderer'];
  resize(width: number, height: number, options: AgencyDitherOptions): void;
  setSymbol(name: string, image: CanvasImageSource): void;
  removeSymbol(name: string): void;
  destroy(): void;
  render(
    source: SourceFrame,
    options: AgencyDitherOptions,
    time: number,
    pointer: RendererPointerState,
    secondary?: SourceFrame | null,
    mask?: SourceFrame | null
  ): RenderStats;
}
