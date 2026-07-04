import type { GsapLike } from '../core/types';

let gsapInstance: GsapLike | null = null;

export function useGsap(gsap: GsapLike): void {
  gsapInstance = gsap;
}

export function getGsap(): GsapLike {
  const candidate = gsapInstance ?? (globalThis as typeof globalThis & { gsap?: GsapLike }).gsap;
  if (!candidate) {
    throw new Error(
      'GSAP is optional. Call AgencyDitherFX.useGSAP(gsap) before using animation helpers.'
    );
  }
  return candidate;
}
