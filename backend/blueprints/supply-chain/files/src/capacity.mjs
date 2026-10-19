// Warehouse capacity in cubic metres: current utilisation and projection including open inbound orders.

export function utilization(dataset, { extraInbound = {} } = {}) {
  const volumeBySku = Object.fromEntries(dataset.products.map((p) => [p.sku, p.unitVolume]));
  return dataset.locations.map((loc) => {
    const rows = dataset.inventory.filter((i) => i.locationId === loc.id);
    const used = rows.reduce((a, i) => a + i.onHand * (volumeBySku[i.sku] ?? 0), 0);
    const inbound = rows.reduce((a, i) => a + i.onOrder * (volumeBySku[i.sku] ?? 0), 0)
      + Object.entries(extraInbound[loc.id] ?? {}).reduce((a, [sku, qty]) => a + qty * (volumeBySku[sku] ?? 0), 0);
    const pct = loc.capacity > 0 ? used / loc.capacity : 0;
    const projectedPct = loc.capacity > 0 ? (used + inbound) / loc.capacity : 0;
    return {
      locationId: loc.id,
      name: loc.name,
      capacity: loc.capacity,
      used: round(used),
      inbound: round(inbound),
      utilization: round(pct * 100),
      projectedUtilization: round(projectedPct * 100),
      status: projectedPct > 1 ? 'over' : projectedPct > 0.85 ? 'warning' : 'ok',
    };
  });
}

function round(v) {
  return Math.round(v * 100) / 100;
}
