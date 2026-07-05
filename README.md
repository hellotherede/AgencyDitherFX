# AgencyDitherFX

AgencyDitherFX is a framework-independent TypeScript library for image,
video, ASCII, dither, halftone, and SVG-symbol treatments on marketing sites.
It uses a Canvas 2D production renderer, a shared scheduler, lazy viewport
activation, and an optional GSAP bridge.

The package creates no per-cell DOM elements and can run several independent
sections on one page.

## Demo

[Open the AgencyDitherFX playground](https://hellotherede.github.io/AgencyDitherFX/)

## Current status

Production-ready today:

- Image, video, SVG, canvas, `Blob`/`File`, and `MediaStream` sources
- Dots, blocks, halftone, ASCII, symbols, hybrid, and raw-dither modes
- Threshold, ordered Bayer, blue-noise-style, random, clustered halftone, and
  four error-diffusion algorithms
- Monochrome, source-color, nearest-palette, and brightness-map color modes
- Custom glyph ramps and dense-background ASCII
- Built-in and uploaded SVG symbols
- Seven-band luminance mapping with per-band symbol, color, and scale
- Per-band drift, offset, rotation, and reveal timing parameters
- Directional and diagonal reveal sweeps through `staggerFrom`
- Secondary image/video blending through an animatable `sourceMix`
- Image, video, and SVG luminance masks with threshold and feather controls
- GSAP-friendly parameters, stagger origins, and reveal animation
- One shared animation scheduler for all instances
- Automatic viewport pause/resume and video playback management
- DPR, FPS, and cell-count limits
- Config, HTML, and PNG export in the playground
- SSR-safe module imports and complete instance cleanup

Not implemented yet:

- Full WebGL feature parity. The experimental `webgl` renderer supports
  `raw-dither`, `dots`, `blocks`, and `halftone` with realtime-safe
  algorithms, then warns for Canvas-only features.
- CPU error diffusion is throttled, but not moved into a Web Worker yet; the
  `worker` flag is reserved and defaults to `false`
- Automated browser and visual-regression tests
- GPU glyph atlases for very dense full-screen ASCII video

Those are meaningful next steps for shader-heavy installations, but they are
not required for ordinary hero sections, cards, editorial modules, or
still-image effects.

## Install

Install this workspace and build the package:

```sh
npm install
npm run build:lib
```

During local package development:

```sh
npm run dev
```

Run the package-level checks:

```sh
npm test
```

Library output is written to `dist/` as ESM, UMD, and TypeScript declarations.
GSAP is an optional peer dependency.

## Minimal setup

The host needs an explicit size:

```html
<div
	class="dither-hero"
	data-dither-hero
></div>
```

```css
.dither-hero {
	width: 100%;
	min-height: 70svh;
	overflow: hidden;
}

.dither-hero canvas {
	display: block;
}
```

```ts
import { AgencyDitherFX } from 'agency-dither-fx';

const fx = new AgencyDitherFX('[data-dither-hero]', {
	source: '/media/portrait.jpg',
	mode: 'dots',
	algorithm: 'bayer8',
	cellSize: 8,
	foreground: '#171714',
	background: '#f0ede5',
	colorMode: 'brightness',
	palette: ['#171714', '#ef5a37', '#f4be36', '#f0ede5'],
});
```

Instances lazy-start near the viewport by default. Use `immediate: true` only
for an above-the-fold effect that must initialize immediately.

## Responsive sizing and source fit

The canvas follows its host through `ResizeObserver`. Responsive density is
enabled by default and scales `cellSize` relative to container width while
respecting explicit limits:

```ts
fx.set({
	responsive: true,
	cellSize: 10,
	responsiveMinCellSize: 5,
	responsiveMaxCellSize: 18,
	responsiveReferenceWidth: 1200,
});
```

Disable `responsive` when an art direction requires one absolute cell size at
every breakpoint.

Source fitting follows CSS `object-fit` semantics:

```ts
fx.set({ fit: 'cover' });
```

- `cover`: preserve aspect ratio and fill the stage, cropping overflow
- `contain`: preserve aspect ratio and show the complete source
- `fill`: stretch source width and height to the stage
- `none`: keep the source at its intrinsic CSS-pixel size and center it

Masks expose the same fit modes plus independent X/Y position and scale.

## Sources

`setSource()` accepts:

- Image, video, and SVG URLs
- `HTMLImageElement`
- `HTMLVideoElement`
- `HTMLCanvasElement`
- Inline `SVGElement`
- `Blob` or `File`
- `MediaStream`

```ts
await fx.setSource('/media/editorial.webp');
await fx.setSource('/media/loop.webm', 'video');
```

File input example:

```ts
input.addEventListener('change', async () => {
	const file = input.files?.[0];
	if (!file) return;

	await fx.setSource(file, file.type.startsWith('video/') ? 'video' : 'image');
});
```

Changing modes or algorithms does not decode the source again:

```ts
fx.set({
	mode: 'ascii',
	algorithm: 'bayer4',
	glyphRamp: '.,-~:;=!*#$@',
	invert: false,
});
```

## Two-source transitions

Load a second image or video once, then animate `sourceMix` from `0` to `1`:

```ts
await fx.setSecondarySource('/media/portrait-alt.webp');

fx.to({ sourceMix: 1 }, { duration: 1.2, ease: 'power3.inOut' });
```

Both sources use the same crop, sampling grid, visibility lifecycle, and video
pause/resume behavior. Call `clearSecondarySource()` when it is no longer
needed.

## Masks

Masks use sampled luminance. White reveals the effect and black hides it:

```ts
await fx.setMaskSource('/masks/type-lockup.svg');

fx.set({
	maskThreshold: 0.35,
	maskFeather: 0.12,
	maskInvert: false,
	maskFit: 'contain',
	maskPositionX: 0.5,
	maskPositionY: 0.35,
	maskScale: 1.2,
});
```

Masks can be images, videos, inline SVG, uploaded files, or canvases. Animated
masks participate in the shared scheduler. Call `clearMaskSource()` to remove
the mask. Position values run from `0` to `1`; `0.5` centers the mask.

## Modes

| Mode         | Use                              |
| ------------ | -------------------------------- |
| `dots`       | Luminance-scaled circular field  |
| `blocks`     | Square or rotated graphic grid   |
| `halftone`   | Print-like circular halftone     |
| `ascii`      | Canvas-rendered glyph field      |
| `symbols`    | Registered SVG symbol field      |
| `hybrid`     | Blocks, dots, and glyphs by tone |
| `raw-dither` | Pixel-level dither output        |

## Algorithms

Real-time-safe:

- `threshold`
- `bayer2`
- `bayer4`
- `bayer8`
- `bayer16`
- `blue-noise`
- `random`
- `halftone`

CPU-heavy and automatically throttled for animation:

- `floyd-steinberg`
- `atkinson`
- `stucki`
- `jarvis`

Use ordered algorithms for video and scroll-linked effects. Reserve error
diffusion for stills, export, or intentionally low-resolution loops.

## Color mapping

```ts
fx.set({
	colorMode: 'brightness',
	palette: ['#11110f', '#544b3d', '#ef5a37', '#f4be36', '#f1eee7'],
});
```

Color modes:

- `monochrome`: one foreground color
- `source`: original sampled RGB
- `palette`: nearest palette color by RGB distance
- `brightness`: ordered palette stops from shadow to highlight

Both base layers can be transparent:

```ts
fx.set({
	backgroundTransparent: true,
	foregroundTransparent: false,
});
```

`backgroundTransparent` preserves canvas alpha instead of painting the
background. `foregroundTransparent` suppresses the base monochrome primitive;
explicitly colored tone-map bands and source/palette color modes remain
available. The older `transparent` option remains as a background-transparency
alias for compatibility.

## ASCII

ASCII is rendered into Canvas, not individual DOM nodes:

```ts
fx.set({
	mode: 'ascii',
	cellSize: 8,
	glyphRamp: ' .:-=+*#%@',
	fontFamily: '"DM Mono", monospace',
	fontWeight: 500,
	colorMode: 'source',
});
```

Use the `old-ascii-renderer` preset for a dense field. Its ramp starts with a
visible period instead of a blank, so even the lightest cells contain glyphs:

```ts
import { presets } from 'agency-dither-fx';

fx.set(presets['old-ascii-renderer']);
```

## Presets

Use `applyPreset()` to reset all previous visual settings before applying a
preset:

```ts
import { presets } from 'agency-dither-fx';

const { name, ...options } = presets['signal-bloom'];
fx.applyPreset(options);
```

Loaded primary, secondary, and mask media remain attached. `set(preset)` is
still available when deliberately layering a partial look over current
settings.

Design-led presets include:

- `left-scan-reveal`: blocky left-to-right reveal for scan-style entrances
- `signal-bloom`: kinetic crosses, stars, rings, and hot signal colors
- `runway-ghost`: restrained high-fashion ASCII with an edge reveal
- `acid-registration`: misregistered campaign-print energy
- `transparent-signal-overlay`: compositing-ready transparent symbol layer
- `midnight-constellation`: sparse blue-noise stars and glowing rings
- `newsprint-scream`: dense, high-contrast clustered halftone
- `monument-grid`: large Bauhaus-like geometric tone bands
- `old-ascii-renderer`: dense classic ASCII field
- `editorial-bayer`, `soft-blue-noise`, `halftone-print`, and the original
  utility presets

Symbol presets require the default symbols:

```ts
import { defaultSymbols } from 'agency-dither-fx';

await fx.registerSymbols(defaultSymbols);
fx.set(presets['monument-grid']);
```

## SVG symbols

Seven symbols ship with the library:

- Circle
- Square
- Diamond
- Slash
- Cross
- Star
- Ring

```ts
import { defaultSymbols } from 'agency-dither-fx';

await fx.registerSymbols(defaultSymbols);
fx.set({ mode: 'symbols' });
```

Register custom symbols:

```ts
await fx.registerSymbol(
	'flower',
	`<svg viewBox="0 0 100 100"><path d="..." /></svg>`,
);
```

Map symbols and primitives to luminance bands:

```ts
fx.set({
	mode: 'symbols',
	toneMap: [
		{
			min: 0,
			max: 0.2,
			primitive: 'symbol',
			symbol: 'square',
			color: '#11110f',
			scale: 1.1,
		},
		{
			min: 0.2,
			max: 0.55,
			primitive: 'symbol',
			symbol: 'slash',
			color: '#ef5a37',
			scale: 0.9,
		},
		{
			min: 0.55,
			max: 1,
			primitive: 'symbol',
			symbol: 'ring',
			color: '#f1eee7',
			scale: 0.7,
		},
	],
});
```

The playground expands this into seven editable bands: Shadow, Dark, Low-mid,
Mid, High-mid, Light, and Highlights. Uploaded SVG order maps from darkest to
lightest, after which each band can choose its own symbol, tint, scale, and
motion amount.

Tone bands also support art-directed movement:

```ts
fx.set({
	toneMap: [
		{
			min: 0,
			max: 0.3,
			primitive: 'symbol',
			symbol: 'square',
			color: '#11110f',
			scale: 1,
			offsetX: -0.25,
			motionAmount: 0.15,
			motionSpeed: 0.7,
			revealOffset: 0,
		},
		{
			min: 0.3,
			max: 1,
			primitive: 'symbol',
			symbol: 'star',
			color: '#f4be36',
			scale: 0.8,
			offsetX: 0.2,
			motionAmount: 0.45,
			motionSpeed: 1.2,
			revealOffset: 0.12,
		},
	],
});
```

## GSAP

Register the GSAP instance once. AgencyDitherFX does not bundle GSAP:

```ts
import { gsap } from 'gsap';
import { AgencyDitherFX } from 'agency-dither-fx';

AgencyDitherFX.useGSAP(gsap);
```

Use the built-in bridge:

```ts
fx.params.revealProgress = 0;

fx.to(
	{
		revealProgress: 1,
		threshold: 0.58,
		dotScale: 1.1,
	},
	{
		duration: fx.params.animationDuration,
		ease: 'power3.inOut',
	},
);
```

Stagger is computed inside Canvas and uses GSAP-style origins without creating
DOM nodes:

```ts
fx.set({
	stagger: true,
	staggerAmount: 0.72,
	staggerFrom: 'center',
	animationDuration: 1.4,
});
```

Valid `staggerFrom` values are `start`, `center`, `end`, `edges`, and
`random`, plus directional sweeps from `left`, `right`, `top`, `bottom`,
`top-left`, `top-right`, `bottom-left`, and `bottom-right`.

### Ambient renderer motion

Ambient motion runs inside the shared Canvas render loop and works across
ASCII, dots, blocks, symbols, and hybrid output:

```ts
fx.set({
	ambientEnabled: true,
	ambientMode: 'wave',
	ambientAmount: 0.3,
	ambientSpeed: 0.6,
	ambientFrequency: 0.18,
});
```

Available modes:

- `drift`: smooth two-axis field movement
- `wave`: directional vertical sine wave
- `orbit`: circular cell movement
- `pulse`: spatial scale breathing
- `jitter`: deterministic stepped displacement

This is intentionally renderer-native rather than one GSAP tween per cell.
GSAP can animate the global field itself:

```ts
fx.to(
	{
		ambientAmount: 0.8,
		ambientSpeed: 1.2,
		ambientFrequency: 0.3,
	},
	{
		duration: 1.5,
		ease: 'power3.inOut',
	},
);
```

Setting `ambientEnabled: false` or `ambientAmount: 0` removes the instance from
continuous rendering when no video or other animation requires it.

Direct GSAP animation also works:

```ts
gsap.to(fx.params, {
	cellSize: 5,
	contrast: 1.35,
	duration: 1.2,
	ease: 'expo.out',
	onUpdate: () => fx.render(),
});
```

For multiple coordinated changes:

```ts
const timeline = gsap.timeline({
	defaults: { duration: 1, ease: 'power3.inOut' },
});

timeline
	.to(fx.params, {
		revealProgress: 1,
		onUpdate: () => fx.render(),
	})
	.to(
		fx.params,
		{
			primitiveMix: 0.8,
			rotation: 45,
			onUpdate: () => fx.render(),
		},
		'<0.25',
	);
```

## GSAP ScrollTrigger

ScrollTrigger must be imported and registered separately:

```ts
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { AgencyDitherFX } from 'agency-dither-fx';

gsap.registerPlugin(ScrollTrigger);
AgencyDitherFX.useGSAP(gsap);

const section = document.querySelector('[data-dither-section]');
const fx = new AgencyDitherFX(section, {
	source: '/media/portrait.webp',
	mode: 'ascii',
	algorithm: 'bayer8',
	revealProgress: 0,
	stagger: true,
	staggerAmount: 0.75,
	staggerFrom: 'edges',
});

const tween = gsap.to(fx.params, {
	revealProgress: 1,
	cellSize: 6,
	contrast: 1.3,
	ease: 'none',
	onUpdate: () => fx.render(),
	scrollTrigger: {
		trigger: section,
		start: 'top 80%',
		end: 'bottom 35%',
		scrub: 0.6,
	},
});

// Route/component cleanup:
tween.scrollTrigger?.kill();
tween.kill();
fx.destroy();
```

The convenience helper produces the same reveal:

```ts
fx.params.revealProgress = 0;
fx.scrollTrigger({
	start: 'top 80%',
	end: 'bottom 30%',
	scrub: 0.6,
});
```

For responsive and reduced-motion timelines, use `gsap.matchMedia()` and call
`revert()` during route cleanup.

## Multiple sections

```ts
const instances = Array.from(
	document.querySelectorAll<HTMLElement>('[data-agency-dither]'),
).map(
	(element) =>
		new AgencyDitherFX(element, {
			source: element.dataset.source,
			mode: 'dots',
			algorithm: 'bayer8',
			cellSize: 12,
			maxDpr: 1,
			maxFps: 24,
		}),
);

// On route leave:
instances.forEach((instance) => instance.destroy());
```

All instances use one shared `requestAnimationFrame` scheduler. Hidden
instances leave that scheduler and pause owned video playback automatically.

## Data attributes

```html
<div
	data-agency-dither
	data-source="/media/portrait.jpg"
	data-preset="editorial-bayer"
></div>
```

```ts
import { initAgencyDitherFX } from 'agency-dither-fx';

const instances = initAgencyDitherFX();
```

## Export

```ts
const json = fx.exportConfig();
const html = fx.exportMarkup();
const png = fx.canvas.toDataURL('image/png');
```

`exportMarkup()` contains the renderer config, not source media bytes or the
library bundle. Production consumers should reference deployed source URLs and
initialize the exported element with the package.

## Performance

The production library currently builds to roughly 12 KB gzip, excluding GSAP.
Runtime cost depends mostly on cell count, source type, and algorithm.
Adding source B or a mask adds another low-resolution sampling pass. Using
both roughly triples source sampling work, although primitive drawing remains
unchanged.

Built-in safeguards:

- One shared scheduler across all sections
- No per-cell DOM nodes
- No repeated sample-canvas or typed-array allocation after resize
- Cached raw-image buffers, glyph ramps, tone lookup tables, and palette RGB
- Quantized source-color string cache capped to 4,096 possible colors
- Image decode promise cache for repeated URLs
- Automatic viewport pause/resume
- Still images render only when dirty
- Configurable video and animation FPS
- Default DPR cap of `1.5`
- Default maximum of `42,000` cells
- Error diffusion limited to 12 FPS for animated sources
- SSR package-import and GSAP callback regression tests
- ResizeObserver instead of frame-by-frame layout reads
- Reduced-motion handling
- Full listener, observer, media, and scheduler cleanup

Recommended starting budgets:

| Placement             | Cell size | DPR |      FPS | Algorithm        |
| --------------------- | --------: | --: | -------: | ---------------- |
| Primary hero          |      8–12 | 1.5 |    30–60 | Bayer/blue noise |
| Secondary section     |     12–18 |   1 |    24–30 | Bayer/threshold  |
| Repeated card         |     16–24 |   1 |    15–24 | Bayer/threshold  |
| Error-diffusion still |      8–14 |   1 | One-shot | Floyd/Atkinson   |

Avoid full-screen, high-DPR video with `cellSize < 6` on Canvas. That is the
point where the experimental WebGL renderer can help for `raw-dither`, dots,
blocks, and halftone. ASCII and SVG-symbol workloads still need a future GPU
glyph/symbol atlas before they get the same benefit.

Monitor `agencydither:render` or use `getStats()`:

```ts
fx.onRender((event) => {
	const { fps, cells, width, height, warning } = event.detail;
	console.log({ fps, cells, width, height, warning });
});
```

## Accessibility

- Decorative canvases are `aria-hidden` by default.
- Set `decorative: false` when the rendered media conveys content.
- Provide meaningful fallback content or a fallback image.
- Do not replace essential text with canvas ASCII.
- Reduced motion suppresses decorative loops.
- Lazy initialization avoids competing with LCP by default.

## Cleanup

Destroy instances when a route, view, or component is removed:

```ts
fx.destroy();
```

This stops scheduler work and media playback, disconnects observers, removes
pointer listeners, revokes owned object URLs, and removes an owned canvas.

## API

Primary methods:

- `set(options)`
- `setOptions(options)`
- `applyPreset(preset)`
- `setSource(source, kind?)`
- `setSecondarySource(source, kind?)`
- `setMaskSource(source, kind?)`
- `clearSecondarySource()`
- `clearMaskSource()`
- `registerSymbol(name, svg)`
- `registerSymbols(symbols)`
- `unregisterSymbol(name)`
- `render()`
- `start()`
- `stop()`
- `to(vars, gsapVars)`
- `fromTo(fromVars, toVars, gsapVars)`
- `timeline(vars?)`
- `scrollTrigger(options)`
- `getStats()`
- `exportConfig()`
- `exportMarkup()`
- `onRender(listener)`
- `destroy()`

## License

MIT
