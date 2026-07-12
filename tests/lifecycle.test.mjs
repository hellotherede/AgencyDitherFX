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

  const asciiFx = new AgencyDitherFX(new FakeElement(), {
    renderer: 'webgl',
    mode: 'ascii'
  });
  assert.equal(webglRequests, 0, 'ASCII should select Canvas without trying WebGL');
  asciiFx.set({ mode: 'dots' });
  assert.equal(webglRequests, 1, 'compatible settings should try WebGL again');
  asciiFx.destroy();
});
