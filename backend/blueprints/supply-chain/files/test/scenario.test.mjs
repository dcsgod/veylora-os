import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/data.mjs';
import { planReplenishment, runScenario } from '../src/scenario.mjs';

const data = generateDataset({ seed: 42 });

test('plan covers every inventory line', () => {
  const plan = planReplenishment(data);
  assert.equal(plan.length, data.inventory.length);
  for (const r of plan) assert.ok(['none', 'low', 'medium', 'high'].includes(r.urgency));
});

test('demand surge never lowers total order value', () => {
  const r = runScenario(data, { demandMultiplier: 1.5 });
  assert.ok(r.summary.scenarioOrderValue >= r.summary.baselineOrderValue);
  assert.equal(r.params.demandMultiplier, 1.5);
  assert.equal(r.capacity.length, data.locations.length);
});

test('supplier disruption doubles that supplier lead time', () => {
  const plan = planReplenishment(data, { disruptedSupplierId: 'SUP-B' });
  const base = planReplenishment(data);
  const idx = plan.findIndex((r) => r.supplierId === 'SUP-B');
  assert.equal(plan[idx].leadTimeDays, base[idx].leadTimeDays * 2);
  const other = plan.findIndex((r) => r.supplierId === 'SUP-A');
  assert.equal(plan[other].leadTimeDays, base[other].leadTimeDays);
});

test('zero demand produces no orders', () => {
  const r = runScenario(data, { demandMultiplier: 0 });
  assert.equal(r.summary.scenarioOrders, 0);
});
