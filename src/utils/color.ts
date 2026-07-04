export function luminance(r: number, g: number, b: number): number {
  return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(
    normalized.length === 3
      ? normalized.split('').map(char => char + char).join('')
      : normalized,
    16
  );
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function nearestPaletteColor(
  r: number,
  g: number,
  b: number,
  palette: string[]
): string {
  let closest = palette[0] ?? '#000000';
  let distance = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const [pr, pg, pb] = hexToRgb(color);
    const next = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (next < distance) {
      distance = next;
      closest = color;
    }
  }
  return closest;
}
