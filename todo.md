# AgencyDitherFX Follow-up Roadmap

The unstable Raster Ritual implementation described below was replaced by the
TypeScript `AgencyDitherFX` core. The remaining roadmap is intentionally
smaller:

- Add a WebGL2 shader renderer for Bayer, blue-noise, halftone, and glyph-atlas
  ASCII while preserving the current public API.
- Move error-diffusion buffers to a module worker with OffscreenCanvas where
  supported; retain the current throttled Canvas fallback.
- Add visual regression fixtures for every mode and algorithm.
- Add a browser integration suite for image, video, SVG, and mode switching.
- Publish package provenance, changelog, and automated release workflow.

## Archived rewrite rationale

## Why a rewrite is justified

The current implementation has crossed the line where patching is costing more than replacing the unstable parts.

The biggest problems today:

- ASCII media lifecycle is brittle. Source uploads, mode switches, and control changes can recreate or race the renderer.
- Performance is not production-safe. Both modes can do unnecessary work, and the ASCII path still has too much per-update complexity.
- The current architecture mixes demo wiring, render lifecycle, animation, and export concerns too tightly.
- Several features were added incrementally without a stable core contract first, so correctness has drifted.

This does **not** mean the whole product needs to be thrown away.

Keep:

- overall UI shell
- control panel structure
- export concept
- dither mode idea
- ASCII mode idea

Rewrite:

- ASCII renderer core
- render scheduling/lifecycle
- renderer integration layer in `demo.js`

## Target architecture

### 1. Separate the app into three layers

- `demo.js`
  Responsibility: UI only, file upload only, control state only, mode switching only.
- `AsciiEngine.js`
  Responsibility: source loading, brightness sampling, ASCII text generation, animation loop, pause/resume, destroy.
- `DitherEngine.js`
  Responsibility: source loading, raster dither rendering, animation loop, pause/resume, destroy.

`demo.js` should never contain renderer lifecycle logic beyond:

- `setSource(...)`
- `setOptions(...)`
- `start()`
- `stop()`
- `destroy()`

### 2. One shared scheduler/visibility system

Build one small shared runtime:

- one viewport visibility helper
- one animation scheduler
- one reduced-motion gate
- one source decode cache

Goals:

- hidden modules do no active rendering
- non-animated still images render once
- video modules update only when visible
- multiple sections on a page can coexist safely

### 3. Restore the old ASCII renderer as the baseline

Use the old file at:

- `C:\Users\qubis\Desktop\dev\ht\src\js\components\AsciiImage.js`

That old implementation should be treated as the stable behavioral reference for:

- image loading
- video loading
- brightness-map generation
- responsive column calculation
- requestAnimationFrame lifecycle
- pause/resume behavior
- destroy cleanup

Re-add new features only after that baseline is working again.

## Rewrite order

### Phase 1. Stabilize ASCII first

- Copy the old ASCII lifecycle and rendering flow into a fresh engine file.
- Keep support for:
  - image uploads
  - video uploads
  - responsive columns
  - manual start
  - viewport pause/resume
  - invert luminance
- Remove from phase 1:
  - GSAP intro animation inside the renderer
  - extra dithering variants inside the renderer
  - extra color-mapping branches unless they are proven stable

Acceptance criteria:

- uploaded image shows correctly in ASCII mode
- uploaded video shows correctly in ASCII mode
- mode switches do not break the active source
- no `undefined` output
- no blank render when toggling ASCII options

### Phase 2. Rebuild dither engine around the same lifecycle contract

- Normalize `setSource`, `setOptions`, `start`, `stop`, `destroy`.
- Add viewport pause/resume.
- Keep shape loading and recoloring, but isolate it from render loop concerns.
- Make still-image dither renders one-shot unless animation is enabled.

Acceptance criteria:

- multiple uploaded SVGs map correctly
- dither method switching visibly changes output
- hidden dither modules do not animate

### Phase 3. Reintroduce advanced controls carefully

Re-add only after Phases 1 and 2 are stable:

- source brightness
- white point
- black point
- blur
- color mapping
- ASCII dithering
- additional dither algorithms
- GSAP reveal/intro hooks

Each feature must satisfy:

- visually testable
- no lifecycle regressions
- no hidden background work

## Performance requirements

This rewrite should meet these standards:

- no renderer allocates canvases repeatedly inside hot paths
- no hidden section keeps running animation frames
- image mode renders once unless animated
- video mode only updates while visible
- no duplicated source decoding for the same media URL
- no repeated init/destroy churn for simple option changes when avoidable

Preferred implementation details:

- reuse sample canvas/context objects
- cache decoded image/video sources when possible
- cache measured font width until typography inputs change
- use `requestAnimationFrame` for video/animated work
- avoid `setInterval` unless there is a clear reason

## API contract for both engines

Each renderer should expose the same public API:

```js
engine.setSource({ url, kind })
engine.setOptions(options)
engine.start()
engine.stop()
engine.destroy()
```

Optional:

```js
engine.exportConfig()
engine.exportMarkup()
```

## Files to create or refactor

- `demo.js`
  Reduce to orchestration only.
- `AsciiImage.js`
  Replace or split into `AsciiEngine.js` plus optional DOM wrapper.
- `DitherFilter.js`
  Rename or refactor into `DitherEngine.js`.
- `sourceTone.js`
  Keep as shared tone preprocessing if it stays simple and deterministic.

Possible additions:

- `rendererScheduler.js`
- `sourceCache.js`
- `visibilityController.js`
- `exporters.js`

## Features to postpone until after stability

- HTML export that embeds local uploads as portable data
- GSAP stagger presets per mode
- low-cost preset for secondary modules
- richer SVG palette ordering UI
- character atlas or shader-based ASCII rewrite

## Nice-to-have future branch

If DOM-text ASCII still proves too expensive or too fragile for large-scale marketing pages, evaluate a second implementation track:

- shader/canvas ASCII renderer inspired by `isladjan/ascii`

That should be a separate branch of work, not mixed into the stabilization rewrite.

## Definition of done

The rewrite is done when:

- ASCII mode reliably displays uploaded image and video media
- dither mode reliably displays uploaded media and uploaded SVG sets
- mode switching is stable
- no hidden renderer consumes active animation work
- controls visibly affect output
- export returns valid markup and config
- multiple modules on a single page are viable
- the code is simple enough that new controls do not risk breaking lifecycle fundamentals
