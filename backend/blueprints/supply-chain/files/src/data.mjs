// Synthetic, seeded demo data. Clearly labelled synthetic: it is not real operational data.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = [
  ['SKU-1001', 'Steel bracket', 'Hardware', 2.4, 0.002, 'SUP-A'],
  ['SKU-1002', 'Hex bolt M8', 'Hardware', 0.15, 0.0002, 'SUP-A'],
  ['SKU-2001', 'Hydraulic pump', 'Components', 180, 0.04, 'SUP-B'],
  ['SKU-2002', 'Pressure valve', 'Components', 42, 0.006, 'SUP-B'],
  ['SKU-3001', 'Control board', 'Electronics', 95, 0.003, 'SUP-C'],
  ['SKU-3002', 'Sensor module', 'Electronics', 28, 0.001, 'SUP-C'],
  ['SKU-4001', 'Packing crate', 'Packaging', 6.5, 0.12, 'SUP-D'],
  ['SKU-4002', 'Shrink wrap roll', 'Packaging', 11, 0.01, 'SUP-D'],
];

export function generateDataset({ seed = 42, weeks = 52 } = {}) {
  const rand = mulberry32(seed);
  const products = PRODUCTS.map(([sku, name, category, unitCost, unitVolume, supplierId]) => ({
    sku, name, category, unitCost, unitVolume, supplierId,
  }));
  const suppliers = [
    { id: 'SUP-A', name: 'Northwind Metals', leadTimeDays: 14, minOrderQty: 500, reliability: 0.95 },
    { id: 'SUP-B', name: 'Delta Hydraulics', leadTimeDays: 28, minOrderQty: 20, reliability: 0.88 },
    { id: 'SUP-C', name: 'Arcade Electronics', leadTimeDays: 35, minOrderQty: 50, reliability: 0.9 },
    { id: 'SUP-D', name: 'Harbor Packaging', leadTimeDays: 7, minOrderQty: 100, reliability: 0.97 },
  ];
  const locations = [
    { id: 'WH-EAST', name: 'East distribution centre', type: 'warehouse', capacity: 220 },
    { id: 'WH-WEST', name: 'West distribution centre', type: 'warehouse', capacity: 160 },
    { id: 'WH-CENTRAL', name: 'Central hub', type: 'warehouse', capacity: 300 },
  ];
  const demandHistory = {};
  const inventory = [];
  for (const p of products) {
    const base = p.unitCost < 1 ? 900 : p.unitCost < 20 ? 220 : p.unitCost < 60 ? 70 : 25;
    const trend = (rand() - 0.4) * 0.01;
    const series = [];
    for (let w = 0; w < weeks; w += 1) {
      const season = 1 + 0.18 * Math.sin((2 * Math.PI * w) / 52);
      const noise = 1 + (rand() - 0.5) * 0.3;
      series.push(Math.max(0, Math.round(base * (1 + trend * w) * season * noise)));
    }
    demandHistory[p.sku] = series;
    for (const l of locations) {
      const share = l.id === 'WH-CENTRAL' ? 0.45 : l.id === 'WH-EAST' ? 0.33 : 0.22;
      inventory.push({
        sku: p.sku,
        locationId: l.id,
        onHand: Math.round(base * share * (1 + rand() * 4)),
        onOrder: rand() > 0.7 ? Math.round(base * share * 2) : 0,
      });
    }
  }
  const orders = inventory
    .filter((i) => i.onOrder > 0)
    .map((i, idx) => ({
      id: `PO-${String(1000 + idx)}`,
      sku: i.sku,
      locationId: i.locationId,
      supplierId: products.find((p) => p.sku === i.sku).supplierId,
      qty: i.onOrder,
      status: 'open',
      eta: new Date(Date.UTC(2026, 0, 5 + idx)).toISOString().slice(0, 10),
    }));
  return { synthetic: true, seed, weeks, products, suppliers, locations, inventory, orders, demandHistory };
}
