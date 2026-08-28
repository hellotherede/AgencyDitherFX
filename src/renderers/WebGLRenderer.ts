import type {
  AgencyDitherOptions,
  DitherAlgorithm,
  RenderMode,
  RenderStats,
  SourceFrame
} from '../core/types';
import { hexToRgb } from '../utils/color';
import type { DitherRenderer, RendererPointerState } from './types';

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

#define PALETTE_LIMIT 16.0

uniform sampler2D u_source;
// Per-cell noise baked on the CPU with the same integer hash the Canvas
// renderer uses. GLSL ES 1.00 has no bitwise operators, so the hash cannot be
// reproduced in the shader; sampling it keeps both renderers in agreement.
// R = hash(x, y, frame) for value noise and the random algorithm.
// G = the averaged pair the blue-noise algorithm uses.
uniform sampler2D u_noise;
// Glyph ramp rendered once into a strip of tiles, one per ramp entry, at device
// resolution. Sampling it is what lets ASCII run on the GPU at all.
uniform sampler2D u_glyphAtlas;
uniform float u_glyphCount;
uniform vec2 u_glyphTile;
uniform bool u_glyphReady;
uniform float u_glyphScramble;
// Per-cell values that need the integer hash GLSL ES 1.00 cannot express, baked
// on the CPU. R and A carry a 16-bit random-glyph roll; G and B carry the
// jitter offsets, which change on their own ten-per-second clock.
uniform sampler2D u_cellData;
uniform bool u_glyphRandom;
uniform float u_glyphProbability;
// Up to PALETTE_LIMIT colours in a 1 x N strip. A texture rather than a uniform
// array because GLSL ES 1.00 does not guarantee dynamic indexing of arrays.
uniform sampler2D u_palette;
uniform float u_paletteCount;
uniform float u_paletteMix;
uniform bool u_foregroundTransparent;
// Luminance mask. White reveals, black hides; the Canvas renderer fills the
// mask sample canvas with black first, so anything outside the mask hides too.
uniform sampler2D u_mask;
uniform vec4 u_maskRect;
uniform bool u_maskActive;
uniform bool u_maskInvert;
uniform float u_maskThreshold;
uniform float u_maskFeather;
uniform float u_maskProgress;
// Second source, cross-faded with the first by sourceMix. Canvas tones each
// source separately and blends the results, so the shader does the same.
uniform sampler2D u_secondary;
uniform vec4 u_secondaryRect;
uniform float u_sourceMix;
uniform bool u_secondaryActive;
uniform vec2 u_cssSize;
uniform vec2 u_gridSize;
uniform vec4 u_drawRect;
uniform vec2 u_cellSize;
uniform vec2 u_pixel;
uniform float u_threshold;
uniform float u_ditherAmount;
uniform float u_contrast;
uniform float u_brightness;
uniform float u_gamma;
uniform float u_noiseAmount;
uniform float u_dotScale;
uniform float u_primitiveMix;
uniform float u_revealProgress;
uniform float u_staggerAmount;
uniform bool u_stagger;
uniform vec4 u_foreground;
uniform vec4 u_background;
uniform int u_mode;
uniform int u_algorithm;
uniform int u_colorMode;
uniform int u_staggerFrom;
uniform bool u_invert;
uniform bool u_backgroundTransparent;

// Motion. A primitive displaced by these can spill outside its own cell, so
// when any of them is active every fragment tests the 3x3 cell neighbourhood
// instead of only the cell it falls in.
uniform int u_neighborhood;
uniform float u_rotation;
uniform float u_displacement;
uniform float u_displacePhase;
uniform int u_ambientMode;
uniform float u_ambientAmount;
uniform float u_ambientFrequency;
uniform float u_ambientElapsed;
uniform vec3 u_mouse;
uniform vec4 u_ripple;

varying vec2 v_uv;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

float hash(vec2 value) {
  return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
}

float bayer2(vec2 cell) {
  vec2 p = mod(cell, 2.0);
  if (p.y < 1.0) return p.x < 1.0 ? 0.0 : 2.0;
  return p.x < 1.0 ? 3.0 : 1.0;
}

float bayerRank(vec2 cell, float size) {
  float rank = bayer2(cell);
  if (size >= 4.0) {
    rank = rank * 4.0 + bayer2(floor(cell / 2.0));
  }
  if (size >= 8.0) {
    rank = rank * 4.0 + bayer2(floor(cell / 4.0));
  }
  if (size >= 16.0) {
    rank = rank * 4.0 + bayer2(floor(cell / 8.0));
  }
  return rank / (size * size);
}

