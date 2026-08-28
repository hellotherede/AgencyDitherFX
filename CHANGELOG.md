# Changelog

## 2.0.0

WebGL is now the default renderer, and it covers almost the whole feature set
rather than a corner of it.

### Breaking

- **`renderer` defaults to `'webgl'`.** Configurations the shader cannot express
  fall back to Canvas on their own and say why through `warning`, so every mode
  keeps working. The two renderers agree closely but are not identical: cells
  they disagree about stay under roughly 1%, and the rest of the difference is
  sub-pixel antialiasing at primitive edges. Pass `renderer: 'canvas'` where
  byte-exact output matters more than frame rate.
- **`agencydither:render` is only dispatched when something is listening.**
  `onRender()` registers and counts the subscription for you. Code that attaches
  the listener itself with `addEventListener` must now also call
  `emitRenderEvents()`, or it will not receive events.
- **A `<canvas>` element passed as the target decides its renderer at
  construction** and keeps that context for the instance's lifetime, because
  such an element cannot be swapped.

### Added

- `suspend()` and `resume()`, plus `isSuspended`. `IntersectionObserver` reports
  geometry, so a tab panel hidden with opacity or visibility keeps rendering an
  effect nobody can see; tabs and carousels can now say so explicitly.
- `emitRenderEvents()` for listeners attached outside `onRender()`.
- `WebGLRenderer.maxContexts`, a budget so a page built from many instances
  cannot exhaust the browser's WebGL context pool. Contexts are acquired on
  activation and handed back after a grace period, and an instance that lost the
  race retries when a slot frees.
- A benchmark and correctness harness under `bench/`, wired into CI. It drives a
  real browser to compare the two renderers, check that a transparent frame
  clears, and confirm WebGL is actually being used.

### Performance

Measured at 25,680 cells on a 1280x720 host. Every figure is a configuration
that previously ran on Canvas:

| Configuration      | Before  | After   |
| ------------------ | ------: | ------: |
| SVG symbols        | 3.4 fps | 181 fps |
| Tone-mapped symbols| 4.6 fps | 181 fps |
| Rotated blocks     |  15 fps | 181 fps |
| ASCII              |  24 fps | 181 fps |
| ASCII with drift   |  24 fps | 181 fps |
| Ambient, displacement | 28 fps | 181 fps |
| Two-source blend   |  39 fps | 181 fps |
| Luminance mask     |  32 fps | 181 fps |
| Nearest palette    |  25 fps | 181 fps |

The GPU renderer now covers every mode, every colour mode, every realtime-safe
algorithm, every motion control, masks, secondary-source blending, tone maps
with per-band symbols, glyph scramble and random glyph selection. Error
diffusion, source blur and per-band glyphs still select Canvas.

The Canvas renderer itself is only 1-9% faster than before: per-cell drawing is
at the rasteriser's floor. Sampling is 40-60% cheaper, which shows up as a 1.5x
gain in `raw-dither`, the one mode with no per-cell drawing.

### Fixed

- Tweens created through `to()`, `fromTo()` and `timeline()` are killed on
  `destroy()`. They target `params` and kept the instance alive. Completed
  tweens are also released rather than accumulating.
- Caller callbacks passed to `to()` and `fromTo()` receive GSAP's
  `callbackScope` and `onUpdateParams`/`onCompleteParams`.
- Pointer tracking no longer forces a synchronous layout on every pointer event.
- The WebGL renderer no longer blends each frame over the last, which left a
  transparent background showing the previous frame and unioned successive
  frames together.
- The shader asks for `highp` where available, and the stagger order and every
  animation phase are restructured to stay inside 16-bit float range. Desktop
  drivers promote `mediump` to 32 bits, hiding this everywhere but on phones.
- Numerous shader and Canvas agreement fixes: cell geometry, reveal easing,
  antialiasing, compositing, noise, 12-bit source-colour quantisation, and the
  neighbourhood bounds for displaced, rotated and oversized primitives.
