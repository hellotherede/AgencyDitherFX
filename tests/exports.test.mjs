import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgencyDitherFX,
  DEFAULT_OPTIONS,
  isErrorDiffusion,
  presets
} from '../dist/agency-dither-fx.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('every published package entry exists after the library build', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(projectRoot, 'package.json'), 'utf8')
  );
  const entries = new Set([
    packageJson.main,
    packageJson.module,
    packageJson.types,
    ...Object.values(packageJson.exports['.'])
  ]);

  await Promise.all(
    [...entries].map(entry => access(resolve(projectRoot, entry)))
  );
});

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

test('public lifecycle event helpers are available', () => {
  assert.equal(typeof AgencyDitherFX.prototype.onRender, 'function');
  assert.equal(typeof AgencyDitherFX.prototype.onError, 'function');
  assert.equal(typeof AgencyDitherFX.prototype.destroy, 'function');
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
