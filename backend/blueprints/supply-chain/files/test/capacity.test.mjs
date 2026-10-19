import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utilization } from '../src/capacity.mjs';

const dataset = {
  products: [{ sku: 'A', unitVolume: 1 }, { sku: 'B', unitVolume: 0.5 }],
  locations: [{ id: 'L1', name: 'One', capacity: 100 }, { id: 'L2', name: 'Two', capacity: 10 }],
  inventory: [
    { sku: 'A', locationId: 'L1', onHand: 50, onOrder: 10 },
    { sku: 'B', locationId: 'L1', onHand: 20, onOrder: 0 },
    { sku: 'A', locationId: 'L2', onHand: 9, onOrder: 5 },
  ],
};

test('computes used volume, utilisation and status', () => {
  const [l1, l2] = utilization(dataset);
  assert.equal(l1.used, 60);
  assert.equal(l1.utilization, 60);
  assert.equal(l1.projectedUtilization, 70);
  assert.equal(l1.status, 'ok');
  assert.equal(l2.status, 'over');
});

test('extra inbound raises projection', () => {
  const [l1] = utilization(dataset, { extraInbound: { L1: { A: 20 } } });
  assert.equal(l1.projectedUtilization, 90);
  assert.equal(l1.status, 'warning');
});
