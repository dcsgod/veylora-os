import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from './serialize.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createDesignStore(dataDir) {
  const dir = join(dataDir, 'designs');
  mkdirSync(dir, { recursive: true });
  const file = (id) => {
    if (!ID.test(id)) throw Object.assign(new Error('invalid design id'), { status: 400 });
    return join(dir, `${id}.json`);
  };
  return {
    list() {
      return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        return { id: doc.id, name: doc.name, width: doc.width, height: doc.height, layers: doc.layers.length, updatedAt: doc.updatedAt };
      }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    get(id) {
      const f = file(id);
      if (!existsSync(f)) return null;
      const { updatedAt, ...doc } = JSON.parse(readFileSync(f, 'utf8'));
      return doc;
    },
    save(id, raw) {
      const result = deserialize(raw);
      if (!result.ok) return result;
      if (result.doc.id !== id) return { ok: false, errors: ['document id does not match URL'] };
      const f = file(id);
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...JSON.parse(serialize(result.doc)), updatedAt: new Date().toISOString() }));
      renameSync(tmp, f);
      return { ok: true, id };
    },
    remove(id) {
      const f = file(id);
      if (!existsSync(f)) return false;
      rmSync(f);
      return true;
    },
  };
}
