import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLayer, alignLayers, createDocument, createLayer, duplicateLayers, hitTest, moveLayer, removeLayers, selectionBounds, snap, updateLayer,
} from '../src/model.mjs';

const base = () => {
  const a = createLayer('rect', { x: 10, y: 10, width: 100, height: 50 });
  const b = createLayer('ellipse', { x: 200, y: 100, width: 80, height: 80 });
  const doc = addLayer(addLayer(createDocument({ width: 400, height: 300 }), a), b);
  return { doc, a, b };
};

test('creates layers with defaults and rejects unknown types', () => {
  const t = createLayer('text', { text: 'Hello' });
  assert.equal(t.name, 'Hello');
  assert.equal(t.align, 'left');
  assert.throws(() => createLayer('hexagon'), /unknown layer type/);
});

test('operations are immutable', () => {
  const { doc, a } = base();
  const next = updateLayer(doc, a.id, { x: 50 });
  assert.equal(doc.layers[0].x, 10);
  assert.equal(next.layers[0].x, 50);
  assert.throws(() => updateLayer(doc, 'missing', {}), /not found/);
});

test('update clamps size and opacity and preserves identity', () => {
  const { doc, a } = base();
  const next = updateLayer(doc, a.id, { width: -5, opacity: 3, id: 'hijack', type: 'text' });
  assert.equal(next.layers[0].width, 1);
  assert.equal(next.layers[0].opacity, 1);
  assert.equal(next.layers[0].id, a.id);
  assert.equal(next.layers[0].type, 'rect');
});

test('z-order moves', () => {
  const { doc, a, b } = base();
  assert.deepEqual(moveLayer(doc, a.id, 'up').layers.map((l) => l.id), [b.id, a.id]);
  assert.deepEqual(moveLayer(doc, a.id, 'down').layers.map((l) => l.id), [a.id, b.id]);
  assert.deepEqual(moveLayer(doc, b.id, 'bottom').layers.map((l) => l.id), [b.id, a.id]);
});

test('duplicate and remove', () => {
  const { doc, a } = base();
  const { doc: d2, ids } = duplicateLayers(doc, [a.id]);
  assert.equal(d2.layers.length, 3);
  assert.equal(d2.layers[1].id, ids[0]);
  assert.equal(d2.layers[1].x, 26);
  assert.equal(removeLayers(d2, [a.id, ids[0]]).layers.length, 1);
});

test('hit testing respects z-order, ellipse shape, visibility and rotation', () => {
  const { doc, a, b } = base();
  assert.equal(hitTest(doc, 20, 20), a.id);
  assert.equal(hitTest(doc, 240, 140), b.id);
  assert.equal(hitTest(doc, 202, 102), null);
  assert.equal(hitTest(updateLayer(doc, a.id, { visible: false }), 20, 20), null);
  const rotated = updateLayer(doc, a.id, { rotation: 90 });
  assert.equal(hitTest(rotated, 60, 50), a.id);
  assert.equal(hitTest(rotated, 15, 35), null);
  const line = createLayer('line', { x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 });
  const d = addLayer(createDocument(), line);
  assert.equal(hitTest(d, 50, 52), line.id);
  assert.equal(hitTest(d, 50, 70), null);
});

test('alignment to canvas and to selection', () => {
  const { doc, a, b } = base();
  assert.equal(alignLayers(doc, [a.id], 'right').layers[0].x, 300);
  assert.equal(alignLayers(doc, [a.id], 'center').layers[0].x, 150);
  const both = alignLayers(doc, [a.id, b.id], 'top');
  assert.equal(both.layers[1].y, 10);
  assert.deepEqual(selectionBounds(doc, [a.id, b.id]), { x: 10, y: 10, width: 270, height: 170 });
});

test('snapping picks the nearest target within threshold', () => {
  assert.deepEqual(snap(103, [0, 100, 105], 6), { value: 105, guide: 105 });
  assert.deepEqual(snap(50, [0, 100], 6), { value: 50, guide: null });
});
