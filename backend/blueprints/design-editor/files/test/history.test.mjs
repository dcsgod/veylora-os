import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRedo, canUndo, createHistory, endCoalesce, push, redo, undo } from '../src/history.mjs';

test('undo and redo walk the history', () => {
  let h = createHistory('a');
  h = push(h, 'b');
  h = push(h, 'c');
  h = undo(h);
  assert.equal(h.present, 'b');
  assert.ok(canRedo(h));
  h = redo(h);
  assert.equal(h.present, 'c');
  h = undo(undo(undo(h)));
  assert.equal(h.present, 'a');
  assert.ok(!canUndo(h));
});

test('pushing after undo discards the redo branch', () => {
  let h = push(push(createHistory(1), 2), 3);
  h = push(undo(h), 4);
  assert.equal(h.future.length, 0);
  assert.deepEqual(h.past, [1, 2]);
});

test('coalesced pushes become one undo step', () => {
  let h = createHistory(0);
  for (let i = 1; i <= 10; i += 1) h = push(h, i, { coalesce: 'drag-1' });
  h = endCoalesce(h);
  h = push(h, 11, { coalesce: 'drag-1' });
  assert.equal(h.past.length, 2);
  assert.equal(undo(h).present, 10);
  assert.equal(undo(undo(h)).present, 0);
});

test('history is bounded', () => {
  let h = createHistory(0, { limit: 5 });
  for (let i = 1; i <= 20; i += 1) h = push(h, i);
  assert.equal(h.past.length, 5);
  assert.equal(h.past[0], 15);
});

test('pushing an identical state is a no-op', () => {
  const s = {};
  const h = createHistory(s);
  assert.equal(push(h, s), h);
});
