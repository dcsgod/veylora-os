import { coerce, validate } from './domain.mjs';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function ingestCsv(kind, text, { maxRows = 10000 } = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { records: [], errors: [{ row: 0, errors: ['file is empty'] }] };
  const header = rows[0].map((h) => h.trim());
  if (rows.length - 1 > maxRows) return { records: [], errors: [{ row: 0, errors: [`more than ${maxRows} rows`] }] };
  const records = [];
  const errors = [];
  rows.slice(1).forEach((cells, idx) => {
    const raw = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    const record = coerce(kind, raw);
    const result = validate(kind, record);
    if (result.ok) records.push(record);
    else errors.push({ row: idx + 2, errors: result.errors });
  });
  return { records, errors };
}
