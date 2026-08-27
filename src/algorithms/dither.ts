import type { DitherAlgorithm } from '../core/types';

const BAYER_2 = [0, 2, 3, 1];
const BAYER_4 = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5
];

function makeBayer(size: number): number[] {
  if (size === 2) return BAYER_2;
  if (size === 4) return BAYER_4;
  const smaller = makeBayer(size / 2);
  const result = new Array<number>(size * size);
  const offsets = [0, 2, 3, 1];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const quadrant = (y >= size / 2 ? 2 : 0) + (x >= size / 2 ? 1 : 0);
      const base = smaller[(y % (size / 2)) * (size / 2) + (x % (size / 2))] ?? 0;
      result[y * size + x] = base * 4 + (offsets[quadrant] ?? 0);
    }
  }
  return result;
}

const MATRICES: Record<string, { size: number; values: number[] }> = {
  bayer2: { size: 2, values: BAYER_2 },
  bayer4: { size: 4, values: BAYER_4 },
  bayer8: { size: 8, values: makeBayer(8) },
  bayer16: { size: 16, values: makeBayer(16) }
};

const DIFFUSION_SOURCE: Partial<
  Record<DitherAlgorithm, { divisor: number; taps: Array<[number, number, number]> }>
> = {
  'floyd-steinberg': {
    divisor: 16,
    taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]
  },
  atkinson: {
    divisor: 8,
    taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]
  },
  stucki: {
    divisor: 42,
    taps: [
      [1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8],
      [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4],
      [1, 2, 2], [2, 2, 1]
    ]
  },
  jarvis: {
    divisor: 48,
    taps: [
      [1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7],
      [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5],
      [1, 2, 3], [2, 2, 1]
    ]
  }
};

// Flattened once at module load: the inner diffusion loop runs up to 12 taps
// per pixel, so iterating tuples there allocated an iterator per pixel.
interface Diffusion {
  divisor: number;
  count: number;
  offsets: Int32Array;
  // Raw integer weights. Pre-dividing by the divisor would change the
  // floating-point association and perturb the diffused result.
  weights: Int32Array;
}

const DIFFUSION: Partial<Record<DitherAlgorithm, Diffusion>> = {};
for (const [name, spec] of Object.entries(DIFFUSION_SOURCE)) {
  if (!spec) continue;
  const count = spec.taps.length;
  const offsets = new Int32Array(count * 2);
  const weights = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    const [dx, dy, weight] = spec.taps[index] as [number, number, number];
    offsets[index * 2] = dx;
    offsets[index * 2 + 1] = dy;
    weights[index] = weight;
  }
  DIFFUSION[name as DitherAlgorithm] = { divisor: spec.divisor, count, offsets, weights };
}

const hash = (x: number, y: number, seed: number): number => {
  let value = Math.imul(x + seed * 1013, 374761393) ^ Math.imul(y + seed * 7919, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
};

export function ditherSamples(
  input: Float32Array,
  output: Float32Array,
  width: number,
  height: number,
  algorithm: DitherAlgorithm,
  amount: number,
  threshold: number,
  frame = 0
): void {
  const diffusion = DIFFUSION[algorithm];
  if (diffusion) {
    output.set(input);
    const { count, offsets, weights, divisor } = diffusion;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowStart + x;
        const oldValue = output[index]!;
        const nextValue = oldValue >= threshold ? 1 : 0;
        const error = (oldValue - nextValue) * amount;
        output[index] = nextValue;
        for (let tap = 0; tap < count; tap += 1) {
          const nx = x + offsets[tap * 2]!;
          if (nx < 0 || nx >= width) continue;
          const ny = y + offsets[tap * 2 + 1]!;
          if (ny >= height) continue;
          const target = ny * width + nx;
          output[target] = output[target]! + error * weights[tap]! / divisor;
        }
      }
    }
    return;
  }

  const matrix = MATRICES[algorithm];
  if (matrix) {
    // Hoisted out of the inner loop: the matrix row only changes once per row,
    // and the rank normaliser is constant for the whole pass.
    const size = matrix.size;
    const values = matrix.values;
    const norm = 1 / (size * size);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width;
      const matrixRow = (y % size) * size;
      for (let x = 0; x < width; x += 1) {
        const index = rowStart + x;
        const value = input[index]!;
        const rank = values[matrixRow + (x % size)]!;
        const localThreshold = threshold + (rank * norm - 0.5) * amount;
        const binary = value >= localThreshold ? 1 : 0;
        output[index] = value + (binary - value) * amount;
      }
    }
    return;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = input[index] ?? 0;
      let localThreshold = threshold;
      if (algorithm === 'blue-noise') {
        const a = hash(x, y, 17);
        const b = hash(x + 7, y + 13, 41);
        localThreshold += ((a + b) * 0.5 - 0.5) * amount;
      } else if (algorithm === 'random') {
        localThreshold += (hash(x, y, frame) - 0.5) * amount;
      } else if (algorithm === 'halftone') {
        const dx = (x % 6) - 2.5;
        const dy = (y % 6) - 2.5;
        localThreshold += (Math.hypot(dx, dy) / 3.54 - 0.5) * amount;
      }
      const binary = value >= localThreshold ? 1 : 0;
      output[index] = value + (binary - value) * amount;
    }
  }
}

export function isErrorDiffusion(algorithm: DitherAlgorithm): boolean {
  return algorithm in DIFFUSION;
}
