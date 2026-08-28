import test from 'node:test';
import assert from 'node:assert/strict';

import { AgencyDitherFX } from '../dist/agency-dither-fx.js';

test('constructor sources wait for viewport activation', () => {
  let imageRequests = 0;
  let webglRequests = 0;
  let intersectionCallback = () => {};

  class FakeElement {
    style = {};
    attributes = new Map();
    append() {}
    remove() {}
    replaceWith() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() {
      return { width: 640, height: 360, left: 0, top: 0 };
    }
  }

  class FakeCanvas extends FakeElement {
    width = 0;
    height = 0;
    className = '';
    getContext(kind) {
      if (kind === 'webgl') {
        webglRequests += 1;
        return null;
      }
      return {};
    }
  }

  class FakeImage {
    decoding = '';
    crossOrigin = '';
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    onload = null;
    onerror = null;
    set src(_value) { imageRequests += 1; }
  }

  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.HTMLImageElement = FakeImage;
  globalThis.HTMLVideoElement = class {};
  globalThis.SVGElement = class {};
  globalThis.MediaStream = class {};
  globalThis.Image = FakeImage;
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {}
    })
  };
  globalThis.document = {
    hidden: false,
    createElement: name => name === 'canvas' ? new FakeCanvas() : new FakeElement(),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.requestAnimationFrame = fn => setTimeout(() => fn(0), 1_000_000);
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
  globalThis.performance ??= { now: () => 0 };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    constructor(callback) { intersectionCallback = callback; }
    observe() {}
    disconnect() {}
  };

  const target = new FakeElement();
  const fx = new AgencyDitherFX(target, { source: '/below-fold.jpg' });
  assert.equal(imageRequests, 0);

  intersectionCallback([{ isIntersecting: true }]);
  assert.equal(imageRequests, 1);
  fx.destroy();

  // WebGL is the default renderer, so count requests relative to a baseline
  // rather than from zero. Error diffusion is sequential and cannot be
  // expressed in a fragment shader, so it still selects Canvas outright.
  const diffusionBaseline = webglRequests;
  const diffusionFx = new AgencyDitherFX(new FakeElement(), {
    renderer: 'webgl',
    algorithm: 'floyd-steinberg',
    immediate: true
  });
  assert.equal(
    webglRequests,
    diffusionBaseline,
    'error diffusion should select Canvas without trying WebGL'
  );
  diffusionFx.set({ algorithm: 'bayer8' });
  assert.equal(
    webglRequests,
    diffusionBaseline + 1,
    'compatible settings should try WebGL again'
  );
  diffusionFx.destroy();

  // A caller's own <canvas> cannot be swapped for a fresh one, so deferring
  // acquisition there would claim a 2D context and lock WebGL out permanently.
  // Those targets must decide at construction instead.
  const canvasBaseline = webglRequests;
  const ownCanvas = new FakeCanvas();
  const canvasFx = new AgencyDitherFX(ownCanvas, { renderer: 'webgl', mode: 'dots' });
  assert.equal(
    webglRequests,
    canvasBaseline + 1,
    'a canvas target must try WebGL before a 2D context is claimed'
  );
  canvasFx.destroy();

  // A WebGL context is only taken once an instance is actually running, so an
  // off-screen section must not consume a slot just by being constructed.
  const before = webglRequests;
  const deferred = new AgencyDitherFX(new FakeElement(), {
    renderer: 'webgl',
    mode: 'dots'
  });
  assert.equal(
    webglRequests,
    before,
    'an inactive instance must not acquire a WebGL context'
  );
  intersectionCallback([{ isIntersecting: true }]);
  assert.equal(
    webglRequests,
    before + 1,
    'activation is what acquires the WebGL context'
  );
  deferred.destroy();
});
