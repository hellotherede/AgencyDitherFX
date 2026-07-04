import type { AgencyDitherOptions } from '../core/types';

export type Preset = Partial<AgencyDitherOptions> & { name?: string };

export const presets: Record<string, Preset> = {
  'editorial-bayer': {
    name: 'Editorial Bayer',
    mode: 'dots',
    algorithm: 'bayer8',
    cellSize: 8,
    foreground: '#171714',
    background: '#f0ede5',
    dotScale: 0.88,
    contrast: 1.18,
    ditherAmount: 0.75
  },
  'anton-like-symbol-dither': {
    name: 'Symbol Field',
    mode: 'hybrid',
    algorithm: 'bayer4',
    cellSize: 12,
    palette: ['#171714', '#e94f2e', '#f4be36'],
    colorMode: 'palette',
    primitiveMix: 0.62
  },
  'brutalist-blocks': {
    name: 'Brutalist Blocks',
    mode: 'blocks',
    algorithm: 'threshold',
    cellSize: 11,
    threshold: 0.46,
    foreground: '#0c0c0b',
    background: '#d8ff36',
    rotation: 0
  },
  'soft-blue-noise': {
    name: 'Soft Blue Noise',
    mode: 'dots',
    algorithm: 'blue-noise',
    cellSize: 7,
    ditherAmount: 0.45,
    dotScale: 0.72,
    foreground: '#2a403b',
    background: '#e9e3d7'
  },
  'ascii-terminal': {
    name: 'ASCII Terminal',
    mode: 'ascii',
    algorithm: 'bayer4',
    cellSize: 9,
    glyphRamp: ' .:-=+*#%@',
    foreground: '#b4ff68',
    background: '#07110a',
    fontFamily: '"DM Mono", monospace',
    contrast: 1.3
  },
  'old-ascii-renderer': {
    name: 'Classic Dense ASCII',
    mode: 'ascii',
    algorithm: 'bayer4',
    cellSize: 8,
    glyphRamp: '.,-~:;=!*#$@',
    foreground: '#171714',
    background: '#f0ede5',
    colorMode: 'monochrome',
    contrast: 1.12,
    gamma: 0.9,
    ditherAmount: 0.32,
    threshold: 0.5,
    stagger: true,
    staggerAmount: 0.72,
    staggerFrom: 'start',
    animationDuration: 1.25
  },
  'ascii-fashion-editorial': {
    name: 'ASCII Fashion Editorial',
    mode: 'ascii',
    algorithm: 'blue-noise',
    cellSize: 7,
    glyphRamp: ' ·:;+=xX#',
    foreground: '#1b1815',
    background: '#e9dfcf',
    contrast: 1.12,
    gamma: 0.82
  },
  'halftone-print': {
    name: 'Halftone Print',
    mode: 'halftone',
    algorithm: 'halftone',
    cellSize: 8,
    dotScale: 1.1,
    foreground: '#1e2858',
    background: '#f3e7ca'
  },
  'poster-grid': {
    name: 'Poster Grid',
    mode: 'blocks',
    algorithm: 'bayer2',
    cellSize: 14,
    colorMode: 'palette',
    palette: ['#151515', '#ef4e31', '#f1bc32', '#eee9df'],
    rotation: 45
  },
  'image-to-stars': {
    name: 'Image to Stars',
    mode: 'symbols',
    algorithm: 'bayer8',
    cellSize: 13,
    symbolScale: 0.9,
    background: '#111827',
    foreground: '#f9d96f'
  },
  'kinetic-type-mask': {
    name: 'Kinetic Type Mask',
    mode: 'ascii',
    algorithm: 'random',
    cellSize: 10,
    glyphRamp: ' TYPE',
    glyphScramble: 0.18,
    animation: { autoplay: true, fps: 24, noiseSpeed: 0.5, glyphScramble: 0.18 }
  },
  'signal-bloom': {
    name: 'Signal Bloom',
    mode: 'symbols',
    algorithm: 'blue-noise',
    cellSize: 12,
    background: '#10100f',
    foreground: '#f1eee7',
    colorMode: 'monochrome',
    ditherAmount: 0.58,
    contrast: 1.25,
    gamma: 0.82,
    ambientEnabled: true,
    ambientMode: 'wave',
    ambientAmount: 0.12,
    ambientSpeed: 0.45,
    ambientFrequency: 0.32,
    toneMap: [
      {
        min: 0,
        max: 0.24,
        primitive: 'symbol',
        symbol: 'square',
        color: '#10100f',
        scale: 1.15,
        motionAmount: 0.08,
        motionSpeed: 0.55
      },
      {
        min: 0.24,
        max: 0.5,
        primitive: 'symbol',
        symbol: 'cross',
        color: '#ff3d18',
        scale: 0.82,
        rotation: 45,
        motionAmount: 0.22,
        motionSpeed: 0.8
      },
      {
        min: 0.5,
        max: 0.76,
        primitive: 'symbol',
        symbol: 'star',
        color: '#ffd238',
        scale: 0.72,
        motionAmount: 0.38,
        motionSpeed: 1.05
      },
      {
        min: 0.76,
        max: 1,
        primitive: 'symbol',
        symbol: 'ring',
        color: '#f1eee7',
        scale: 0.5,
        motionAmount: 0.55,
        motionSpeed: 1.25
      }
    ]
  },
  'runway-ghost': {
    name: 'Runway Ghost',
    mode: 'ascii',
    algorithm: 'bayer8',
    cellSize: 7,
    glyphRamp: '·.:+xX#',
    foreground: '#f3eee3',
    background: '#141310',
    contrast: 1.42,
    gamma: 0.72,
    ditherAmount: 0.5,
    stagger: true,
    staggerAmount: 0.84,
    staggerFrom: 'edges',
    animationDuration: 1.8,
    glyphScramble: 0.04,
    ambientEnabled: true,
    ambientMode: 'pulse',
    ambientAmount: 0.09,
    ambientSpeed: 0.32,
    ambientFrequency: 0.12
  },
  'acid-registration': {
    name: 'Acid Registration',
    mode: 'hybrid',
    algorithm: 'bayer4',
    cellSize: 10,
    background: '#d9ff43',
    foreground: '#12120f',
    colorMode: 'brightness',
    palette: ['#12120f', '#ff3b18', '#1647ff', '#f4efe5'],
    contrast: 1.35,
    gamma: 0.9,
    rotation: 45,
    primitiveMix: 0.58,
    dotScale: 1.15,
    ambientEnabled: true,
    ambientMode: 'jitter',
    ambientAmount: 0.08,
    ambientSpeed: 0.5,
    ambientFrequency: 0.2
  },
  'transparent-signal-overlay': {
    name: 'Transparent Signal Overlay',
    mode: 'symbols',
    algorithm: 'bayer8',
    cellSize: 14,
    backgroundTransparent: true,
    foreground: '#ff4d24',
    colorMode: 'monochrome',
    contrast: 1.3,
    ditherAmount: 0.62,
    toneMap: [
      {
        min: 0,
        max: 0.42,
        primitive: 'none'
      },
      {
        min: 0.42,
        max: 0.7,
        primitive: 'symbol',
        symbol: 'slash',
        color: '#ff4d24',
        scale: 0.75,
        rotation: -20
      },
      {
        min: 0.7,
        max: 1,
        primitive: 'symbol',
        symbol: 'ring',
        color: '#f5c842',
        scale: 0.58,
        motionAmount: 0.16,
        motionSpeed: 0.65
      }
    ]
  },
  'midnight-constellation': {
    name: 'Midnight Constellation',
    mode: 'symbols',
    algorithm: 'blue-noise',
    cellSize: 11,
    background: '#07101d',
    foreground: '#d8e6ff',
    contrast: 1.18,
    brightness: -0.08,
    gamma: 0.78,
    ditherAmount: 0.68,
    toneMap: [
      {
        min: 0,
        max: 0.36,
        primitive: 'none'
      },
      {
        min: 0.36,
        max: 0.62,
        primitive: 'dot',
        color: '#4977ff',
        scale: 0.28
      },
      {
        min: 0.62,
        max: 0.84,
        primitive: 'symbol',
        symbol: 'star',
        color: '#b8d1ff',
        scale: 0.5,
        motionAmount: 0.12,
        motionSpeed: 0.45
      },
      {
        min: 0.84,
        max: 1,
        primitive: 'symbol',
        symbol: 'ring',
        color: '#fff1b8',
        scale: 0.66,
        motionAmount: 0.2,
        motionSpeed: 0.7
      }
    ]
  },
  'newsprint-scream': {
    name: 'Newsprint Scream',
    mode: 'halftone',
    algorithm: 'halftone',
    cellSize: 7,
    background: '#ece5d5',
    foreground: '#171714',
    threshold: 0.46,
    ditherAmount: 0.9,
    contrast: 1.65,
    brightness: -0.04,
    gamma: 0.72,
    dotScale: 1.32,
    rotation: 15
  },
  'monument-grid': {
    name: 'Monument Grid',
    mode: 'symbols',
    algorithm: 'threshold',
    cellSize: 16,
    background: '#e8e3d7',
    foreground: '#171714',
    threshold: 0.52,
    contrast: 1.5,
    ditherAmount: 0.78,
    toneMap: [
      {
        min: 0,
        max: 0.32,
        primitive: 'symbol',
        symbol: 'square',
        color: '#171714',
        scale: 1.18
      },
      {
        min: 0.32,
        max: 0.56,
        primitive: 'symbol',
        symbol: 'diamond',
        color: '#e74b2a',
        scale: 0.92,
        rotation: 45
      },
      {
        min: 0.56,
        max: 0.78,
        primitive: 'symbol',
        symbol: 'circle',
        color: '#1850b8',
        scale: 0.68
      },
      {
        min: 0.78,
        max: 1,
        primitive: 'symbol',
        symbol: 'ring',
        color: '#dfaa2c',
        scale: 0.48
      }
    ]
  }
};
