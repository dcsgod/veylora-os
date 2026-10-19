import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, createDocument, createLayer } from '../src/model.mjs';
import { deserialize, serialize, validateDocument } from '../src/serialize.mjs';
import { createFromTemplate, TEMPLATES } from '../src/templates.mjs';

test('round trip preserves the document', () => {
  const doc = createFromTemplate('social-announcement');
  const r = deserialize(serialize(doc));
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc, doc);
});

test('every template is valid', () => {
  for (const t of TEMPLATES) assert.deepEqual(validateDocument(createFromTemplate(t.id)), [], t.id);
});

test('rejects malformed JSON and wrong version', () => {
  assert.deepEqual(deserialize('{nope'), { ok: false, errors: ['file is not valid JSON'] });
  const doc = { ...createDocument(), version: 99 };
  assert.match(deserialize(JSON.stringify(doc)).errors[0], /unsupported version/);
});

test('rejects unsafe content from untrusted files', () => {
  const bad = (patch, type = 'rect') => {
    const doc = addLayer(createDocument(), { ...createLayer(type), ...patch });
    return deserialize(JSON.stringify(doc));
  };
  assert.equal(bad({ fill: 'url(javascript:alert(1))' }).ok, false);
  assert.equal(bad({ src: 'https://example.com/tracker.png' }, 'image').ok, false);
  assert.equal(bad({ src: 'data:image/svg+xml;base64,PHN2Zz4=' }, 'image').ok, false);
  assert.equal(bad({ src: 'data:image/png;base64,iVBORw0KGgo=' }, 'image').ok, true);
  assert.equal(bad({ fontFamily: 'x;}</style><script>' }, 'text').ok, false);
  assert.equal(bad({ onclick: 'alert(1)' }).ok, false);
  assert.equal(bad({ x: Number.NaN }).ok, false);
});

test('rejects duplicate layer ids and unknown top-level keys', () => {
  const l = createLayer('rect');
  const doc = addLayer(addLayer(createDocument(), l), { ...l });
  assert.ok(validateDocument(doc).some((e) => e.includes('duplicated')));
  assert.ok(validateDocument({ ...createDocument(), script: 'x' }).includes('script is not allowed'));
});

test('serialize refuses to write invalid documents', () => {
  assert.throws(() => serialize({ ...createDocument(), width: -1 }), /invalid document/);
});
