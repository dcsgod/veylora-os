// Domain schemas and validation for the planning model.

export const SCHEMAS = {
  product: {
    key: 'sku',
    fields: {
      sku: { type: 'string', required: true },
      name: { type: 'string', required: true },
      category: { type: 'string', required: true },
      unitCost: { type: 'number', required: true, min: 0 },
      unitVolume: { type: 'number', required: true, min: 0 },
      supplierId: { type: 'string', required: true },
    },
  },
  location: {
    key: 'id',
    fields: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
      type: { type: 'enum', values: ['warehouse', 'store'], required: true },
      capacity: { type: 'number', required: true, min: 0 },
    },
  },
  supplier: {
    key: 'id',
    fields: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
      leadTimeDays: { type: 'number', required: true, min: 0 },
      minOrderQty: { type: 'number', required: true, min: 0 },
      reliability: { type: 'number', required: true, min: 0, max: 1 },
    },
  },
  inventory: {
    key: ['sku', 'locationId'],
    fields: {
      sku: { type: 'string', required: true },
      locationId: { type: 'string', required: true },
      onHand: { type: 'number', required: true, min: 0 },
      onOrder: { type: 'number', required: true, min: 0 },
    },
  },
  order: {
    key: 'id',
    fields: {
      id: { type: 'string', required: true },
      sku: { type: 'string', required: true },
      locationId: { type: 'string', required: true },
      supplierId: { type: 'string', required: true },
      qty: { type: 'number', required: true, min: 1 },
      status: { type: 'enum', values: ['open', 'received', 'cancelled'], required: true },
      eta: { type: 'string', required: false },
    },
  },
};

export const KINDS = Object.keys(SCHEMAS);

export function coerce(kind, raw) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`unknown kind ${kind}`);
  const out = {};
  for (const [name, spec] of Object.entries(schema.fields)) {
    let value = raw[name];
    if (value === undefined || value === null || value === '') continue;
    if (spec.type === 'number' && typeof value === 'string') value = Number(value);
    if ((spec.type === 'string' || spec.type === 'enum') && typeof value !== 'string') value = String(value);
    out[name] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

export function validate(kind, record) {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, errors: [`unknown kind ${kind}`] };
  const errors = [];
  for (const [name, spec] of Object.entries(schema.fields)) {
    const value = record[name];
    if (value === undefined) {
      if (spec.required) errors.push(`${name} is required`);
      continue;
    }
    if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${name} must be a number`);
      else {
        if (spec.min !== undefined && value < spec.min) errors.push(`${name} must be >= ${spec.min}`);
        if (spec.max !== undefined && value > spec.max) errors.push(`${name} must be <= ${spec.max}`);
      }
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(value)) errors.push(`${name} must be one of ${spec.values.join(', ')}`);
    } else if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${name} must be a non-empty string`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!(key in schema.fields)) errors.push(`unknown field ${key}`);
  }
  return { ok: errors.length === 0, errors };
}

export function keyOf(kind, record) {
  const key = SCHEMAS[kind].key;
  return Array.isArray(key) ? key.map((k) => record[k]).join('::') : record[key];
}

export function checkReferences(dataset) {
  const problems = [];
  const skus = new Set(dataset.products.map((p) => p.sku));
  const locations = new Set(dataset.locations.map((l) => l.id));
  const suppliers = new Set(dataset.suppliers.map((s) => s.id));
  for (const p of dataset.products) if (!suppliers.has(p.supplierId)) problems.push(`product ${p.sku} references unknown supplier ${p.supplierId}`);
  for (const i of dataset.inventory) {
    if (!skus.has(i.sku)) problems.push(`inventory references unknown sku ${i.sku}`);
    if (!locations.has(i.locationId)) problems.push(`inventory references unknown location ${i.locationId}`);
  }
  for (const o of dataset.orders) {
    if (!skus.has(o.sku)) problems.push(`order ${o.id} references unknown sku ${o.sku}`);
    if (!suppliers.has(o.supplierId)) problems.push(`order ${o.id} references unknown supplier ${o.supplierId}`);
  }
  return problems;
}
