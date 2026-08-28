import test from 'node:test';
import assert from 'node:assert/strict';

import { AgencyDitherFX } from '../dist/agency-dither-fx.js';

// Minimal DOM good enough to construct an instance and drive its lifecycle.
function installDom() {
  let intersectionCallback = () => {};
  const timers = new Set();

  class FakeElement {
    style = {};
    attributes = new Map();
    listeners = new Map();
    append() {}
    remove() {}
    replaceWith() {}
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) {
      this.listeners.get(name)?.delete(fn);
    }
    dispatchEvent(event) {
      for (const fn of this.listeners.get(event.type) ?? []) fn(event);
      return true;
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() { return { width: 640, height: 360, left: 0, top: 0 }; }
  }

  class FakeCanvas extends FakeElement {
    width = 0;
    height = 0;
    className = '';
    getContext() { return {}; }
  }

  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.HTMLImageElement = class {};
  globalThis.HTMLVideoElement = class {};
  globalThis.SVGElement = class {};
  globalThis.MediaStream = class {};
  globalThis.CustomEvent = class {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  };
  globalThis.document = {
    hidden: false,
    createElement: name => (name === 'canvas' ? new FakeCanvas() : new FakeElement()),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  };
  // The scheduler drives rendering through rAF; queue the callbacks so a test
  // can stay synchronous without letting frames actually run.
  globalThis.requestAnimationFrame = fn => {
    const id = setTimeout(() => fn(0), 1_000_000);
    timers.add(id);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    clearTimeout(id);
    timers.delete(id);
  };
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

  return {
    FakeElement,
    timers,
    setVisible: value => intersectionCallback([{ isIntersecting: value }])
  };
}

/** Records kill() so a test can assert the instance released it. */
function fakeGsap() {
  const created = [];
  const make = () => {
    const tween = {
      killed: false,
      vars: null,
      kill() { this.killed = true; },
      isActive: () => false,
      progress: () => 0
    };
    created.push(tween);
    return tween;
  };
  return {
    created,
    gsap: {
      to: (_target, vars) => Object.assign(make(), { vars }),
      fromTo: (_target, _from, vars) => Object.assign(make(), { vars }),
      timeline: () => make()
    }
  };
}

test('destroy kills every tween the instance created', () => {
  const dom = installDom();
  const { gsap, created } = fakeGsap();
  AgencyDitherFX.useGSAP(gsap);

  const fx = new AgencyDitherFX(new dom.FakeElement());
  fx.to({ revealProgress: 1 });
  fx.fromTo({ revealProgress: 0 }, { revealProgress: 1 });
  fx.timeline();

  assert.equal(created.length, 3);
  assert.ok(created.every(tween => !tween.killed), 'nothing killed before destroy');

  fx.destroy();

  assert.ok(
    created.every(tween => tween.killed),
    'destroy() must kill tweens; they retain params and the render closure'
  );
});

test('completed tweens do not accumulate for the life of the instance', () => {
  const dom = installDom();
  const { gsap, created } = fakeGsap();
  AgencyDitherFX.useGSAP(gsap);

  const fx = new AgencyDitherFX(new dom.FakeElement());
  // A tabbed page retweens on every switch. Report each as finished the way
  // GSAP would, then confirm the retained set is not simply growing.
  for (let index = 0; index < 200; index += 1) {
    const tween = fx.to({ revealProgress: 1 });
    tween.isActive = () => false;
    tween.progress = () => 1;
    tween.vars.onComplete();
  }

  fx.destroy();
  const killedAfterCompletion = created.filter(tween => tween.killed).length;
  assert.ok(
    killedAfterCompletion < 40,
    `expected finished tweens to be released, still retained ${killedAfterCompletion}`
  );
});

test('user onComplete still runs when the instance wraps it', () => {
  const dom = installDom();
  const { gsap } = fakeGsap();
  AgencyDitherFX.useGSAP(gsap);

  const fx = new AgencyDitherFX(new dom.FakeElement());
  let calls = 0;
  const tween = fx.to({ revealProgress: 1 }, { onComplete: () => { calls += 1; } });
  tween.vars.onComplete();
  assert.equal(calls, 1);
  fx.destroy();
});

test('suspend stops the instance and resume restores it', () => {
  const dom = installDom();
  const fx = new AgencyDitherFX(new dom.FakeElement(), { immediate: true });

  assert.equal(fx.isSuspended, false);
  fx.suspend();
  assert.equal(fx.isSuspended, true);
  fx.suspend();
  assert.equal(fx.isSuspended, true, 'suspend is idempotent');

  fx.resume();
  assert.equal(fx.isSuspended, false);
  fx.destroy();

  // Suspending a destroyed instance must not throw.
  fx.suspend();
  assert.equal(fx.isSuspended, false);
});

test('render events are only dispatched when something is listening', () => {
  const dom = installDom();
  const host = new dom.FakeElement();
  const fx = new AgencyDitherFX(host, { immediate: true });

  let received = 0;
  const stop = fx.onRender(() => { received += 1; });
  host.dispatchEvent({ type: 'agencydither:render', detail: {} });
  assert.equal(received, 1, 'onRender subscribers still receive events');

  stop();
  stop();
  assert.equal(typeof fx.emitRenderEvents, 'function');
  fx.destroy();
});