float localThreshold(vec2 cell, float base, vec2 noise) {
  float threshold = base;
  if (u_algorithm == 1) {
    threshold += (bayerRank(cell, 2.0) - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 2) {
    threshold += (bayerRank(cell, 4.0) - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 3) {
    threshold += (bayerRank(cell, 8.0) - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 4) {
    threshold += (bayerRank(cell, 16.0) - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 5) {
    threshold += (noise.y - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 6) {
    threshold += (noise.x - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 7) {
    vec2 p = mod(cell, 6.0) - 2.5;
    threshold += (length(p) / 3.54 - 0.5) * u_ditherAmount;
  }
  return threshold;
}

float revealForCell(vec2 cell) {
  float progress = clamp(u_revealProgress, 0.0, 1.0);
  if (progress >= 1.0) return progress;
  if (progress <= 0.0) return 0.0;

  if (!u_stagger) return progress;

  vec2 denom = max(u_gridSize - 1.0, vec2(1.0));
  vec2 n = cell / denom;
  float order = (cell.y * u_gridSize.x + cell.x) /
    max(1.0, u_gridSize.x * u_gridSize.y - 1.0);

  if (u_staggerFrom == 1) {
    order = min(1.0, distance(n, vec2(0.5)) / 0.70710678);
  } else if (u_staggerFrom == 2) {
    order = 1.0 - order;
  } else if (u_staggerFrom == 3) {
    order = 1.0 - min(1.0, distance(n, vec2(0.5)) / 0.70710678);
  } else if (u_staggerFrom == 4) {
    order = n.x;
  } else if (u_staggerFrom == 5) {
    order = 1.0 - n.x;
  } else if (u_staggerFrom == 6) {
    order = n.y;
  } else if (u_staggerFrom == 7) {
    order = 1.0 - n.y;
  } else if (u_staggerFrom == 8) {
    order = (n.x + n.y) * 0.5;
  } else if (u_staggerFrom == 9) {
    order = (1.0 - n.x + n.y) * 0.5;
  } else if (u_staggerFrom == 10) {
    order = (n.x + 1.0 - n.y) * 0.5;
  } else if (u_staggerFrom == 11) {
    order = (2.0 - n.x - n.y) * 0.5;
  } else if (u_staggerFrom == 12) {
    order = hash(cell + 1.0);
  }

  float spread = clamp(u_staggerAmount, 0.0, 1.0);
  float start = order * spread;
  float duration = max(0.001, 1.0 - spread);
  float local = clamp((progress - start) / duration, 0.0, 1.0);
  return 1.0 - pow(1.0 - local, 3.0);
}

float maskAlpha(vec2 cell) {
  if (!u_maskActive) return 1.0;
  vec2 uv = ((cell + 0.5) * u_cellSize - u_maskRect.xy) / u_maskRect.zw;
  float value = 0.0;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    value = clamp(luminance(texture2D(u_mask, uv).rgb), 0.0, 1.0);
  }
  if (u_maskInvert) value = 1.0 - value;
  float alpha = u_maskThreshold <= 0.0
    ? value
    : clamp((value - u_maskThreshold) / u_maskFeather, 0.0, 1.0);
  return alpha * clamp(u_maskProgress, 0.0, 1.0);
}

// Tone, noise and dither for one cell. Returns false when the cell samples
// outside the drawn source rectangle.
// Colour a cell samples from one source. Outside the drawn rectangle the Canvas
// renderer sees the background it filled its sample canvas with.
vec3 sampleAt(sampler2D image, vec4 rect, vec2 center) {
  vec2 uv = (center - rect.xy) / rect.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return u_background.rgb;
  return texture2D(image, uv).rgb;
}

float toneOf(vec3 rgb, float noise) {
  float value = luminance(rgb);
  value = pow(clamp((value - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0), u_gamma);
  // Canvas inverts before adding noise, so the noise is not mirrored with it.
  if (u_invert) value = 1.0 - value;
  return clamp(value + (noise - 0.5) * u_noiseAmount, 0.0, 1.0);
}

bool cellValue(
  vec2 cell, out float dithered, out float toned, out vec3 rgb, out float mask,
  out vec2 scramble
) {
  vec2 center = (cell + 0.5) * u_cellSize;
  vec4 cellNoise = texture2D(u_noise, (cell + 0.5) / u_gridSize);
  vec2 noise = cellNoise.rg;
  scramble = cellNoise.ba;
  rgb = sampleAt(u_source, u_drawRect, center);
  float value = toneOf(rgb, noise.x);
  if (u_secondaryActive) {
    vec3 other = sampleAt(u_secondary, u_secondaryRect, center);
    value = mix(value, toneOf(other, noise.x), u_sourceMix);
    rgb = mix(rgb, other, u_sourceMix);
  }
  float binary = value >= localThreshold(cell, u_threshold, noise) ? 1.0 : 0.0;
  // Canvas applies the mask to the dithered value only; the sampled tone that
  // drives displacement and hybrid selection stays untouched.
  mask = maskAlpha(cell);
  dithered = mix(value, binary, u_ditherAmount) * mask;
  toned = value;
  return true;
}

// Where a cell's primitive is actually drawn, mirroring the Canvas renderer's
// per-cell motion maths.
vec2 cellPosition(vec2 cell, float toned, out float ambientScale) {
  vec2 pos = (cell + 0.5) * u_cellSize;
  ambientScale = 1.0;

  if (u_ambientAmount > 0.0) {
    float spatial = (cell.x + cell.y * 0.73) * u_ambientFrequency;
    if (u_ambientMode == 1) {
      pos.y += sin(u_ambientElapsed * 2.0 + cell.x * u_ambientFrequency) *
        u_ambientAmount * u_cellSize.y;
    } else if (u_ambientMode == 2) {
      float angle = u_ambientElapsed + spatial;
      pos += vec2(cos(angle), sin(angle)) * u_ambientAmount * u_cellSize;
    } else if (u_ambientMode == 3) {
      ambientScale = 1.0 + sin(u_ambientElapsed * 2.0 + spatial) * u_ambientAmount * 0.35;
    } else if (u_ambientMode == 4) {
      vec4 data = texture2D(u_cellData, (cell + 0.5) / u_gridSize);
      pos += (data.gb - 0.5) * u_ambientAmount * u_cellSize;
    } else {
      pos.x += cos(u_ambientElapsed + spatial) * u_ambientAmount * u_cellSize.x;
      pos.y += sin(u_ambientElapsed * 0.83 + spatial) * u_ambientAmount * u_cellSize.y;
    }
  }

  if (u_displacement > 0.0) {
    float phase = toned * 6.2831853 + u_displacePhase;
    pos.x += cos(phase + cell.x * 0.17) * u_displacement * u_cellSize.x;
    pos.y += sin(phase + cell.y * 0.13) * u_displacement * u_cellSize.y;
  }

  if (u_mouse.z > 0.0) {
    float d = distance(pos, u_mouse.xy);
    if (d < 140.0) {
      float force = (1.0 - d / 140.0) * u_mouse.z * u_cellSize.x;
      float angle = atan(pos.y - u_mouse.y, pos.x - u_mouse.x);
      pos += vec2(cos(angle), sin(angle)) * force;
    }
  }

  if (u_ripple.z > 0.0) {
    float age = u_ripple.w;
    float d = distance(pos, u_ripple.xy);
    float wave = exp(-abs(d - age * 240.0) / 30.0) * sin(d * 0.12 - age * 16.0);
    pos.y += wave * u_ripple.z * u_cellSize.y;
  }

  return pos;
}

// Antialiased coverage of this fragment by the primitive belonging to a cell.
float primitiveCoverage(
  vec2 cell, vec2 css, out vec3 rgb, out float outReveal, out float outToned
) {
  outReveal = 0.0;
  outToned = 0.0;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= u_gridSize.x || cell.y >= u_gridSize.y) {
    return 0.0;
  }
  float dithered;
  float toned;
  float mask;
  vec2 scramble;
  if (!cellValue(cell, dithered, toned, rgb, mask, scramble)) return 0.0;
  if (mask <= 0.0) return 0.0;
  float reveal = revealForCell(cell) * mask;
  if (reveal <= 0.0) return 0.0;

  outToned = toned;
  float ambientScale;
  vec2 pos = cellPosition(cell, toned, ambientScale);
  float scale = (0.15 + dithered * 0.85) * (0.35 + reveal * 0.65) * ambientScale;
  vec2 delta = css - pos;
  outReveal = reveal;

  // Hybrid resolves to one of the other primitives per cell, keyed on tone.
  int mode = u_mode;
  if (mode == 5) {
    mode = toned < u_primitiveMix * 0.5 ? 2 : (toned < 0.75 ? 1 : 4);
  }

  if (mode == 1 || mode == 3) {
    float radius = min(u_cellSize.x, u_cellSize.y) * 0.5 * scale * u_dotScale;
    float edge = max(u_pixel.x, u_pixel.y) * 0.5;
    return 1.0 - smoothstep(radius - edge, radius + edge, length(delta));
  }

  if (mode == 4) {
    if (!u_glyphReady) return 0.0;
    // Glyphs are drawn at a fixed size; the Canvas renderer does not scale them
    // by tone, it only picks a different character.
    vec2 uv = delta / u_glyphTile + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    float index = floor(dithered * (u_glyphCount - 1.0) + 0.5);
    if (u_glyphRandom) {
      vec4 data = texture2D(u_cellData, (cell + 0.5) / u_gridSize);
      float roll = (data.r * 255.0 * 256.0 + data.a * 255.0) / 65535.0;
      index = u_glyphCount == 2.0
        ? (roll < u_glyphProbability ? 1.0 : 0.0)
        : min(u_glyphCount - 1.0, floor(roll * u_glyphCount));
    }
    if (u_glyphScramble > 0.0) {
      // The roll is stored as the raw 0..99 integer the Canvas renderer tests.
      float roll = floor(scramble.x * 255.0 + 0.5) / 100.0;
      if (roll < u_glyphScramble) index = floor(scramble.y * 255.0 + 0.5);
    }
    return texture2D(u_glyphAtlas, vec2((index + uv.x) / u_glyphCount, uv.y)).a;
  }

  if (u_rotation != 0.0) {
    float c = cos(-u_rotation);
    float s = sin(-u_rotation);
    delta = vec2(delta.x * c - delta.y * s, delta.x * s + delta.y * c);
  }
  vec2 halfSize = u_cellSize * 0.5 * scale;
  vec2 edge = u_pixel * 0.5;
  vec2 fade = vec2(1.0) - smoothstep(halfSize - edge, halfSize + edge, abs(delta));
  return fade.x * fade.y;
}

// Per-cell ink, matching CanvasRenderer.cellColor.
vec4 inkColor(vec3 rgb, float toned) {
  if (u_colorMode == 1) {
    // Canvas quantises the sampled colour to 12 bits before using it.
    return vec4(floor(rgb * 255.0 / 16.0) * 17.0 / 255.0, u_foreground.a);
  }
  if (u_colorMode == 3) {
    float index = min(u_paletteCount - 1.0, floor(toned * u_paletteCount));
    vec3 entry = texture2D(u_palette, vec2((index + 0.5) / PALETTE_LIMIT, 0.5)).rgb;
    return vec4(entry, u_foreground.a);
  }
  if (u_colorMode == 2) {
    vec3 nearest = u_foreground.rgb;
    float best = 1.0e9;
    for (int i = 0; i < int(PALETTE_LIMIT); i++) {
      if (float(i) >= u_paletteCount) break;
      vec3 entry = texture2D(u_palette, vec2((float(i) + 0.5) / PALETTE_LIMIT, 0.5)).rgb;
      vec3 d = (rgb - entry) * 255.0;
      float distance = dot(d, d);
      if (distance < best) {
        best = distance;
        nearest = entry;
      }
    }
    return vec4(mix(rgb, nearest, u_paletteMix), u_foreground.a);
  }
  return u_foreground;
}

void main() {
  vec2 css = vec2(v_uv.x, 1.0 - v_uv.y) * u_cssSize;
  vec2 cell = floor(css / max(vec2(1.0), u_cellSize));
  vec4 background = u_backgroundTransparent ? vec4(u_background.rgb, 0.0) : u_background;

  if (u_mode == 0) {
    float dithered;
    float toned;
    float mask;
    vec3 rgb;
    vec2 scramble;
    if (!cellValue(cell, dithered, toned, rgb, mask, scramble)) {
      gl_FragColor = background;
      return;
    }
    float reveal = revealForCell(cell);
    gl_FragColor = reveal <= 0.0 ? background : vec4(vec3(dithered), reveal);
    return;
  }

  float bestCoverage = 0.0;
  float bestReveal = 0.0;
  float bestToned = 0.0;
  vec3 bestRgb = vec3(0.0);

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      // Without motion a primitive never leaves its own cell, so the eight
      // neighbours cannot contribute and are skipped entirely.
      if (u_neighborhood == 0 && (dx != 0 || dy != 0)) continue;
      vec3 rgb;
      float reveal;
      float toned;
      float coverage = primitiveCoverage(
        cell + vec2(float(dx), float(dy)), css, rgb, reveal, toned
      );
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        bestReveal = reveal;
        bestToned = toned;
        bestRgb = rgb;
      }
    }
  }

  if (bestCoverage <= 0.0 || (u_foregroundTransparent && u_colorMode == 0)) {
    gl_FragColor = background;
    return;
  }

  vec4 ink = inkColor(bestRgb, bestToned);
  // Source-over of the ink onto the background, matching the Canvas renderer
  // filling the background first and then drawing at globalAlpha = reveal.
  float srcAlpha = bestCoverage * bestReveal * ink.a;
  float outAlpha = srcAlpha + background.a * (1.0 - srcAlpha);
  vec3 outColor = outAlpha > 0.0
    ? (ink.rgb * srcAlpha + background.rgb * background.a * (1.0 - srcAlpha)) / outAlpha
    : background.rgb;
  gl_FragColor = vec4(outColor, outAlpha);
}
`;

const SUPPORTED_MODES = new Set<RenderMode>([
  'raw-dither',
  'dots',
  'blocks',
  'halftone',
  'ascii',
  'hybrid'
]);

const ALGORITHMS: Partial<Record<DitherAlgorithm, number>> = {
  threshold: 0,
  bayer2: 1,
  bayer4: 2,
  bayer8: 3,
  bayer16: 4,
  'blue-noise': 5,
  random: 6,
  halftone: 7
};

const STAGGER: Record<AgencyDitherOptions['staggerFrom'], number> = {
  start: 0,
  center: 1,
  end: 2,
  edges: 3,
  left: 4,
  right: 5,
  top: 6,
  bottom: 7,
  'top-left': 8,
  'top-right': 9,
  'bottom-left': 10,
  'bottom-right': 11,
  random: 12
};

// Atlas tiles are rasterised at device resolution. Supersampling was measured
// at 2x and 3x: both widened the gap with Canvas rather than closing it,
// because a bilinear fetch only reads four texels and undersamples past 2x.
const GLYPH_SUPERSAMPLE = 1;

const COLOR_MODES: Record<AgencyDitherOptions['colorMode'], number> = {
  monochrome: 0,
  source: 1,
  palette: 2,
  brightness: 3
};

/** Matches PALETTE_LIMIT in the shader. */
const PALETTE_LIMIT = 16;

const SUFFIX = ' requires the Canvas renderer';
const UNSUPPORTED_MODE = `This mode${SUFFIX}`;
const UNSUPPORTED_ALGORITHM = `This algorithm${SUFFIX}`;

const MODE_REASON: Partial<Record<RenderMode, string>> = {
  ascii: `ascii mode${SUFFIX}`,
  symbols: `symbols mode${SUFFIX}`,
  hybrid: `hybrid mode${SUFFIX}`
};

const ALGORITHM_REASON: Partial<Record<DitherAlgorithm, string>> = {
  'floyd-steinberg': `floyd-steinberg${SUFFIX}`,
  atkinson: `atkinson${SUFFIX}`,
  stucki: `stucki${SUFFIX}`,
  jarvis: `jarvis${SUFFIX}`
};

const AMBIENT: Record<AgencyDitherOptions['ambientMode'], number> = {
  drift: 0,
  wave: 1,
  orbit: 2,
  pulse: 3,
  jitter: 4
};

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

/**
 * Byte-for-byte the hash the Canvas renderer and the dither kernel use. Keeping
 * one definition is what lets the two renderers agree on noise.
 */
const hash = (x: number, y: number, seed: number): number => {
  let value = Math.imul(x + seed * 1013, 374761393) ^
    Math.imul(y + seed * 7919, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
};

interface WebGLUniforms {
  source: WebGLUniformLocation;
  noise: WebGLUniformLocation;
  glyphAtlas: WebGLUniformLocation;
  glyphCount: WebGLUniformLocation;
  glyphTile: WebGLUniformLocation;
  glyphReady: WebGLUniformLocation;
  glyphScramble: WebGLUniformLocation;
  cellData: WebGLUniformLocation;
  glyphRandom: WebGLUniformLocation;
  glyphProbability: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  paletteCount: WebGLUniformLocation;
  paletteMix: WebGLUniformLocation;
  foregroundTransparent: WebGLUniformLocation;
  mask: WebGLUniformLocation;
  maskRect: WebGLUniformLocation;
  maskActive: WebGLUniformLocation;
  maskInvert: WebGLUniformLocation;
  maskThreshold: WebGLUniformLocation;
  maskFeather: WebGLUniformLocation;
  maskProgress: WebGLUniformLocation;
  secondary: WebGLUniformLocation;
  secondaryRect: WebGLUniformLocation;
  sourceMix: WebGLUniformLocation;
  secondaryActive: WebGLUniformLocation;
  primitiveMix: WebGLUniformLocation;
  stagger: WebGLUniformLocation;
  cssSize: WebGLUniformLocation;
  gridSize: WebGLUniformLocation;
  drawRect: WebGLUniformLocation;
  cellSize: WebGLUniformLocation;
  pixel: WebGLUniformLocation;
  threshold: WebGLUniformLocation;
  ditherAmount: WebGLUniformLocation;
  contrast: WebGLUniformLocation;
  brightness: WebGLUniformLocation;
  gamma: WebGLUniformLocation;
  noiseAmount: WebGLUniformLocation;
  dotScale: WebGLUniformLocation;
  revealProgress: WebGLUniformLocation;
  staggerAmount: WebGLUniformLocation;
  foreground: WebGLUniformLocation;
  background: WebGLUniformLocation;
  mode: WebGLUniformLocation;
  algorithm: WebGLUniformLocation;
  colorMode: WebGLUniformLocation;
  staggerFrom: WebGLUniformLocation;
  invert: WebGLUniformLocation;
  backgroundTransparent: WebGLUniformLocation;
  neighborhood: WebGLUniformLocation;
  rotation: WebGLUniformLocation;
  displacement: WebGLUniformLocation;
  displacePhase: WebGLUniformLocation;
  ambientMode: WebGLUniformLocation;
  ambientAmount: WebGLUniformLocation;
  ambientFrequency: WebGLUniformLocation;
  ambientElapsed: WebGLUniformLocation;
  mouse: WebGLUniformLocation;
  ripple: WebGLUniformLocation;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('AgencyDitherFX could not create a WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`AgencyDitherFX WebGL shader failed: ${message}`);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error('AgencyDitherFX could not create a WebGL program.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'unknown program error';
    gl.deleteProgram(program);
    throw new Error(`AgencyDitherFX WebGL program failed: ${message}`);
  }
  return program;
}

function getUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`AgencyDitherFX WebGL uniform missing: ${name}`);
  return location;
}

function rgba(color: string, alpha = 1): [number, number, number, number] {
  const cached = colorCache.get(color);
  if (cached) return [cached[0], cached[1], cached[2], cached[3] * alpha];

  let normalized = color;
  if (!/^#[\da-f]{3,8}$/i.test(color)) {
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      context.fillStyle = '#000000';
      context.fillStyle = color;
      normalized = context.fillStyle;
    }
  }

  let result: [number, number, number, number];
  if (/^#[\da-f]{3,8}$/i.test(normalized)) {
    const value = normalized.slice(1);
    const expanded = value.length === 3 || value.length === 4
      ? [...value].map(part => part + part).join('')
      : value;
    const [r, g, b] = hexToRgb(`#${expanded.slice(0, 6)}`);
    const parsedAlpha = expanded.length === 8
      ? Number.parseInt(expanded.slice(6, 8), 16) / 255
      : 1;
    result = [r / 255, g / 255, b / 255, parsedAlpha];
  } else {
    const channels = normalized.match(/[\d.]+/g)?.map(Number) ?? [];
    result = [
      (channels[0] ?? 0) / 255,
      (channels[1] ?? 0) / 255,
      (channels[2] ?? 0) / 255,
      channels[3] ?? 1
    ];
  }
  colorCache.set(color, result);
  if (colorCache.size > 128) {
    const oldest = colorCache.keys().next().value as string | undefined;
    if (oldest !== undefined) colorCache.delete(oldest);
  }
  return [result[0], result[1], result[2], result[3] * alpha];
}

