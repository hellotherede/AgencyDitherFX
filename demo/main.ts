import { gsap } from 'gsap';
import {
  AgencyDitherFX,
  defaultSymbols,
  presets,
  type AgencyDitherOptions,
  type ToneBand
} from '../src';
import './styles.css';

const $ = <T extends Element>(selector: string): T => {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing demo element: ${selector}`);
  return result;
};

AgencyDitherFX.useGSAP(gsap);

const preview = $<HTMLElement>('[data-preview]');
const status = $<HTMLElement>('[data-status]');
const metrics = $<HTMLElement>('[data-metrics]');
const upload = $<HTMLInputElement>('[data-upload]');
const toneMapInput = $<HTMLTextAreaElement>('[data-tone-map]');
const toneBandsElement = $<HTMLElement>('[data-tone-bands]');

const BAND_NAMES = [
  'Shadow',
  'Dark',
  'Low-mid',
  'Mid',
  'High-mid',
  'Light',
  'Highlights'
] as const;

interface BandState {
  name: string;
  symbol: string;
  color: string;
  scale: number;
  motionAmount: number;
}

const registeredSymbols = new Map<string, string>([
  ['circle', 'Circle'],
  ['square', 'Square'],
  ['diamond', 'Diamond'],
  ['slash', 'Slash'],
  ['cross', 'Cross'],
  ['star', 'Star'],
  ['ring', 'Ring']
]);
const bandColors = [
  '#11110f',
  '#292823',
  '#544b3d',
  '#ef5a37',
  '#e98c36',
  '#f4be36',
  '#f1eee7'
];
const bands: BandState[] = BAND_NAMES.map((name, index) => ({
  name,
  symbol: Object.keys(defaultSymbols)[index] ?? 'star',
  color: bandColors[index] ?? '#11110f',
  scale: 0.7 + index * 0.06,
  motionAmount: 0
}));

const makeSource = (): string => {
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 1000;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#11110f');
  gradient.addColorStop(0.45, '#eee9df');
  gradient.addColorStop(1, '#ef5a37');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#11110f';
  context.font = '900 280px sans-serif';
  context.fillText('FIELD', 80, 520);
  context.strokeStyle = '#eee9df';
  context.lineWidth = 36;
  context.strokeRect(760, 150, 430, 620);
  return canvas.toDataURL();
};

const fx = new AgencyDitherFX(preview, {
  ...presets['editorial-bayer'],
  source: makeSource(),
  immediate: true,
  interaction: { pointer: true, clickRipple: true }
});

void fx.registerSymbols(defaultSymbols);

toneMapInput.value = JSON.stringify([
  { min: 0, max: 0.3, primitive: 'block', color: '#11110f', scale: 0.9 },
  { min: 0.3, max: 0.72, primitive: 'dot', color: '#ef5a37', scale: 0.8 },
  { min: 0.72, max: 1, primitive: 'symbol', symbol: 'custom', scale: 0.9 }
] satisfies ToneBand[], null, 2);

function bandsToToneMap(): ToneBand[] {
  return bands.map((band, index) => ({
    min: index / bands.length,
    max: (index + 1) / bands.length,
    primitive: 'symbol',
    symbol: band.symbol,
    color: band.color,
    scale: band.scale,
    motionAmount: band.motionAmount,
    motionSpeed: 0.8 + index * 0.12
  }));
}

function applyBands(): void {
  const toneMap = bandsToToneMap();
  toneMapInput.value = JSON.stringify(toneMap, null, 2);
  fx.set({ toneMap });
}

function renderBandControls(): void {
  toneBandsElement.replaceChildren();
  bands.forEach((band, index) => {
    const row = document.createElement('div');
    row.className = 'tone-band';
    const name = document.createElement('strong');
    name.textContent = band.name;
    const symbol = document.createElement('select');
    symbol.setAttribute('aria-label', `${band.name} SVG symbol`);
    for (const [value, label] of registeredSymbols) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === band.symbol;
      symbol.append(option);
    }
    const color = document.createElement('input');
    color.type = 'color';
    color.value = band.color;
    color.setAttribute('aria-label', `${band.name} color`);
    const scale = document.createElement('input');
    scale.type = 'range';
    scale.min = '0';
    scale.max = '2';
    scale.step = '0.01';
    scale.value = String(band.scale);
    scale.setAttribute('aria-label', `${band.name} scale`);
    const motion = document.createElement('input');
    motion.type = 'range';
    motion.min = '0';
    motion.max = '2';
    motion.step = '0.01';
    motion.value = String(band.motionAmount);
    motion.setAttribute('aria-label', `${band.name} motion`);
    const scaleWrap = document.createElement('label');
    scaleWrap.className = 'tone-band__range';
    scaleWrap.append('Scale', scale);
    const motionWrap = document.createElement('label');
    motionWrap.className = 'tone-band__range';
    motionWrap.append('Motion', motion);

    symbol.addEventListener('change', () => {
      bands[index]!.symbol = symbol.value;
      applyBands();
    });
    color.addEventListener('input', () => {
      bands[index]!.color = color.value;
      applyBands();
    });
    scale.addEventListener('input', () => {
      bands[index]!.scale = Number(scale.value);
      applyBands();
    });
    motion.addEventListener('input', () => {
      bands[index]!.motionAmount = Number(motion.value);
      applyBands();
    });
    row.append(name, symbol, color, scaleWrap, motionWrap);
    toneBandsElement.append(row);
  });
}

const presetSelect = $<HTMLSelectElement>('[data-control="preset"]');
presetSelect.innerHTML = '<option value="">Custom</option>' +
  Object.entries(presets).map(([key, preset]) =>
    `<option value="${key}">${preset.name ?? key}</option>`
  ).join('');

function syncControls(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-control]').forEach(input => {
    const key = input.dataset.control;
    if (!key || key === 'preset') return;
    let value: unknown;
    if (key === 'autoplay') value = fx.params.animation.autoplay;
    else value = fx.params[key as keyof AgencyDitherOptions];
    if (key === 'palette') value = fx.params.palette.join(', ');
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = String(value ?? '');
    const output = input.closest('label')?.querySelector('output');
    if (output) output.textContent = String(value);
  });
}

function updateControl(event: Event): void {
  const input = event.currentTarget as HTMLInputElement | HTMLSelectElement;
  const key = input.dataset.control;
  if (!key || key === 'preset') return;
  const value =
    input.type === 'checkbox'
      ? input.checked
      : input.type === 'range'
        ? Number(input.value)
        : input.value;
  if (key === 'autoplay') {
    fx.set({ animation: { ...fx.params.animation, autoplay: Boolean(value) } });
  } else if (key === 'palette') {
    fx.set({ palette: String(value).split(',').map(item => item.trim()).filter(Boolean) });
  } else if (key === 'rippleStrength') {
    fx.set({
      rippleStrength: Number(value),
      interaction: { ...fx.params.interaction, clickRipple: Number(value) > 0 }
    });
  } else {
    fx.set({ [key]: value } as Partial<AgencyDitherOptions>);
  }
  presetSelect.value = '';
  syncControls();
}

document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-control]').forEach(input => {
  input.addEventListener('input', updateControl);
});

presetSelect.addEventListener('change', () => {
  const preset = presets[presetSelect.value];
  if (preset) {
    const { name, ...options } = preset;
    fx.applyPreset(options);
    toneMapInput.value = JSON.stringify(fx.params.toneMap, null, 2);
    syncControls();
    status.textContent = name ?? presetSelect.value;
  }
});

upload.addEventListener('change', async () => {
  const file = upload.files?.[0];
  if (!file) return;
  status.textContent = `Loading ${file.name}`;
  try {
    await fx.setSource(file, file.type.startsWith('video/') ? 'video' : 'image');
    status.textContent = file.name;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Source failed';
  }
  upload.value = '';
});

async function setAuxiliarySource(
  input: HTMLInputElement,
  setter: (file: File, kind: 'image' | 'video') => Promise<unknown>,
  label: string
): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const kind = file.type.startsWith('video/') ? 'video' : 'image';
  try {
    await setter(file, kind);
    status.textContent = `${label}: ${file.name}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : `${label} failed`;
  }
  input.value = '';
}

