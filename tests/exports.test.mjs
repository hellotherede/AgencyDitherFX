import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgencyDitherFX,
  DEFAULT_OPTIONS,
  isErrorDiffusion,
  presets
} from '../dist/agency-dither-fx.js';

test('package import is SSR-safe and exposes expected defaults', () => {
  assert.equal(DEFAULT_OPTIONS.renderer, 'canvas');
  assert.equal(DEFAULT_OPTIONS.worker, false);
  assert.equal(isErrorDiffusion('floyd-steinberg'), true);
  assert.equal(isErrorDiffusion('bayer8'), false);
  assert.ok(presets['editorial-bayer']);
  assert.equal(presets['left-scan-reveal'].staggerFrom, 'left');
});

test('constructor gives a DOM-specific error outside the browser', () => {
  assert.throws(
    () => new AgencyDitherFX('[data-missing]'),
    /browser DOM/
  );
});

test('fromTo keeps caller onUpdate while requesting a render', () => {
  let capturedVars;
  AgencyDitherFX.useGSAP({
    to() {
      throw new Error('unused');
    },
    fromTo(_target, _fromVars, toVars) {
      capturedVars = toVars;
      return toVars;
    },
    timeline() {
      return {};
    }
  });

  const instance = Object.create(AgencyDitherFX.prototype);
  instance.params = {};
  let renderRequests = 0;
  let callerUpdates = 0;
  instance.requestRender = () => {
    renderRequests += 1;
  };

  instance.fromTo(
    { revealProgress: 0 },
    { revealProgress: 1 },
    { onUpdate: () => { callerUpdates += 1; } }
  );

  capturedVars.onUpdate();
  assert.equal(renderRequests, 1);
  assert.equal(callerUpdates, 1);
});
