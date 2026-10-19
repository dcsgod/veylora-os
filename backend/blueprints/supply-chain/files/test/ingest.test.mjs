import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ingestCsv, parseCsv } from '../src/ingest.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('parses quoted fields, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('rejects unterminated quotes', () => {
  assert.throws(() => parseCsv('a\n"oops'), /unterminated/);
});

test('product fixture: valid rows accepted, invalid row reported with row number', () => {
  const { records, errors } = ingestCsv('product', fixture('products.csv'));
  assert.equal(records.length, 2);
  assert.equal(records[1].name, 'Cable, shielded 2m');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 4);
  assert.ok(errors[0].errors.includes('unitCost must be a number'));
});

test('inventory fixture rejects negative quantities', () => {
  const { records, errors } = ingestCsv('inventory', fixture('inventory.csv'));
  assert.equal(records.length, 2);
  assert.deepEqual(errors, [{ row: 4, errors: ['onHand must be >= 0'] }]);
});

test('empty file and row limit', () => {
  assert.equal(ingestCsv('product', '').errors[0].errors[0], 'file is empty');
  const big = `sku,locationId,onHand,onOrder\n${'A,B,1,0\n'.repeat(5)}`;
  assert.match(ingestCsv('inventory', big, { maxRows: 3 }).errors[0].errors[0], /more than 3 rows/);
});