const secondaryUpload = $<HTMLInputElement>('[data-upload-secondary]');
secondaryUpload.addEventListener('change', () => {
  void setAuxiliarySource(
    secondaryUpload,
    (file, kind) => fx.setSecondarySource(file, kind),
    'Source B'
  );
});

const maskUpload = $<HTMLInputElement>('[data-upload-mask]');
maskUpload.addEventListener('change', () => {
  void setAuxiliarySource(
    maskUpload,
    (file, kind) => fx.setMaskSource(file, kind),
    'Mask'
  );
});

$<HTMLInputElement>('[data-symbol]').addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []).filter(file =>
    file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
  );
  if (!files.length) return;
  const uploadBatch = Date.now();
  const uploadedNames = await Promise.all(files.map(async (file, index) => {
    const base = file.name
      .replace(/\.svg$/i, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .toLowerCase();
    const symbolName = `upload-${base || index}-${uploadBatch}-${index}`;
    await fx.registerSymbol(symbolName, await file.text());
    registeredSymbols.set(symbolName, file.name.replace(/\.svg$/i, ''));
    return symbolName;
  }));
  bands.forEach((band, index) => {
    const mappedIndex = Math.round(
      (index / Math.max(1, bands.length - 1)) *
        Math.max(0, uploadedNames.length - 1)
    );
    band.symbol = uploadedNames[mappedIndex] ?? 'star';
  });
  renderBandControls();
  applyBands();
  fx.set({ mode: 'symbols' });
  syncControls();
  status.textContent =
    `${files.length} SVG${files.length === 1 ? '' : 's'} mapped across 7 tones`;
  input.value = '';
});

$<HTMLButtonElement>('[data-apply-tone]').addEventListener('click', () => {
  try {
    fx.set({ toneMap: JSON.parse(toneMapInput.value) as ToneBand[] });
    status.textContent = 'Tone map applied';
  } catch {
    status.textContent = 'Tone map JSON is invalid';
  }
});

$<HTMLButtonElement>('[data-reveal]').addEventListener('click', () => {
  fx.params.revealProgress = 0;
  fx.to(
    { revealProgress: 1 },
    { duration: fx.params.animationDuration, ease: 'power3.inOut' }
  );
});

async function copy(text: string, message: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  status.textContent = message;
}

$<HTMLButtonElement>('[data-copy-config]').addEventListener('click', () => {
  void copy(fx.exportConfig(), 'Config copied');
});

$<HTMLButtonElement>('[data-export-html]').addEventListener('click', () => {
  void copy(fx.exportMarkup(), 'HTML copied');
});

$<HTMLButtonElement>('[data-export-png]').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `agency-dither-${Date.now()}.png`;
  link.href = fx.canvas.toDataURL('image/png');
  link.click();
});

fx.onRender(event => {
  const detail = event.detail;
  metrics.textContent = `${detail.fps} FPS / ${detail.cells.toLocaleString()} cells / ${detail.width}x${detail.height}`;
  if (detail.warning) status.textContent = detail.warning;
});

window.addEventListener('pagehide', () => {
  fx.destroy();
});

syncControls();
renderBandControls();
status.textContent = 'Editorial Bayer / generated source';