const colorCache = new Map<string, [number, number, number, number]>();

// Browsers drop the oldest live WebGL context once a page exceeds their limit
// (around 16 in Chrome), which would silently break earlier sections on a page
// that uses many instances. Staying under a self-imposed budget means the
// surplus instances fall back to Canvas instead of evicting each other.
let liveContexts = 0;
// Bumped whenever a slot is returned. Instances that were forced onto Canvas
// watch this so they can retry exactly once per release, instead of attempting
// (and failing) a context creation on every frame.
let budgetGeneration = 0;

export class WebGLRenderer implements DitherRenderer {
  /** Maximum simultaneous WebGL instances before new ones fall back to Canvas. */
  static maxContexts = 8;

  static get activeContexts(): number {
    return liveContexts;
  }

  /** Changes each time a context slot is freed. */
  static get budgetGeneration(): number {
    return budgetGeneration;
  }

  static fallbackReason(
    options: AgencyDitherOptions,
    // Both extra sources are sampled in the shader now. The parameters remain
    // so callers do not have to change, and so a future limit can use them.
    _secondary?: SourceFrame | null,
    _mask?: SourceFrame | null
  ): string {
    // Every message is interned. This runs twice per frame for each instance on
    // the Canvas fallback, so building template strings here littered the heap.
    if (!SUPPORTED_MODES.has(options.mode)) {
      return MODE_REASON[options.mode] ?? UNSUPPORTED_MODE;
    }
    if (options.mode === 'ascii' && options.glyphRamp.length > 255) {
      return 'Glyph ramps over 255 entries require the Canvas renderer';
    }
    if (!(options.algorithm in ALGORITHMS)) {
      return ALGORITHM_REASON[options.algorithm] ?? UNSUPPORTED_ALGORITHM;
    }
    if (options.toneMap.length) return 'Tone maps require the Canvas renderer';
    if (options.palette.length > PALETTE_LIMIT) {
      return `Palettes over ${PALETTE_LIMIT} colours require the Canvas renderer`;
    }
    if (options.blur > 0) return 'Source blur requires the Canvas renderer';
    return '';
  }

