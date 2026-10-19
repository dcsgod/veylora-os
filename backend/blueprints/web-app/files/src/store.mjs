import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Generic JSON collection store with atomic writes. Collections are created on first write.
export function createStore({ dataDir } = {}) {
  const file = dataDir ? join(dataDir, 'state.json') : null;
  let state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  function persist() {
    if (!file) return;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state));
    renameSync(`${file}.tmp`, file);
  }

  return {
    list(collection) {
      return state[collection] ?? [];
    },
    get(collection, id) {
      return (state[collection] ?? []).find((r) => r.id === id) ?? null;
    },
    put(collection, record) {
      if (!record || typeof record.id !== 'string' || !record.id) throw Object.assign(new Error('record.id is required'), { status: 400 });
      const list = state[collection] ?? [];
      const idx = list.findIndex((r) => r.id === record.id);
      state = { ...state, [collection]: idx >= 0 ? list.map((r, i) => (i === idx ? record : r)) : [...list, record] };
      persist();
      return { record, created: idx < 0 };
    },
    remove(collection, id) {
      const list = state[collection] ?? [];
      const next = list.filter((r) => r.id !== id);
      state = { ...state, [collection]: next };
      persist();
      return next.length !== list.length;
    },
  };
}
