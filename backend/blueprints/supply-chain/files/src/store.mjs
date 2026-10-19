import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateDataset } from './data.mjs';
import { checkReferences, coerce, keyOf, KINDS, validate } from './domain.mjs';

const COLLECTION = { product: 'products', location: 'locations', supplier: 'suppliers', inventory: 'inventory', order: 'orders' };

export function createStore({ dataDir, seed = 42 } = {}) {
  let state;
  const file = dataDir ? join(dataDir, 'state.json') : null;
  if (file && existsSync(file)) {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    state = { ...generateDataset({ seed }), scenarios: [] };
  }

  function persist() {
    if (!file) return;
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  }

  return {
    snapshot() {
      return state;
    },
    list(kind) {
      if (!KINDS.includes(kind)) throw Object.assign(new Error(`unknown kind ${kind}`), { status: 404 });
      return state[COLLECTION[kind]];
    },
    upsert(kind, raw) {
      if (!KINDS.includes(kind)) throw Object.assign(new Error(`unknown kind ${kind}`), { status: 404 });
      const record = coerce(kind, raw);
      const result = validate(kind, record);
      if (!result.ok) return { ok: false, errors: result.errors };
      const list = state[COLLECTION[kind]];
      const key = keyOf(kind, record);
      const idx = list.findIndex((r) => keyOf(kind, r) === key);
      const next = idx >= 0 ? list.map((r, i) => (i === idx ? record : r)) : [...list, record];
      const candidate = { ...state, [COLLECTION[kind]]: next };
      const problems = checkReferences(candidate);
      if (problems.length) return { ok: false, errors: problems };
      state = candidate;
      persist();
      return { ok: true, record, created: idx < 0 };
    },
    saveScenario(scenario) {
      state.scenarios = [scenario, ...(state.scenarios ?? [])].slice(0, 50);
      persist();
      return scenario;
    },
  };
}