  readonly canvas: HTMLCanvasElement;
  readonly kind = 'webgl';
  private readonly gl: WebGLRenderingContext;
  private program!: WebGLProgram;
  private texture!: WebGLTexture;
  private noiseTexture!: WebGLTexture;
  private glyphTexture!: WebGLTexture;
  private paletteTexture!: WebGLTexture;
  private maskTexture!: WebGLTexture;
  private uploadedMask: SourceFrame | null = null;
  private secondaryTexture!: WebGLTexture;
  private cellDataTexture!: WebGLTexture;
  private cellData = new Uint8Array(0);
  private cellDataKey = '';
  private uploadedSecondary: SourceFrame | null = null;
  private paletteKey = '';
  private glyphKey = '';
  private glyphCount = 1;
  private glyphTileCss = 0;
  private glyphReady = false;
  private maxTextureSize = 4096;
  private buffer!: WebGLBuffer;
  private uniforms!: WebGLUniforms;
  private contextLost = false;
  private disposed = false;
  private uploadedSource: SourceFrame | null = null;
  private uploadedWidth = 0;
  private uploadedHeight = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private columns = 1;
  private rows = 1;
  private noiseData = new Uint8Array(0);
  private noiseColumns = 0;
  private noiseRows = 0;
  private noiseFrame = Number.NaN;
  private noiseRollFrame = Number.NaN;
  private noiseShiftFrame = Number.NaN;
  private noiseRampLength = 0;
  private cellWidth = 8;
  private cellHeight = 8;
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
  };
  private readonly onContextRestored = (): void => {
    try {
      this.createResources();
      this.contextLost = false;
      this.canvas.dispatchEvent(new Event('agencydither:webglrestored'));
    } catch {
      this.contextLost = true;
    }
  };

  constructor(canvas: HTMLCanvasElement) {
    if (liveContexts >= WebGLRenderer.maxContexts) {
      throw new Error('AgencyDitherFX WebGL context budget reached.');
    }
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false
    });
    if (!gl) throw new Error('AgencyDitherFX requires WebGL support.');
    this.gl = gl;
    liveContexts += 1;
    try {
      this.createResources();
    } catch (error) {
      // Shader, program, buffer or texture creation can fail after the context
      // exists. Give the budget slot back rather than leaking it forever.
      liveContexts = Math.max(0, liveContexts - 1);
      budgetGeneration += 1;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw error;
    }
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private createResources(): void {
    const gl = this.gl;
    // A restored context starts with a fresh texture, so the upload cache from
    // the previous context must not be trusted.
    this.uploadedSource = null;
    this.uploadedWidth = 0;
    this.uploadedHeight = 0;
    this.program = createProgram(gl);
    this.texture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.noiseTexture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.glyphTexture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.paletteTexture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.maskTexture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.secondaryTexture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.cellDataTexture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.uploadedSecondary = null;
    this.cellDataKey = '';
    this.paletteKey = '';
    this.uploadedMask = null;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.glyphKey = '';
    this.glyphReady = false;
    // A restored context starts with an empty noise texture, so force a rebuild.
    this.noiseColumns = 0;
    this.noiseRows = 0;
    this.noiseFrame = Number.NaN;
    this.uniforms = {
      source: getUniform(gl, this.program, 'u_source'),
      noise: getUniform(gl, this.program, 'u_noise'),
      glyphAtlas: getUniform(gl, this.program, 'u_glyphAtlas'),
      glyphCount: getUniform(gl, this.program, 'u_glyphCount'),
      glyphTile: getUniform(gl, this.program, 'u_glyphTile'),
      glyphReady: getUniform(gl, this.program, 'u_glyphReady'),
      glyphScramble: getUniform(gl, this.program, 'u_glyphScramble'),
      cellData: getUniform(gl, this.program, 'u_cellData'),
      glyphRandom: getUniform(gl, this.program, 'u_glyphRandom'),
      glyphProbability: getUniform(gl, this.program, 'u_glyphProbability'),
      palette: getUniform(gl, this.program, 'u_palette'),
      paletteCount: getUniform(gl, this.program, 'u_paletteCount'),
      paletteMix: getUniform(gl, this.program, 'u_paletteMix'),
      foregroundTransparent: getUniform(gl, this.program, 'u_foregroundTransparent'),
      mask: getUniform(gl, this.program, 'u_mask'),
      maskRect: getUniform(gl, this.program, 'u_maskRect'),
      maskActive: getUniform(gl, this.program, 'u_maskActive'),
      maskInvert: getUniform(gl, this.program, 'u_maskInvert'),
      maskThreshold: getUniform(gl, this.program, 'u_maskThreshold'),
      maskFeather: getUniform(gl, this.program, 'u_maskFeather'),
      maskProgress: getUniform(gl, this.program, 'u_maskProgress'),
      secondary: getUniform(gl, this.program, 'u_secondary'),
      secondaryRect: getUniform(gl, this.program, 'u_secondaryRect'),
      sourceMix: getUniform(gl, this.program, 'u_sourceMix'),
      secondaryActive: getUniform(gl, this.program, 'u_secondaryActive'),
      primitiveMix: getUniform(gl, this.program, 'u_primitiveMix'),
      stagger: getUniform(gl, this.program, 'u_stagger'),
      cssSize: getUniform(gl, this.program, 'u_cssSize'),
      gridSize: getUniform(gl, this.program, 'u_gridSize'),
      drawRect: getUniform(gl, this.program, 'u_drawRect'),
      cellSize: getUniform(gl, this.program, 'u_cellSize'),
      pixel: getUniform(gl, this.program, 'u_pixel'),
      threshold: getUniform(gl, this.program, 'u_threshold'),
      ditherAmount: getUniform(gl, this.program, 'u_ditherAmount'),
      contrast: getUniform(gl, this.program, 'u_contrast'),
      brightness: getUniform(gl, this.program, 'u_brightness'),
      gamma: getUniform(gl, this.program, 'u_gamma'),
      noiseAmount: getUniform(gl, this.program, 'u_noiseAmount'),
      dotScale: getUniform(gl, this.program, 'u_dotScale'),
      revealProgress: getUniform(gl, this.program, 'u_revealProgress'),
      staggerAmount: getUniform(gl, this.program, 'u_staggerAmount'),
      foreground: getUniform(gl, this.program, 'u_foreground'),
      background: getUniform(gl, this.program, 'u_background'),
      mode: getUniform(gl, this.program, 'u_mode'),
      algorithm: getUniform(gl, this.program, 'u_algorithm'),
      colorMode: getUniform(gl, this.program, 'u_colorMode'),
      staggerFrom: getUniform(gl, this.program, 'u_staggerFrom'),
      invert: getUniform(gl, this.program, 'u_invert'),
      backgroundTransparent: getUniform(gl, this.program, 'u_backgroundTransparent'),
      neighborhood: getUniform(gl, this.program, 'u_neighborhood'),
      rotation: getUniform(gl, this.program, 'u_rotation'),
      displacement: getUniform(gl, this.program, 'u_displacement'),
      displacePhase: getUniform(gl, this.program, 'u_displacePhase'),
      ambientMode: getUniform(gl, this.program, 'u_ambientMode'),
      ambientAmount: getUniform(gl, this.program, 'u_ambientAmount'),
      ambientFrequency: getUniform(gl, this.program, 'u_ambientFrequency'),
      ambientElapsed: getUniform(gl, this.program, 'u_ambientElapsed'),
      mouse: getUniform(gl, this.program, 'u_mouse'),
      ripple: getUniform(gl, this.program, 'u_ripple')
    };

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('AgencyDitherFX could not create a WebGL buffer.');
    this.buffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const position = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // NEAREST so each cell reads its own baked value rather than a blend of
    // neighbours, and CLAMP_TO_EDGE because the grid is not power-of-two.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.cellDataTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // sourceUv is already expressed in top-down CSS coordinates.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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
    this.prepareGrid(options);
  }

  setSymbol(): void {
    // Symbol drawing remains on the Canvas renderer until a glyph/symbol atlas exists.
  }

  removeSymbol(): void {
    // Symbol drawing remains on the Canvas renderer until a glyph/symbol atlas exists.
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveContexts = Math.max(0, liveContexts - 1);
    budgetGeneration += 1;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.uploadedSource = null;
    if (!this.contextLost) {
      this.gl.deleteBuffer(this.buffer);
      this.gl.deleteTexture(this.texture);
      this.gl.deleteTexture(this.noiseTexture);
      this.gl.deleteTexture(this.glyphTexture);
      this.gl.deleteTexture(this.paletteTexture);
      this.gl.deleteTexture(this.maskTexture);
      this.gl.deleteTexture(this.secondaryTexture);
      this.gl.deleteTexture(this.cellDataTexture);
      this.gl.deleteProgram(this.program);
      // Frees the backing context immediately instead of waiting for GC, which
      // matters when instances are created and torn down across route changes.
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
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
    if (this.contextLost) return this.stats('WebGL context is unavailable');
    const gl = this.gl;
    let warning = this.warningFor(options, secondary, mask);

    try {
      gl.useProgram(this.program);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      // A still image only has to reach the GPU once. Re-uploading it every
      // frame was pure waste, and for video texSubImage2D reuses the existing
      // storage instead of reallocating the texture each time.
      const sameSize =
        this.uploadedWidth === source.width && this.uploadedHeight === source.height;
      if (source.dynamic || this.uploadedSource !== source || !sameSize) {
        if (sameSize && this.uploadedSource) {
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source.drawable as TexImageSource
          );
        } else {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source.drawable as TexImageSource
          );
        }
        this.uploadedSource = source;
        this.uploadedWidth = source.width;
        this.uploadedHeight = source.height;
      }
    } catch {
      warning = 'WebGL could not upload the source; Canvas renderer is recommended';
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return this.stats(warning);
    }

    // The atlas settles glyphCount, which the scramble channels are baked
    // against, so it has to run first.
    if (options.mode === 'ascii' && !this.updateGlyphAtlas(options)) {
      warning = 'Glyph atlas too large for this device; Canvas renderer is recommended';
    }
    this.updateNoise(options, time, this.glyphCount);
    gl.uniform1f(this.uniforms.glyphCount, this.glyphCount);
    gl.uniform2f(this.uniforms.glyphTile, this.glyphTileCss, this.glyphTileCss);
    gl.uniform1i(this.uniforms.glyphReady, this.glyphReady ? 1 : 0);
    gl.uniform1f(
      this.uniforms.glyphScramble,
      options.mode === 'ascii' ? options.glyphScramble : 0
    );
    this.updateCellData(options, time);
    gl.uniform1i(
      this.uniforms.glyphRandom,
      options.glyphSelection === 'random' ? 1 : 0
    );
    gl.uniform1f(this.uniforms.glyphProbability, clamp(options.glyphProbability));
    this.updatePalette(options);
    gl.uniform1f(
      this.uniforms.paletteCount,
      Math.max(1, Math.min(PALETTE_LIMIT, options.palette.length))
    );
    gl.uniform1f(this.uniforms.paletteMix, clamp(options.paletteMix));
    gl.uniform1i(
      this.uniforms.foregroundTransparent,
      options.foregroundTransparent ? 1 : 0
    );
    gl.uniform1f(this.uniforms.primitiveMix, options.primitiveMix);
    this.updateMask(options, mask);
    this.updateSecondary(options, secondary);

    const [drawX, drawY, drawWidth, drawHeight] = this.drawRect(source, options);
    const foreground = rgba(options.foreground);
    const background = rgba(options.background, options.transparent ? 0 : 1);
    const mode = this.mode(options.mode);
    const algorithm = ALGORITHMS[options.algorithm] ?? 0;

    gl.uniform1i(this.uniforms.source, 0);
    gl.uniform1i(this.uniforms.noise, 1);
    gl.uniform1i(this.uniforms.glyphAtlas, 2);
    gl.uniform1i(this.uniforms.palette, 3);
    gl.uniform1i(this.uniforms.mask, 4);
    gl.uniform1i(this.uniforms.secondary, 5);
    gl.uniform1i(this.uniforms.cellData, 6);
    gl.uniform2f(this.uniforms.cssSize, this.cssWidth, this.cssHeight);
    gl.uniform2f(this.uniforms.gridSize, this.columns, this.rows);
    gl.uniform4f(this.uniforms.drawRect, drawX, drawY, drawWidth, drawHeight);
    gl.uniform2f(this.uniforms.cellSize, this.cellWidth, this.cellHeight);
    // CSS units covered by one device pixel: the width of the antialiased edge.
    gl.uniform2f(
      this.uniforms.pixel,
      this.cssWidth / Math.max(1, this.canvas.width),
      this.cssHeight / Math.max(1, this.canvas.height)
    );
    gl.uniform1f(this.uniforms.threshold, options.threshold);
    gl.uniform1f(this.uniforms.ditherAmount, options.ditherAmount);
    gl.uniform1f(this.uniforms.contrast, options.contrast);
    gl.uniform1f(this.uniforms.brightness, options.brightness);
    gl.uniform1f(this.uniforms.gamma, options.gamma);
    gl.uniform1f(this.uniforms.noiseAmount, options.noiseAmount);
    gl.uniform1f(this.uniforms.dotScale, options.dotScale);
    gl.uniform1f(this.uniforms.revealProgress, options.revealProgress);
    gl.uniform1f(this.uniforms.staggerAmount, options.staggerAmount);
    gl.uniform1i(this.uniforms.stagger, options.stagger ? 1 : 0);
    gl.uniform4f(this.uniforms.foreground, ...foreground);
    gl.uniform4f(this.uniforms.background, ...background);
    gl.uniform1i(this.uniforms.mode, mode);
    gl.uniform1i(this.uniforms.algorithm, algorithm);
    gl.uniform1i(this.uniforms.colorMode, COLOR_MODES[options.colorMode] ?? 0);
    gl.uniform1i(this.uniforms.staggerFrom, STAGGER[options.staggerFrom]);
    gl.uniform1i(this.uniforms.invert, options.invert ? 1 : 0);
    gl.uniform1i(
      this.uniforms.backgroundTransparent,
      options.backgroundTransparent || options.transparent ? 1 : 0
    );

    // Motion. Each of these can push a primitive out of its own cell, so the
    // neighbourhood search is only switched on when one of them is in play.
    const ambientAmount = options.ambientEnabled ? options.ambientAmount : 0;
    const rippleAge = pointer.rippleStarted > 0
      ? (time - pointer.rippleStarted) / 1000
      : 0;
    const rippleStrength = pointer.rippleStarted > 0 ? options.rippleStrength : 0;
    const mouseInfluence = pointer.active ? options.mouseInfluence : 0;
    const moves =
      ambientAmount > 0 ||
      options.displacement > 0 ||
      rippleStrength > 0 ||
      mouseInfluence > 0 ||
      // A rotated square's corners reach beyond its own cell.
      (options.rotation !== 0 && options.mode !== 'dots' && options.mode !== 'halftone') ||
      // Glyphs are drawn from the cell centre at roughly cell size and routinely
      // overhang their neighbours.
      options.mode === 'ascii' ||
      // dotScale above 1 pushes the circle past its own cell.
      (options.dotScale > 1 && (options.mode === 'dots' || options.mode === 'halftone'));

    gl.uniform1i(this.uniforms.neighborhood, moves ? 1 : 0);
    gl.uniform1f(this.uniforms.rotation, options.rotation * Math.PI / 180);
    gl.uniform1f(this.uniforms.displacement, options.displacement);
    gl.uniform1f(this.uniforms.displacePhase, time * 0.0004);
    gl.uniform1i(this.uniforms.ambientMode, AMBIENT[options.ambientMode] ?? 0);
    gl.uniform1f(this.uniforms.ambientAmount, ambientAmount);
    gl.uniform1f(
      this.uniforms.ambientFrequency,
      Math.max(0.001, options.ambientFrequency)
    );
    gl.uniform1f(this.uniforms.ambientElapsed, time * 0.001 * options.ambientSpeed);
    gl.uniform3f(this.uniforms.mouse, pointer.x, pointer.y, mouseInfluence);
    gl.uniform4f(
      this.uniforms.ripple,
      pointer.rippleX,
      pointer.rippleY,
      rippleStrength,
      rippleAge
    );

    // The shader writes the finished pixel, alpha included, for every fragment
    // of a full-screen quad. Blending it over the previous frame meant a
    // transparent output (transparent background, or revealProgress driving
    // alpha to 0) left the old frame visible instead of clearing it. Replacing
    // the framebuffer outright is both correct and cheaper.
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.stats(warning);
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
    this.columns = columns;
    this.rows = rows;
    this.cellWidth = this.cssWidth / columns;
    this.cellHeight = this.cssHeight / rows;
  }

  /**
   * Rebuilds the per-cell noise texture when the grid or the noise frame index
   * changes. The frame index advances a handful of times per second, so this is
   * a few tens of kilobytes of work well below once per rendered frame.
   */
  private updateNoise(
    options: AgencyDitherOptions,
    time: number,
    rampLength: number
  ): void {
    const gl = this.gl;
    const columns = this.columns;
    const rows = this.rows;
    const frame = Math.floor(time * options.noiseSpeed * 0.02);
    // Glyph scramble runs on its own two clocks: one decides which cells
    // scramble, the other picks the character. Both index the cell linearly and
    // multiply by 16807, which overflows what a shader float can hold exactly,
    // so the results are baked here alongside the noise.
    const scrambles = options.mode === 'ascii' && options.glyphScramble > 0;
    const rollFrame = scrambles ? Math.floor(time / 70) : 0;
    const shiftFrame = scrambles ? Math.floor(time / 80) : 0;
    const resized = columns !== this.noiseColumns || rows !== this.noiseRows;
    if (
      !resized &&
      frame === this.noiseFrame &&
      rollFrame === this.noiseRollFrame &&
      shiftFrame === this.noiseShiftFrame &&
      rampLength === this.noiseRampLength
    ) {
      return;
    }

    if (resized) {
      this.noiseData = new Uint8Array(columns * rows * 4);
      this.noiseColumns = columns;
      this.noiseRows = rows;
    }
    this.noiseFrame = frame;
    this.noiseRollFrame = rollFrame;
    this.noiseShiftFrame = shiftFrame;
    this.noiseRampLength = rampLength;

    const data = this.noiseData;
    const ramp = Math.max(1, rampLength);
    let offset = 0;
    let index = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1, offset += 4, index += 1) {
        data[offset] = hash(x, y, frame) * 255;
        // The blue-noise algorithm averages a fixed pair of hashes per cell.
        data[offset + 1] =
          ((hash(x, y, 17) + hash(x + 7, y + 13, 41)) * 0.5) * 255;
        if (!scrambles) continue;
        // Stored as the raw integers the Canvas renderer compares, so the
        // shader can recover them exactly rather than through a 0..1 ratio.
        data[offset + 2] = (index * 16807 + rollFrame) % 100;
        data[offset + 3] = (index + shiftFrame) % ramp;
      }
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTexture);
    if (resized) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, columns, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data
      );
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, columns, rows, gl.RGBA, gl.UNSIGNED_BYTE, data
      );
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Renders the glyph ramp into a horizontal strip of tiles, one per entry, at
   * device resolution. Rebuilt only when the ramp, font or cell size changes.
   * Returns false when the strip would exceed the maximum texture size, which
   * sends the instance back to Canvas.
   */
  private updateGlyphAtlas(options: AgencyDitherOptions): boolean {
    const gl = this.gl;
    const ramp = Array.from(options.glyphRamp || ' ');
    const count = Math.max(1, ramp.length);
    const fontSize = Math.max(2, this.cellHeight * 0.98);
    const pixelScale = this.canvas.width / Math.max(1, this.cssWidth);
    // Twice the cell so wide glyphs and descenders are not clipped.
    const tileCss = Math.max(this.cellWidth, this.cellHeight) * 2;
    const tile = Math.max(1, Math.ceil(tileCss * pixelScale * GLYPH_SUPERSAMPLE));
    const key =
      `${options.glyphRamp}|${fontSize}|${options.fontFamily}|${options.fontWeight}|${tile}`;
    this.glyphCount = count;
    this.glyphTileCss = tileCss;
    if (key === this.glyphKey) return this.glyphReady;

    this.glyphKey = key;
    this.glyphReady = false;
    if (tile * count > this.maxTextureSize) return false;

    const atlas = document.createElement('canvas');
    atlas.width = tile * count;
    atlas.height = tile;
    const ctx = atlas.getContext('2d');
    if (!ctx) return false;
    ctx.clearRect(0, 0, atlas.width, atlas.height);
    // The tile is rasterised at GLYPH_SUPERSAMPLE times device resolution, so
    // the font has to be scaled by the same factor or the glyph comes out
    // smaller than the Canvas renderer draws it.
    ctx.font =
      `${options.fontWeight} ${fontSize * pixelScale * GLYPH_SUPERSAMPLE}px ${options.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    const half = tile * 0.5;
    for (let index = 0; index < count; index += 1) {
      ctx.fillText(ramp[index] ?? ' ', index * tile + half, half);
    }

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.activeTexture(gl.TEXTURE0);
    this.glyphReady = true;
    return true;
  }

  /**
   * Bakes the per-cell values that depend on the integer hash: the random-glyph
   * roll, at 16 bits so a tweened glyphProbability does not step, and the jitter
   * offsets, which advance ten times a second.
   */
  private updateCellData(options: AgencyDitherOptions, time: number): void {
    const columns = this.columns;
    const rows = this.rows;
    const random = options.glyphSelection === 'random';
    const jitters =
      options.ambientEnabled &&
      options.ambientAmount > 0 &&
      options.ambientMode === 'jitter';
    const seed = Math.round(options.glyphSeed);
    const step = jitters ? Math.floor(time * 0.001 * options.ambientSpeed * 10) : 0;
    const key = `${columns}x${rows}|${random ? seed : ''}|${jitters ? step : ''}`;
    if (key === this.cellDataKey) return;
    this.cellDataKey = key;

    if (this.cellData.length !== columns * rows * 4) {
      this.cellData = new Uint8Array(columns * rows * 4);
    }
    const data = this.cellData;
    let offset = 0;
    let index = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1, offset += 4, index += 1) {
        if (random) {
          const roll = Math.min(65535, Math.round(hash(x, y, seed) * 65535));
          data[offset] = roll >> 8;
          data[offset + 3] = roll & 255;
        }
        if (!jitters) continue;
        const hashX = Math.imul(index + step * 101, 2654435761);
        const hashY = Math.imul(index + step * 211, 1597334677);
        data[offset + 1] = (((hashX ^ (hashX >>> 16)) >>> 0) / 4294967295) * 255;
        data[offset + 2] = (((hashY ^ (hashY >>> 16)) >>> 0) / 4294967295) * 255;
      }
    }

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.cellDataTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, columns, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data
    );
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Uploads the mask and publishes its placement and threshold uniforms. */
  private updateMask(
    options: AgencyDitherOptions,
    mask: SourceFrame | null | undefined
  ): void {
    const gl = this.gl;
    const active = Boolean(mask?.ready);
    gl.uniform1i(this.uniforms.maskActive, active ? 1 : 0);
    if (!active || !mask) {
      this.uploadedMask = null;
      return;
    }

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    if (mask.dynamic || this.uploadedMask !== mask) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
        mask.drawable as TexImageSource
      );
      this.uploadedMask = mask;
    }
    gl.activeTexture(gl.TEXTURE0);

    const rect = this.placementRect(
      mask,
      options.maskFit,
      options.maskScale,
      options.maskPositionX,
      options.maskPositionY
    );
    gl.uniform4f(this.uniforms.maskRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(this.uniforms.maskInvert, options.maskInvert ? 1 : 0);
    gl.uniform1f(this.uniforms.maskThreshold, clamp(options.maskThreshold));
    gl.uniform1f(this.uniforms.maskFeather, Math.max(0.001, options.maskFeather));
    gl.uniform1f(this.uniforms.maskProgress, clamp(options.maskProgress));
  }

  /** Uploads the second source and publishes its placement and mix. */
  private updateSecondary(
    options: AgencyDitherOptions,
    secondary: SourceFrame | null | undefined
  ): void {
    const gl = this.gl;
    const active = Boolean(secondary?.ready) && options.sourceMix > 0;
    gl.uniform1i(this.uniforms.secondaryActive, active ? 1 : 0);
    if (!active || !secondary) {
      this.uploadedSecondary = null;
      return;
    }

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.secondaryTexture);
    if (secondary.dynamic || this.uploadedSecondary !== secondary) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
        secondary.drawable as TexImageSource
      );
      this.uploadedSecondary = secondary;
    }
    gl.activeTexture(gl.TEXTURE0);

    // The second source shares the primary's fit, so it uses the same rect
    // maths against its own intrinsic size.
    const rect = this.placementRect(secondary, options.fit, 1, 0.5, 0.5);
    gl.uniform4f(this.uniforms.secondaryRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1f(this.uniforms.sourceMix, clamp(options.sourceMix));
  }

  /** Uploads the palette as a 1 x PALETTE_LIMIT strip when it changes. */
  private updatePalette(options: AgencyDitherOptions): void {
    const key = options.palette.join(',');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const data = new Uint8Array(PALETTE_LIMIT * 4);
    const count = Math.min(PALETTE_LIMIT, options.palette.length);
    for (let index = 0; index < count; index += 1) {
      const [r, g, b] = hexToRgb(options.palette[index] ?? '#000000');
      data[index * 4] = r;
      data[index * 4 + 1] = g;
      data[index * 4 + 2] = b;
      data[index * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_LIMIT, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data
    );
    gl.activeTexture(gl.TEXTURE0);
  }

  private drawRect(
    source: SourceFrame,
    options: AgencyDitherOptions
  ): [number, number, number, number] {
    return this.placementRect(source, options.fit, 1, 0.5, 0.5);
  }

  /**
   * The rectangle a source is drawn into, in CSS pixels. Mirrors the placement
   * the Canvas renderer computes on its sample grid; the two spaces are
   * proportional, so the result is the same.
   */
  private placementRect(
    source: SourceFrame,
    requestedFit: AgencyDitherOptions['fit'],
    scale: number,
    positionX: number,
    positionY: number
  ): [number, number, number, number] {
    const fit = requestedFit === 'stretch' ? 'fill' : requestedFit;
    let width = this.cssWidth;
    let height = this.cssHeight;
    if (fit === 'cover' || fit === 'contain') {
      const fitScale = fit === 'cover'
        ? Math.max(this.cssWidth / source.width, this.cssHeight / source.height)
        : Math.min(this.cssWidth / source.width, this.cssHeight / source.height);
      width = source.width * fitScale;
      height = source.height * fitScale;
    } else if (fit === 'none') {
      width = source.width;
      height = source.height;
    }
    width *= scale;
    height *= scale;
    const x = (this.cssWidth - width) * clamp(positionX);
    const y = (this.cssHeight - height) * clamp(positionY);
    return [x, y, width, height];
  }

  private mode(mode: RenderMode): number {
    if (mode === 'raw-dither') return 0;
    if (mode === 'dots' || mode === 'halftone') return 1;
    if (mode === 'ascii') return 4;
    if (mode === 'hybrid') return 5;
    return 2;
  }

  private warningFor(
    options: AgencyDitherOptions,
    secondary?: SourceFrame | null,
    mask?: SourceFrame | null
  ): string {
    return WebGLRenderer.fallbackReason(options, secondary, mask);
  }

  private stats(warning: string): RenderStats {
    return {
      fps: 0,
      cells: this.columns * this.rows,
      width: this.canvas.width,
      height: this.canvas.height,
      renderer: this.kind,
      warning
    };
  }
}
