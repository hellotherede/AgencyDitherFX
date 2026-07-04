export { AgencyDitherFX } from './core/AgencyDitherFX';
export { DEFAULT_OPTIONS, REALTIME_ALGORITHMS } from './core/defaults';
export { presets } from './ui/presets';
export { defaultSymbols } from './primitives/defaultSymbols';
export type { DefaultSymbolName } from './primitives/defaultSymbols';
export { isErrorDiffusion } from './algorithms/dither';
export type {
  AgencyDitherOptions,
  AmbientMode,
  AnimationOptions,
  ColorMode,
  DitherAlgorithm,
  GsapLike,
  InteractionOptions,
  Primitive,
  RendererKind,
  RenderMode,
  RenderStats,
  SourceInput,
  StaggerFrom,
  ToneBand
} from './core/types';

import { AgencyDitherFX } from './core/AgencyDitherFX';
import { presets } from './ui/presets';
import type { AgencyDitherOptions } from './core/types';

export function initAgencyDitherFX(
  root: ParentNode = document
): AgencyDitherFX[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-agency-dither]')).map(
    element => {
      const presetName = element.dataset.preset ?? '';
      const preset = presets[presetName] ?? {};
      let embedded: Partial<AgencyDitherOptions> = {};
      const config = element.querySelector<HTMLScriptElement>('[data-agency-dither-config]');
      if (config?.textContent) {
        try {
          embedded = JSON.parse(config.textContent) as Partial<AgencyDitherOptions>;
        } catch {
          console.warn('AgencyDitherFX ignored invalid embedded JSON config.');
        }
      }
      return new AgencyDitherFX(element, {
        ...preset,
        ...embedded,
        source: element.dataset.source ?? embedded.source
      });
    }
  );
}
