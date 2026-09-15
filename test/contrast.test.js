import test from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from './browser/contrast.js';

test('opaque colours are scored normally', () => {
  assert.equal(Math.round(contrast('rgb(255, 255, 255)', 'rgb(0, 0, 0)')), 21);
  assert.ok(contrast('rgb(255, 255, 255)', 'rgb(106, 78, 140)') >= 4.5);
});

test('a translucent background is rejected instead of scored on its alpha-free channels', () => {
  // Naively dropping alpha reports ~6.8:1 here, but compositing the 10%-opacity
  // fill over the light track leaves the white label at ~1.3:1 — unreadable.
  assert.throws(() => contrast('rgb(255, 255, 255)', 'rgba(106, 78, 140, 0.1)'), /opaque/);
});

test('fully transparent and translucent foregrounds are rejected too', () => {
  assert.throws(() => contrast('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'), /opaque/);
  assert.throws(() => contrast('rgba(255, 255, 255, 0.5)', 'rgb(0, 0, 0)'), /opaque/);
});

test('an explicit alpha of 1 is still accepted', () => {
  assert.equal(Math.round(contrast('rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 1)')), 21);
});


test('unsupported colour syntax is not silently scored as RGB bytes', () => {
  assert.throws(() => contrast('rgb(255, 255, 255)', 'color(srgb 0.4 0.3 0.5)'), /RGB/);
  assert.throws(() => contrast('rgb(255, 255, 255)', 'rgb(999, 0, 0)'), /RGB/);
});
