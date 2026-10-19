import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReferences, coerce, keyOf, validate } from '../src/domain.mjs';
import { generateDataset } from '../src/data.mjs';

test('valid product passes validation after coercion', () => {
  const record = coerce('product', { sku: 'X-1', name: 'Thing', category: 'C', unitCost: '2.5', unitVolume: '0.1', supplierId: 'SUP-A' });
  assert.equal(record.unitCost, 2.5);
  assert.deepEqual(validate('product', record), { ok: true, errors: [] });
});

test('invalid values and unknown fields are reported', () => {
  const result = validate('supplier', { id: 'S', name: 'N', leadTimeDays: -1, minOrderQty: 1, reliability: 2, colour: 'red' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('leadTimeDays must be >= 0'));
  assert.ok(result.errors.includes('reliability must be <= 1'));
  assert.ok(result.errors.includes('unknown field colour'));
});

test('enum and required checks', () => {
  const result = validate('location', { id: 'L', name: 'N', type: 'moon', capacity: 1 });
  assert.deepEqual(result.errors, ['type must be one of warehouse, store']);
  assert.ok(validate('order', {}).errors.includes('id is required'));
});

test('composite keys', () => {
  assert.equal(keyOf('inventory', { sku: 'A', locationId: 'B' }), 'A::B');
});

test('synthetic dataset has consistent references', () => {
  const data = generateDataset({ seed: 1 });
  assert.equal(data.synthetic, true);
  assert.deepEqual(checkReferences(data), []);
  const broken = { ...data, inventory: [...data.inventory, { sku: 'NOPE', locationId: 'WH-EAST', onHand: 1, onOrder: 0 }] };
  assert.deepEqual(checkReferences(broken), ['inventory references unknown sku NOPE']);
});

test('dataset generation is deterministic per seed', () => {
  assert.deepEqual(generateDataset({ seed: 7 }), generateDataset({ seed: 7 }));
  assert.notDeepEqual(generateDataset({ seed: 7 }).demandHistory, generateDataset({ seed: 8 }).demandHistory);
});
