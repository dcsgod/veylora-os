import { utilization } from './capacity.mjs';
import { forecast, stdDev } from './forecast.mjs';
import { recommend } from './replenishment.mjs';

export const DEFAULT_PARAMS = {
  demandMultiplier: 1,
  leadTimeDeltaDays: 0,
  serviceLevel: 0.95,
  disruptedSupplierId: null,
  method: 'exponential_smoothing',
};

export function planReplenishment(dataset, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const suppliers = Object.fromEntries(dataset.suppliers.map((s) => [s.id, s]));
  const products = Object.fromEntries(dataset.products.map((x) => [x.sku, x]));
  const locationCount = dataset.locations.length || 1;
  return dataset.inventory.map((inv) => {
    const product = products[inv.sku];
    const supplier = suppliers[product.supplierId];
    const history = dataset.demandHistory[inv.sku] ?? [];
    const weeklyNetwork = forecast(history, { method: p.method, horizon: 1 })[0] ?? 0;
    const weeklyDemand = (weeklyNetwork / locationCount) * p.demandMultiplier;
    const weeklyDemandStd = (stdDev(history.slice(-26)) / Math.sqrt(locationCount)) * p.demandMultiplier;
    let leadTimeDays = supplier.leadTimeDays + p.leadTimeDeltaDays;
    if (p.disruptedSupplierId === supplier.id) leadTimeDays *= 2;
    return {
      ...recommend({
        sku: inv.sku,
        locationId: inv.locationId,
        onHand: inv.onHand,
        onOrder: inv.onOrder,
        weeklyDemand,
        weeklyDemandStd,
        leadTimeDays: Math.max(0, leadTimeDays),
        minOrderQty: supplier.minOrderQty,
        unitCost: product.unitCost,
        serviceLevel: p.serviceLevel,
      }),
      supplierId: supplier.id,
      leadTimeDays: Math.max(0, leadTimeDays),
    };
  });
}

export function runScenario(dataset, params = {}) {
  const baseline = planReplenishment(dataset, {});
  const scenario = planReplenishment(dataset, params);
  const inbound = {};
  for (const r of scenario) {
    if (r.orderQty > 0) {
      inbound[r.locationId] ??= {};
      inbound[r.locationId][r.sku] = (inbound[r.locationId][r.sku] ?? 0) + r.orderQty;
    }
  }
  const sum = (rows, key) => Math.round(rows.reduce((a, r) => a + r[key], 0) * 100) / 100;
  return {
    params: { ...DEFAULT_PARAMS, ...params },
    summary: {
      baselineOrderValue: sum(baseline, 'orderValue'),
      scenarioOrderValue: sum(scenario, 'orderValue'),
      baselineOrders: baseline.filter((r) => r.orderQty > 0).length,
      scenarioOrders: scenario.filter((r) => r.orderQty > 0).length,
      highUrgency: scenario.filter((r) => r.urgency === 'high').length,
    },
    recommendations: scenario,
    capacity: utilization(dataset, { extraInbound: inbound }),
  };
}
