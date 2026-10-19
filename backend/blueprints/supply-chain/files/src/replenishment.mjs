// Baseline replenishment policy: continuous review (s, Q) with normal-approximation safety stock.

const Z_TABLE = [
  [0.5, 0], [0.8, 0.842], [0.85, 1.036], [0.9, 1.282], [0.95, 1.645], [0.97, 1.881], [0.98, 2.054], [0.99, 2.326], [0.995, 2.576],
];

export function zForServiceLevel(level) {
  if (level <= Z_TABLE[0][0]) return 0;
  for (let i = 1; i < Z_TABLE.length; i += 1) {
    const [l1, z1] = Z_TABLE[i];
    if (level <= l1) {
      const [l0, z0] = Z_TABLE[i - 1];
      return z0 + ((level - l0) / (l1 - l0)) * (z1 - z0);
    }
  }
  return Z_TABLE[Z_TABLE.length - 1][1];
}

export function safetyStock({ serviceLevel, weeklyDemandStd, leadTimeWeeks }) {
  return zForServiceLevel(serviceLevel) * weeklyDemandStd * Math.sqrt(Math.max(leadTimeWeeks, 0));
}

export function reorderPoint({ weeklyDemand, leadTimeWeeks, safety }) {
  return weeklyDemand * leadTimeWeeks + safety;
}

export function economicOrderQuantity({ annualDemand, orderCost = 75, holdingRate = 0.22, unitCost }) {
  const holding = holdingRate * unitCost;
  if (annualDemand <= 0 || holding <= 0) return 0;
  return Math.sqrt((2 * annualDemand * orderCost) / holding);
}

export function recommend({ sku, locationId, onHand, onOrder, weeklyDemand, weeklyDemandStd, leadTimeDays, minOrderQty, unitCost,
  serviceLevel = 0.95 }) {
  const leadTimeWeeks = leadTimeDays / 7;
  const safety = safetyStock({ serviceLevel, weeklyDemandStd, leadTimeWeeks });
  const rop = reorderPoint({ weeklyDemand, leadTimeWeeks, safety });
  const position = onHand + onOrder;
  const eoq = economicOrderQuantity({ annualDemand: weeklyDemand * 52, unitCost });
  let orderQty = 0;
  let reason = 'inventory position above reorder point';
  if (position <= rop) {
    orderQty = Math.max(Math.ceil(eoq), Math.ceil(rop - position + weeklyDemand), minOrderQty);
    reason = `inventory position ${Math.round(position)} at or below reorder point ${Math.round(rop)}`;
  }
  const weeksOfCover = weeklyDemand > 0 ? onHand / weeklyDemand : Infinity;
  const urgency = orderQty === 0 ? 'none' : weeksOfCover < leadTimeWeeks ? 'high' : weeksOfCover < leadTimeWeeks * 1.5 ? 'medium' : 'low';
  return {
    sku,
    locationId,
    onHand,
    onOrder,
    inventoryPosition: Math.round(position),
    safetyStock: Math.round(safety),
    reorderPoint: Math.round(rop),
    eoq: Math.round(eoq),
    orderQty,
    orderValue: Math.round(orderQty * unitCost * 100) / 100,
    weeksOfCover: Number.isFinite(weeksOfCover) ? Math.round(weeksOfCover * 10) / 10 : null,
    urgency,
    reason,
  };
}
