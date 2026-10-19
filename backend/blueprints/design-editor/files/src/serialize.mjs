// Strict document (de)serialisation. Loaded files are untrusted: only known fields, safe colours and embedded raster images are kept.

import { DOC_VERSION, LAYER_TYPES } from './model.mjs';

const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|none)$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LAYERS = 2000;
const MAX_IMAGE_CHARS = 8_000_000;

const NUM = (min, max) => ({ kind: 'number', min, max });
const FIELDS = {
  common: {
    id: { kind: 'id' }, type: { kind: 'enum', values: LAYER_TYPES }, name: { kind: 'string', max: 120 },
    x: NUM(-100000, 100000), y: NUM(-100000, 100000), width: NUM(-100000, 100000), height: NUM(-100000, 100000),
    rotation: NUM(-360, 360), opacity: NUM(0, 1), visible: { kind: 'bool' }, locked: { kind: 'bool' },
  },
  rect: { fill: { kind: 'color' }, stroke: { kind: 'color' }, strokeWidth: NUM(0, 1000), radius: NUM(0, 100000) },
  ellipse: { fill: { kind: 'color' }, stroke: { kind: 'color' }, strokeWidth: NUM(0, 1000) },
  text: {
    text: { kind: 'string', max: 10000 }, fill: { kind: 'color' }, fontSize: NUM(1, 2000),
    fontFamily: { kind: 'font' }, fontWeight: NUM(100, 900), align: { kind: 'enum', values: ['left', 'center', 'right'] },
  },
  line: { stroke: { kind: 'color' }, strokeWidth: NUM(0, 1000) },
  image: { src: { kind: 'image' }, fit: { kind: 'enum', values: ['cover', 'contain', 'fill'] } },
};

function check(name, spec, value, errors) {
  switch (spec.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) errors.push(`${name} must be a number in [${spec.min}, ${spec.max}]`);
      break;
    case 'string':
      if (typeof value !== 'string' || value.length > spec.max) errors.push(`${name} must be a string of at most ${spec.max} characters`);
      break;
    case 'bool':
      if (typeof value !== 'boolean') errors.push(`${name} must be a boolean`);
      break;
    case 'enum':
      if (!spec.values.includes(value)) errors.push(`${name} must be one of ${spec.values.join(', ')}`);
      break;
    case 'color':
      if (typeof value !== 'string' || !COLOR.test(value)) errors.push(`${name} must be a hex colour`);
      break;
    case 'font':
      if (typeof value !== 'string' || value.length > 200 || /[;{}<>"\\]/.test(value)) errors.push(`${name} is not a safe font family`);
      break;
    case 'id':
      if (typeof value !== 'string' || !ID.test(value)) errors.push(`${name} must be an identifier`);
      break;
    case 'image':
      if (typeof value !== 'string' || (value !== '' && (!DATA_IMAGE.test(value) || value.length > MAX_IMAGE_CHARS))) {
        errors.push(`${name} must be an embedded PNG, JPEG, GIF or WebP data URL`);
      }
      break;
    default:
      errors.push(`${name} has unknown kind`);
  }
}

export function validateLayer(layer, index = 0) {
  const errors = [];
  if (!layer || typeof layer !== 'object') return [`layers[${index}] must be an object`];
  if (!LAYER_TYPES.includes(layer.type)) return [`layers[${index}].type must be one of ${LAYER_TYPES.join(', ')}`];
  const spec = { ...FIELDS.common, ...FIELDS[layer.type] };
  for (const [name, s] of Object.entries(spec)) {
    if (!(name in layer)) errors.push(`layers[${index}].${name} is required`);
    else check(`layers[${index}].${name}`, s, layer[name], errors);
  }
  for (const key of Object.keys(layer)) if (!(key in spec)) errors.push(`layers[${index}].${key} is not allowed`);
  return errors;
}

export function validateDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['document must be an object'];
  if (doc.version !== DOC_VERSION) errors.push(`unsupported version ${doc.version}`);
  check('id', { kind: 'id' }, doc.id, errors);
  check('name', { kind: 'string', max: 120 }, doc.name, errors);
  check('width', NUM(1, 20000), doc.width, errors);
  check('height', NUM(1, 20000), doc.height, errors);
  check('background', { kind: 'color' }, doc.background, errors);
  if (!Array.isArray(doc.layers)) errors.push('layers must be an array');
  else if (doc.layers.length > MAX_LAYERS) errors.push(`at most ${MAX_LAYERS} layers are supported`);
  else {
    const ids = new Set();
    doc.layers.forEach((l, i) => {
      errors.push(...validateLayer(l, i));
      if (ids.has(l?.id)) errors.push(`layers[${i}].id is duplicated`);
      ids.add(l?.id);
    });
  }
  const allowed = new Set(['version', 'id', 'name', 'width', 'height', 'background', 'layers']);
  for (const key of Object.keys(doc)) if (!allowed.has(key)) errors.push(`${key} is not allowed`);
  return errors;
}

export function serialize(doc) {
  const errors = validateDocument(doc);
  if (errors.length) throw new Error(`invalid document: ${errors.slice(0, 5).join('; ')}`);
  return JSON.stringify(doc);
}

export function deserialize(text) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, errors: ['file is not valid JSON'] };
  }
  const errors = validateDocument(doc);
  return errors.length ? { ok: false, errors } : { ok: true, doc };
}
