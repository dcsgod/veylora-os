import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economicOrderQuantity, recommend, safetyStock, zForServiceLevel } from '../src/replenishment.mjs';

test('z values match the standard normal table at anchor points', () => {
  assert.equal(zForServiceLevel(0.95), 1.645);
  assert.equal(zForServiceLevel(0.5), 0);
  assert.ok(zForServiceLevel(0.96) > 1.645 && zForServiceLevel(0.96) < 1.881);
});

test('safety stock and EOQ formulas', () => {
  assert.equal(safetyStock({ serviceLevel: 0.95, weeklyDemandStd: 10, leadTimeWeeks: 4 }), 1.645 * 10 * 2);
  assert.equal(Math.round(economicOrderQuantity({ annualDemand: 5200, orderCost: 75, holdingRate: 0.2, unitCost: 10 })), 624);
  assert.equal(economicOrderQuantity({ annualDemand: 0, unitCost: 10 }), 0);
});

const base = { sku: 'A', locationId: 'L', weeklyDemand: 100, weeklyDemandStd: 20, leadTimeDays: 14, minOrderQty: 50, unitCost: 5 };

test('no order when inventory position is above reorder point', () => {
  const r = recommend({ ...base, onHand: 1000, onOrder: 0 });
  assert.equal(r.orderQty, 0);
  assert.equal(r.urgency, 'none');
});

test('orders at least MOQ and enough to cover reorder point when below', () => {
  const r = recommend({ ...base, onHand: 50, onOrder: 0 });
  assert.ok(r.orderQty >= 50);
  assert.ok(r.orderQty >= r.reorderPoint - r.inventoryPosition);
  assert.equal(r.urgency, 'high');
  assert.equal(r.orderValue, Math.round(r.orderQty * 5 * 100) / 100);
});

test('higher service level increases safety stock', () => {
  const lo = recommend({ ...base, onHand: 50, onOrder: 0, serviceLevel: 0.9 });
  const hi = recommend({ ...base, onHand: 50, onOrder: 0, serviceLevel: 0.99 });
  assert.ok(hi.safetyStock > lo.safetyStock);
});
