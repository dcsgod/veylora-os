import { utilization } from './capacity.mjs';
import { KINDS } from './domain.mjs';
import { backtest, forecast, METHODS } from './forecast.mjs';
import { readBody, readJson, send } from './http.mjs';
import { ingestCsv } from './ingest.mjs';
import { planReplenishment, runScenario } from './scenario.mjs';

const PLURAL = { products: 'product', locations: 'location', suppliers: 'supplier', inventory: 'inventory', orders: 'order' };

export function createApi(store) {
  return async function handle(req, res, url) {
    try {
      const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
      const [head, arg] = parts;
      const data = store.snapshot();

      if (head === 'health') return send(res, 200, { ok: true, synthetic: Boolean(data.synthetic) });

      if (head === 'summary' && req.method === 'GET') {
        const recs = planReplenishment(data);
        return send(res, 200, {
          synthetic: Boolean(data.synthetic),
          products: data.products.length,
          locations: data.locations.length,
          suppliers: data.suppliers.length,
          openOrders: data.orders.filter((o) => o.status === 'open').length,
          reorderNeeded: recs.filter((r) => r.orderQty > 0).length,
          highUrgency: recs.filter((r) => r.urgency === 'high').length,
        });
      }

      if (PLURAL[head]) {
        const kind = PLURAL[head];
        if (req.method === 'GET') return send(res, 200, store.list(kind));
        if (req.method === 'POST') {
          const result = store.upsert(kind, await readJson(req));
          return send(res, result.ok ? (result.created ? 201 : 200) : 422, result);
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      if (head === 'ingest' && req.method === 'POST') {
        if (!KINDS.includes(arg)) return send(res, 404, { error: `unknown kind ${arg}` });
        const { records, errors } = ingestCsv(arg, await readBody(req));
        const applied = [];
        for (const r of records) {
          const result = store.upsert(arg, r);
          if (result.ok) applied.push(r);
          else errors.push({ record: r, errors: result.errors });
        }
        return send(res, errors.length && !applied.length ? 422 : 200, { applied: applied.length, errors });
      }

      if (head === 'forecast' && req.method === 'GET') {
        const sku = url.searchParams.get('sku') ?? data.products[0]?.sku;
        const method = url.searchParams.get('method') ?? 'exponential_smoothing';
        const horizon = Math.min(Math.max(Number(url.searchParams.get('horizon') ?? 8), 1), 52);
        if (!METHODS.includes(method)) return send(res, 400, { error: `method must be one of ${METHODS.join(', ')}` });
        const history = data.demandHistory[sku];
        if (!history) return send(res, 404, { error: `no demand history for ${sku}` });
        return send(res, 200, {
          sku, method, horizon, history, forecast: forecast(history, { method, horizon }),
          backtest: METHODS.map((m) => backtest(history, m)),
          note: 'Baseline statistical methods evaluated on synthetic history; accuracy figures apply only to this data.',
        });
      }

      if (head === 'replenishment' && req.method === 'GET') {
        const serviceLevel = Number(url.searchParams.get('serviceLevel') ?? 0.95);
        if (!(serviceLevel > 0.5 && serviceLevel < 1)) return send(res, 400, { error: 'serviceLevel must be between 0.5 and 1' });
        return send(res, 200, planReplenishment(data, { serviceLevel }));
      }

      if (head === 'capacity' && req.method === 'GET') return send(res, 200, utilization(data));

      if (head === 'scenarios') {
        if (req.method === 'GET') return send(res, 200, data.scenarios ?? []);
        if (req.method === 'POST') {
          const body = await readJson(req);
          const params = sanitizeParams(body.params ?? {});
          if (params.error) return send(res, 400, { error: params.error });
          const result = runScenario(data, params);
          const saved = store.saveScenario({
            id: `SCN-${Date.now().toString(36)}`,
            name: String(body.name ?? 'Untitled scenario').slice(0, 80),
            createdAt: new Date().toISOString(),
            params: result.params,
            summary: result.summary,
          });
          return send(res, 201, { ...result, id: saved.id, name: saved.name });
        }
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
    }
  };
}

function sanitizeParams(raw) {
  const out = {};
  if (raw.demandMultiplier !== undefined) {
    const v = Number(raw.demandMultiplier);
    if (!(v >= 0 && v <= 10)) return { error: 'demandMultiplier must be between 0 and 10' };
    out.demandMultiplier = v;
  }
  if (raw.leadTimeDeltaDays !== undefined) {
    const v = Number(raw.leadTimeDeltaDays);
    if (!(v >= -60 && v <= 365)) return { error: 'leadTimeDeltaDays must be between -60 and 365' };
    out.leadTimeDeltaDays = v;
  }
  if (raw.serviceLevel !== undefined) {
    const v = Number(raw.serviceLevel);
    if (!(v > 0.5 && v < 1)) return { error: 'serviceLevel must be between 0.5 and 1' };
    out.serviceLevel = v;
  }
  if (raw.disruptedSupplierId) out.disruptedSupplierId = String(raw.disruptedSupplierId);
  if (raw.method) out.method = String(raw.method);
  return out;
}
