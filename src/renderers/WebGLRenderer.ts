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

uniform sampler2D u_source;
uniform vec2 u_cssSize;
uniform vec2 u_gridSize;
uniform vec4 u_drawRect;
uniform float u_cellSize;
uniform float u_threshold;
uniform float u_ditherAmount;
uniform float u_contrast;
uniform float u_brightness;
uniform float u_gamma;
uniform float u_noiseAmount;
uniform float u_dotScale;
uniform float u_revealProgress;
uniform float u_staggerAmount;
uniform float u_time;
uniform vec4 u_foreground;
uniform vec4 u_background;
uniform int u_mode;
uniform int u_algorithm;
uniform int u_colorMode;
uniform int u_staggerFrom;
uniform bool u_invert;
uniform bool u_backgroundTransparent;

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

float localThreshold(vec2 cell, float base) {
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
    float a = hash(cell + vec2(17.0, 41.0));
    float b = hash(cell * 1.73 + vec2(7.0, 13.0));
    threshold += (((a + b) * 0.5) - 0.5) * u_ditherAmount;
  } else if (u_algorithm == 6) {
    threshold += (hash(cell + floor(u_time * 0.02)) - 0.5) * u_ditherAmount;
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

void main() {
  vec2 css = vec2(v_uv.x, 1.0 - v_uv.y) * u_cssSize;
  vec2 cell = floor(css / max(1.0, u_cellSize));
  vec2 center = (cell + 0.5) * u_cellSize;
  vec2 sourceUv = (center - u_drawRect.xy) / u_drawRect.zw;
  vec4 background = u_backgroundTransparent ? vec4(u_background.rgb, 0.0) : u_background;

  if (
    sourceUv.x < 0.0 || sourceUv.x > 1.0 ||
    sourceUv.y < 0.0 || sourceUv.y > 1.0
  ) {
    gl_FragColor = background;
    return;
  }

  vec4 source = texture2D(u_source, sourceUv);
  float value = luminance(source.rgb);
  value = pow(clamp((value - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0), u_gamma);
  value = clamp(
    value + (hash(cell + floor(u_time * 0.02)) - 0.5) * u_noiseAmount,
    0.0,
    1.0
  );
  if (u_invert) value = 1.0 - value;
  float threshold = localThreshold(cell, u_threshold);
  float binary = value >= threshold ? 1.0 : 0.0;
  float dithered = mix(value, binary, u_ditherAmount);
  float reveal = revealForCell(cell);

  if (reveal <= 0.0) {
    gl_FragColor = background;
    return;
  }

  vec4 ink = u_colorMode == 1 ? vec4(source.rgb, u_foreground.a) : u_foreground;

  if (u_mode == 0) {
    gl_FragColor = vec4(vec3(dithered), reveal);
    return;
  }

  vec2 local = css - cell * u_cellSize;
  float scale = (0.15 + dithered * 0.85) * reveal;
  float alpha = 0.0;

  if (u_mode == 1 || u_mode == 3) {
    float radius = u_cellSize * 0.5 * scale * u_dotScale;
    alpha = distance(local, vec2(u_cellSize * 0.5)) <= radius ? reveal : 0.0;
  } else {
    vec2 halfSize = vec2(u_cellSize * 0.5 * scale);
    vec2 distanceFromCenter = abs(local - vec2(u_cellSize * 0.5));
    alpha = distanceFromCenter.x <= halfSize.x && distanceFromCenter.y <= halfSize.y
      ? reveal
      : 0.0;
  }

  gl_FragColor = alpha > 0.0 ? vec4(ink.rgb, ink.a * alpha) : background;
}
`;

const SUPPORTED_MODES = new Set<RenderMode>([
  'raw-dither',
  'dots',
  'blocks',
  'halftone'
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

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

interface WebGLUniforms {
  source: WebGLUniformLocation;
  cssSize: WebGLUniformLocation;
  gridSize: WebGLUniformLocation;
  drawRect: WebGLUniformLocation;
  cellSize: WebGLUniformLocation;
  threshold: WebGLUniformLocation;
  ditherAmount: WebGLUniformLocation;
  contrast: WebGLUniformLocation;
  brightness: WebGLUniformLocation;
  gamma: WebGLUniformLocation;
  noiseAmount: WebGLUniformLocation;
  dotScale: WebGLUniformLocation;
  revealProgress: WebGLUniformLocation;
  staggerAmount: WebGLUniformLocation;
  time: WebGLUniformLocation;
  foreground: WebGLUniformLocation;
  background: WebGLUniformLocation;
  mode: WebGLUniformLocation;
  algorithm: WebGLUniformLocation;
  colorMode: WebGLUniformLocation;
  staggerFrom: WebGLUniformLocation;
  invert: WebGLUniformLocation;
  backgroundTransparent: WebGLUniformLocation;
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

export class WebGLRenderer implements DitherRenderer {
  static fallbackReason(
    options: AgencyDitherOptions,
    secondary?: SourceFrame | null,
    mask?: SourceFrame | null
  ): string {
    if (!SUPPORTED_MODES.has(options.mode)) {
      return `${options.mode} mode requires the Canvas renderer`;
    }
    if (options.glyphSelection !== 'tone') {
      return 'Random glyph selection requires the Canvas renderer';
    }
    if (!(options.algorithm in ALGORITHMS)) {
      return `${options.algorithm} requires the Canvas renderer`;
    }
    if (secondary?.ready && options.sourceMix > 0) {
      return 'Secondary-source blending requires the Canvas renderer';
    }
    if (mask?.ready) return 'Masks require the Canvas renderer';
    if (options.toneMap.length) return 'Tone maps require the Canvas renderer';
    if (options.colorMode !== 'monochrome' && options.colorMode !== 'source') {
      return `${options.colorMode} color mode requires the Canvas renderer`;
    }
    if (options.foregroundTransparent) {
      return 'Foreground transparency requires the Canvas renderer';
    }
    if (options.blur > 0) return 'Source blur requires the Canvas renderer';
    if (
      options.rotation !== 0 ||
      options.displacement > 0 ||
      options.rippleStrength > 0 ||
      options.mouseInfluence > 0 ||
      (options.ambientEnabled && options.ambientAmount > 0)
    ) {
      return 'Canvas-native motion controls require the Canvas renderer';
    }
    return '';
  }

  readonly canvas: HTMLCanvasElement;
  readonly kind = 'webgl';
  private readonly gl: WebGLRenderingContext;
  private program!: WebGLProgram;
  private texture!: WebGLTexture;
  private buffer!: WebGLBuffer;
  private uniforms!: WebGLUniforms;
  private contextLost = false;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private columns = 1;
  private rows = 1;
  private cellSize = 8;
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
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false
    });
    if (!gl) throw new Error('AgencyDitherFX requires WebGL support.');
    this.gl = gl;
    this.createResources();
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private createResources(): void {
    const gl = this.gl;
    this.program = createProgram(gl);
    this.texture = gl.createTexture() ?? (() => {
      throw new Error('AgencyDitherFX could not create a WebGL texture.');
    })();
    this.uniforms = {
      source: getUniform(gl, this.program, 'u_source'),
      cssSize: getUniform(gl, this.program, 'u_cssSize'),
      gridSize: getUniform(gl, this.program, 'u_gridSize'),
      drawRect: getUniform(gl, this.program, 'u_drawRect'),
      cellSize: getUniform(gl, this.program, 'u_cellSize'),
      threshold: getUniform(gl, this.program, 'u_threshold'),
      ditherAmount: getUniform(gl, this.program, 'u_ditherAmount'),
      contrast: getUniform(gl, this.program, 'u_contrast'),
      brightness: getUniform(gl, this.program, 'u_brightness'),
      gamma: getUniform(gl, this.program, 'u_gamma'),
      noiseAmount: getUniform(gl, this.program, 'u_noiseAmount'),
      dotScale: getUniform(gl, this.program, 'u_dotScale'),
      revealProgress: getUniform(gl, this.program, 'u_revealProgress'),
      staggerAmount: getUniform(gl, this.program, 'u_staggerAmount'),
      time: getUniform(gl, this.program, 'u_time'),
      foreground: getUniform(gl, this.program, 'u_foreground'),
      background: getUniform(gl, this.program, 'u_background'),
      mode: getUniform(gl, this.program, 'u_mode'),
      algorithm: getUniform(gl, this.program, 'u_algorithm'),
      colorMode: getUniform(gl, this.program, 'u_colorMode'),
      staggerFrom: getUniform(gl, this.program, 'u_staggerFrom'),
      invert: getUniform(gl, this.program, 'u_invert'),
      backgroundTransparent: getUniform(gl, this.program, 'u_backgroundTransparent')
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
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (!this.contextLost) {
      this.gl.deleteBuffer(this.buffer);
      this.gl.deleteTexture(this.texture);
      this.gl.deleteProgram(this.program);
    }
  }

  render(
    source: SourceFrame,
    options: AgencyDitherOptions,
    time: number,
    _pointer: RendererPointerState,
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
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source.drawable as TexImageSource
      );
    } catch {
      warning = 'WebGL could not upload the source; Canvas renderer is recommended';
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return this.stats(warning);
    }

    const [drawX, drawY, drawWidth, drawHeight] = this.drawRect(source, options);
    const foreground = rgba(options.foreground);
    const background = rgba(options.background, options.transparent ? 0 : 1);
    const mode = this.mode(options.mode);
    const algorithm = ALGORITHMS[options.algorithm] ?? 0;

    gl.uniform1i(this.uniforms.source, 0);
    gl.uniform2f(this.uniforms.cssSize, this.cssWidth, this.cssHeight);
    gl.uniform2f(this.uniforms.gridSize, this.columns, this.rows);
    gl.uniform4f(this.uniforms.drawRect, drawX, drawY, drawWidth, drawHeight);
    gl.uniform1f(this.uniforms.cellSize, this.cellSize);
    gl.uniform1f(this.uniforms.threshold, options.threshold);
    gl.uniform1f(this.uniforms.ditherAmount, options.ditherAmount);
    gl.uniform1f(this.uniforms.contrast, options.contrast);
    gl.uniform1f(this.uniforms.brightness, options.brightness);
    gl.uniform1f(this.uniforms.gamma, options.gamma);
    gl.uniform1f(this.uniforms.noiseAmount, options.noiseAmount);
    gl.uniform1f(this.uniforms.dotScale, options.dotScale);
    gl.uniform1f(this.uniforms.revealProgress, options.revealProgress);
    gl.uniform1f(this.uniforms.staggerAmount, options.stagger ? options.staggerAmount : 0);
    gl.uniform1f(this.uniforms.time, time * options.noiseSpeed);
    gl.uniform4f(this.uniforms.foreground, ...foreground);
    gl.uniform4f(this.uniforms.background, ...background);
    gl.uniform1i(this.uniforms.mode, mode);
    gl.uniform1i(this.uniforms.algorithm, algorithm);
    gl.uniform1i(this.uniforms.colorMode, options.colorMode === 'source' ? 1 : 0);
    gl.uniform1i(this.uniforms.staggerFrom, STAGGER[options.staggerFrom]);
    gl.uniform1i(this.uniforms.invert, options.invert ? 1 : 0);
    gl.uniform1i(
      this.uniforms.backgroundTransparent,
      options.backgroundTransparent || options.transparent ? 1 : 0
    );

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    this.cellSize = Math.max(this.cssWidth / columns, this.cssHeight / rows);
  }

  private drawRect(
    source: SourceFrame,
    options: AgencyDitherOptions
  ): [number, number, number, number] {
    const fit = options.fit === 'stretch' ? 'fill' : options.fit;
    let width = this.cssWidth;
    let height = this.cssHeight;
    if (fit === 'cover' || fit === 'contain') {
      const scale = fit === 'cover'
        ? Math.max(this.cssWidth / source.width, this.cssHeight / source.height)
        : Math.min(this.cssWidth / source.width, this.cssHeight / source.height);
      width = source.width * scale;
      height = source.height * scale;
    } else if (fit === 'none') {
      width = source.width;
      height = source.height;
    }
    const x = (this.cssWidth - width) * 0.5;
    const y = (this.cssHeight - height) * 0.5;
    return [x, y, width, height];
  }

  private mode(mode: RenderMode): number {
    if (mode === 'raw-dither') return 0;
    if (mode === 'dots' || mode === 'halftone') return 1;
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
