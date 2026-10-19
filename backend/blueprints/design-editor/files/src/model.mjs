// Document model for a layered 2D design. All operations are pure and return a new document.

export const LAYER_TYPES = ['rect', 'ellipse', 'text', 'line', 'image'];
export const DOC_VERSION = 1;

const DEFAULTS = {
  common: { x: 0, y: 0, width: 200, height: 120, rotation: 0, opacity: 1, visible: true, locked: false, name: '' },
  rect: { fill: '#3a6fd8', stroke: '#000000', strokeWidth: 0, radius: 0 },
  ellipse: { fill: '#e2a03f', stroke: '#000000', strokeWidth: 0 },
  text: { text: 'Text', fill: '#1d2228', fontSize: 48, fontFamily: 'Inter, Segoe UI, Helvetica, Arial, sans-serif', fontWeight: 600, align: 'left', height: 60 },
  line: { stroke: '#1d2228', strokeWidth: 4, height: 0 },
  image: { src: '', fit: 'cover' },
};

export function newId() {
  return globalThis.crypto.randomUUID().slice(0, 12);
}

export function createDocument({ name = 'Untitled design', width = 1080, height = 1080, background = '#ffffff', layers = [] } = {}) {
  return { version: DOC_VERSION, id: newId(), name, width, height, background, layers };
}

export function createLayer(type, props = {}) {
  if (!LAYER_TYPES.includes(type)) throw new Error(`unknown layer type ${type}`);
  const layer = { id: newId(), type, ...DEFAULTS.common, ...DEFAULTS[type], ...props };
  if (!layer.name) layer.name = type === 'text' ? String(layer.text).slice(0, 24) : type;
  return layer;
}

export function findLayer(doc, id) {
  return doc.layers.find((l) => l.id === id);
}

export function addLayer(doc, layer, index = doc.layers.length) {
  const layers = [...doc.layers];
  layers.splice(Math.max(0, Math.min(index, layers.length)), 0, layer);
  return { ...doc, layers };
}

export function updateLayer(doc, id, patch) {
  let found = false;
  const layers = doc.layers.map((l) => {
    if (l.id !== id) return l;
    found = true;
    const next = { ...l, ...patch, id: l.id, type: l.type };
    if (next.type !== 'line') {
      next.width = Math.max(1, next.width);
      next.height = Math.max(1, next.height);
    }
    next.opacity = clamp(next.opacity, 0, 1);
    return next;
  });
  if (!found) throw new Error(`layer ${id} not found`);
  return { ...doc, layers };
}

export function updateLayers(doc, ids, patchFn) {
  return ids.reduce((d, id) => updateLayer(d, id, patchFn(findLayer(d, id))), doc);
}

export function removeLayers(doc, ids) {
  const set = new Set(ids);
  return { ...doc, layers: doc.layers.filter((l) => !set.has(l.id)) };
}

export function moveLayer(doc, id, direction) {
  const layers = [...doc.layers];
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error(`layer ${id} not found`);
  const [layer] = layers.splice(idx, 1);
  const target = { up: idx + 1, down: idx - 1, top: layers.length, bottom: 0 }[direction];
  if (target === undefined) throw new Error(`unknown direction ${direction}`);
  layers.splice(clamp(target, 0, layers.length), 0, layer);
  return { ...doc, layers };
}

export function duplicateLayers(doc, ids, offset = 16) {
  let next = doc;
  const created = [];
  for (const id of ids) {
    const src = findLayer(doc, id);
    if (!src) continue;
    const copy = { ...src, id: newId(), x: src.x + offset, y: src.y + offset, name: `${src.name} copy` };
    next = addLayer(next, copy, next.layers.findIndex((l) => l.id === id) + 1);
    created.push(copy.id);
  }
  return { doc: next, ids: created };
}

export function boundsOf(layer) {
  const x1 = Math.min(layer.x, layer.x + layer.width);
  const y1 = Math.min(layer.y, layer.y + layer.height);
  return { x: x1, y: y1, width: Math.abs(layer.width), height: Math.abs(layer.height) };
}

export function selectionBounds(doc, ids) {
  const boxes = ids.map((id) => findLayer(doc, id)).filter(Boolean).map(boundsOf);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.width));
  const btm = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: r - x, height: btm - y };
}

// Single layer aligns to the canvas; multiple layers align to the selection bounds.
export function alignLayers(doc, ids, edge) {
  const frame = ids.length === 1 ? { x: 0, y: 0, width: doc.width, height: doc.height } : selectionBounds(doc, ids);
  if (!frame) return doc;
  return updateLayers(doc, ids, (l) => {
    const b = boundsOf(l);
    const dx = l.x - b.x;
    const dy = l.y - b.y;
    switch (edge) {
      case 'left': return { x: frame.x + dx };
      case 'center': return { x: frame.x + (frame.width - b.width) / 2 + dx };
      case 'right': return { x: frame.x + frame.width - b.width + dx };
      case 'top': return { y: frame.y + dy };
      case 'middle': return { y: frame.y + (frame.height - b.height) / 2 + dy };
      case 'bottom': return { y: frame.y + frame.height - b.height + dy };
      default: throw new Error(`unknown alignment ${edge}`);
    }
  });
}

export function hitTest(doc, px, py, tolerance = 4) {
  for (let i = doc.layers.length - 1; i >= 0; i -= 1) {
    const l = doc.layers[i];
    if (!l.visible) continue;
    const b = boundsOf(l);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const rad = (-(l.rotation ?? 0) * Math.PI) / 180;
    const lx = cx + (px - cx) * Math.cos(rad) - (py - cy) * Math.sin(rad);
    const ly = cy + (px - cx) * Math.sin(rad) + (py - cy) * Math.cos(rad);
    if (l.type === 'line') {
      if (distanceToSegment(lx, ly, l.x, l.y, l.x + l.width, l.y + l.height) <= Math.max(tolerance, l.strokeWidth / 2)) return l.id;
    } else if (l.type === 'ellipse') {
      const rx = b.width / 2;
      const ry = b.height / 2;
      if (((lx - cx) / rx) ** 2 + ((ly - cy) / ry) ** 2 <= 1) return l.id;
    } else if (lx >= b.x && lx <= b.x + b.width && ly >= b.y && ly <= b.y + b.height) {
      return l.id;
    }
  }
  return null;
}

// Snaps a value to the nearest target within threshold; returns the snapped value and the guide used.
export function snap(value, targets, threshold = 6) {
  let best = null;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= threshold && (best === null || d < Math.abs(best - value))) best = t;
  }
  return best === null ? { value, guide: null } : { value: best, guide: best };
}

export function snapTargets(doc, excludeIds = []) {
  const ex = new Set(excludeIds);
  const xs = [0, doc.width / 2, doc.width];
  const ys = [0, doc.height / 2, doc.height];
  for (const l of doc.layers) {
    if (ex.has(l.id) || !l.visible) continue;
    const b = boundsOf(l);
    xs.push(b.x, b.x + b.width / 2, b.x + b.width);
    ys.push(b.y, b.y + b.height / 2, b.y + b.height);
  }
  return { xs, ys };
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / len, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
