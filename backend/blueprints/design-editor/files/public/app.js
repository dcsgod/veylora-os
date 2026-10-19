import {
  addLayer, alignLayers, boundsOf, createLayer, duplicateLayers, findLayer, hitTest, moveLayer, removeLayers,
  selectionBounds, snap, snapTargets, updateLayer, updateLayers,
} from '/src/model.mjs';
import { canRedo, canUndo, createHistory, endCoalesce, push, redo, undo } from '/src/history.mjs';
import { deserialize, serialize } from '/src/serialize.mjs';
import { layerToSvg, toSVG } from '/src/export.mjs';
import { createFromTemplate, TEMPLATES } from '/src/templates.mjs';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = $('#canvas');

const app = {
  history: createHistory(createFromTemplate('social-announcement')),
  selection: [],
  tool: 'select',
  zoom: 1,
  drag: null,
  savedSnapshot: null,
};
const doc = () => app.history.present;

function commit(next, coalesce = null) {
  app.history = push(app.history, next, { coalesce });
  app.selection = app.selection.filter((id) => findLayer(next, id));
  render();
}

function setStatus(text, isError = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

// ---------- rendering ----------
function render() {
  const d = doc();
  svg.setAttribute('viewBox', `0 0 ${d.width} ${d.height}`);
  svg.style.width = `${d.width * app.zoom}px`;
  svg.style.height = `${d.height * app.zoom}px`;
  const bg = $('#bg');
  bg.setAttribute('width', d.width);
  bg.setAttribute('height', d.height);
  bg.setAttribute('fill', d.background);
  // layerToSvg output is built from validated fields with XML escaping.
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVGNS}">${d.layers.map(layerToSvg).join('')}</svg>`, 'image/svg+xml');
  $('#content').replaceChildren(...[...parsed.documentElement.childNodes].map((n) => document.importNode(n, true)));
  renderOverlay();
  renderLayers();
  renderProps();
  $('#doc-name').value = d.name;
  $('#undo').disabled = !canUndo(app.history);
  $('#redo').disabled = !canRedo(app.history);
  $('#delete').disabled = $('#duplicate').disabled = app.selection.length === 0;
  for (const b of document.querySelectorAll('[data-align]')) b.disabled = app.selection.length === 0;
  $('#dirty').hidden = app.savedSnapshot === d;
  $('#zoom-level').textContent = `${Math.round(app.zoom * 100)}%`;
  document.body.dataset.layerCount = String(d.layers.length);
  document.body.dataset.selectionCount = String(app.selection.length);
}

function el(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function renderOverlay() {
  const overlay = $('#overlay');
  const nodes = [];
  const sw = 1 / app.zoom;
  for (const id of app.selection) {
    const l = findLayer(doc(), id);
    if (!l) continue;
    const b = boundsOf(l);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    nodes.push(el('rect', { x: b.x, y: b.y, width: Math.max(b.width, 1), height: Math.max(b.height, 1), class: 'sel-box', 'stroke-width': 1.5 * sw, transform: `rotate(${l.rotation} ${cx} ${cy})` }));
  }
  if (app.selection.length === 1) {
    const l = findLayer(doc(), app.selection[0]);
    if (l && !l.locked) {
      const b = boundsOf(l);
      const size = 10 * sw;
      for (const [hx, hy, h] of [[b.x, b.y, 'nw'], [b.x + b.width, b.y, 'ne'], [b.x, b.y + b.height, 'sw'], [b.x + b.width, b.y + b.height, 'se']]) {
        nodes.push(el('rect', { x: hx - size / 2, y: hy - size / 2, width: size, height: size, class: `handle handle-${h}`, 'data-handle': h, 'stroke-width': sw }));
      }
    }
  }
  overlay.replaceChildren(...nodes);
}

function renderGuides(xs = [], ys = []) {
  const d = doc();
  const sw = 1 / app.zoom;
  $('#guides').replaceChildren(
    ...xs.map((x) => el('line', { x1: x, y1: 0, x2: x, y2: d.height, class: 'guide', 'stroke-width': sw })),
    ...ys.map((y) => el('line', { x1: 0, y1: y, x2: d.width, y2: y, class: 'guide', 'stroke-width': sw })),
  );
}

function renderLayers() {
  const list = $('#layers');
  const items = [...doc().layers].reverse().map((l) => {
    const li = document.createElement('li');
    li.dataset.id = l.id;
    li.className = app.selection.includes(l.id) ? 'selected' : '';
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = `${l.name || l.type}`;
    const type = document.createElement('span');
    type.className = 'layer-type';
    type.textContent = l.type;
    const actions = document.createElement('span');
    actions.className = 'layer-actions';
    for (const [act, label, title] of [['visible', l.visible ? 'Hide' : 'Show', 'Toggle visibility'], ['locked', l.locked ? 'Unlock' : 'Lock', 'Toggle lock'], ['up', '↑', 'Bring forward'], ['down', '↓', 'Send backward']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = act;
      b.title = title;
      b.textContent = label;
      actions.append(b);
    }
    li.append(name, type, actions);
    return li;
  });
  list.replaceChildren(...items);
}

const FIELDS = {
  common: [['name', 'text', 'Name'], ['x', 'number', 'X'], ['y', 'number', 'Y'], ['width', 'number', 'Width'], ['height', 'number', 'Height'], ['rotation', 'number', 'Rotation'], ['opacity', 'range', 'Opacity']],
  rect: [['fill', 'color', 'Fill'], ['stroke', 'color', 'Stroke'], ['strokeWidth', 'number', 'Stroke width'], ['radius', 'number', 'Corner radius']],
  ellipse: [['fill', 'color', 'Fill'], ['stroke', 'color', 'Stroke'], ['strokeWidth', 'number', 'Stroke width']],
  text: [['text', 'textarea', 'Text'], ['fill', 'color', 'Colour'], ['fontSize', 'number', 'Font size'], ['fontWeight', 'select:100,200,300,400,500,600,700,800,900', 'Weight'], ['align', 'select:left,center,right', 'Align'], ['fontFamily', 'text', 'Font family']],
  line: [['stroke', 'color', 'Stroke'], ['strokeWidth', 'number', 'Stroke width']],
  image: [['fit', 'select:cover,contain,fill', 'Fit']],
  document: [['name', 'text', 'Name'], ['width', 'number', 'Width'], ['height', 'number', 'Height'], ['background', 'color', 'Background']],
};

function renderProps() {
  const form = $('#props');
  if (form.contains(document.activeElement) && form.dataset.target === (app.selection.length === 1 ? app.selection[0] : 'doc')) {
    return;
  }
  const single = app.selection.length === 1 ? findLayer(doc(), app.selection[0]) : null;
  const target = single ?? doc();
  form.dataset.target = single ? single.id : 'doc';
  $('#props-title').textContent = single ? `${single.type[0].toUpperCase()}${single.type.slice(1)}` : app.selection.length > 1 ? `${app.selection.length} layers` : 'Document';
  if (app.selection.length > 1) {
    form.replaceChildren();
    return;
  }
  const fields = single ? [...FIELDS.common, ...FIELDS[single.type]] : FIELDS.document;
  form.replaceChildren(...fields.map(([key, kind, label]) => {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    let input;
    if (kind === 'textarea') input = document.createElement('textarea');
    else if (kind.startsWith('select:')) {
      input = document.createElement('select');
      for (const v of kind.slice(7).split(',')) input.append(new Option(v, v));
    } else {
      input = document.createElement('input');
      input.type = kind;
      if (kind === 'range') Object.assign(input, { min: 0, max: 1, step: 0.01 });
      if (kind === 'number') input.step = 'any';
    }
    input.name = key;
    input.value = kind === 'color' ? toHex6(target[key]) : String(target[key] ?? '');
    wrap.append(input);
    return wrap;
  }));
}

function toHex6(c) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`;
  return '#000000';
}

// ---------- property edits ----------
$('#props').addEventListener('input', (e) => {
  const { name, value, type } = e.target;
  const isNum = type === 'number' || type === 'range' || name === 'fontWeight';
  const v = isNum ? Number(value) : value;
  if (isNum && !Number.isFinite(v)) return;
  const target = $('#props').dataset.target;
  try {
    if (target === 'doc') {
      const next = { ...doc(), [name]: v };
      if ((name === 'width' || name === 'height') && !(v >= 1 && v <= 20000)) return;
      commit(next, `doc-${name}`);
    } else {
      commit(updateLayer(doc(), target, { [name]: v }), `prop-${target}-${name}`);
    }
  } catch (err) {
    setStatus(err.message, true);
  }
});
$('#props').addEventListener('change', () => { app.history = endCoalesce(app.history); });
$('#doc-name').addEventListener('change', (e) => commit({ ...doc(), name: e.target.value.slice(0, 120) || 'Untitled design' }));

// ---------- pointer interactions ----------
function toDoc(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: p.x, y: p.y };
}

svg.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  svg.focus();
  svg.setPointerCapture(evt.pointerId);
  const p = toDoc(evt);
  const key = `drag-${Date.now()}`;
  if (app.tool !== 'select') {
    const layer = createLayer(app.tool, app.tool === 'line' ? { x: p.x, y: p.y, width: 0, height: 0 } : { x: p.x, y: p.y, width: 1, height: 1 });
    commit(addLayer(doc(), layer), key);
    app.selection = [layer.id];
    app.drag = { mode: 'create', id: layer.id, origin: p, key };
    return render();
  }
  const handle = evt.target.dataset?.handle;
  if (handle && app.selection.length === 1) {
    const l = findLayer(doc(), app.selection[0]);
    app.drag = { mode: 'resize', handle, id: l.id, start: { ...l }, origin: p, key };
    return;
  }
  const hit = hitTest(doc(), p.x, p.y);
  if (!hit) {
    app.selection = [];
    app.drag = null;
    return render();
  }
  if (evt.shiftKey) app.selection = app.selection.includes(hit) ? app.selection.filter((i) => i !== hit) : [...app.selection, hit];
  else if (!app.selection.includes(hit)) app.selection = [hit];
  const movable = app.selection.filter((id) => !findLayer(doc(), id).locked);
  app.drag = movable.length ? { mode: 'move', ids: movable, origin: p, starts: Object.fromEntries(movable.map((id) => [id, { ...findLayer(doc(), id) }])), key } : null;
  render();
});

svg.addEventListener('pointermove', (evt) => {
  if (!app.drag) return;
  const p = toDoc(evt);
  const d = app.drag;
  let dx = p.x - d.origin.x;
  let dy = p.y - d.origin.y;
  if (d.mode === 'create') {
    const l = findLayer(doc(), d.id);
    let w = dx;
    let h = dy;
    if (evt.shiftKey && l.type !== 'line') w = h = Math.max(Math.abs(dx), Math.abs(dy)) * Math.sign(dx || 1);
    const patch = l.type === 'line' ? { width: w, height: evt.shiftKey ? 0 : h } : { x: Math.min(d.origin.x, d.origin.x + w), y: Math.min(d.origin.y, d.origin.y + h), width: Math.abs(w), height: Math.abs(h) };
    commit(updateLayer(doc(), d.id, patch), d.key);
  } else if (d.mode === 'move') {
    const startDoc = { ...doc(), layers: doc().layers.map((l) => d.starts[l.id] ?? l) };
    const box = selectionBounds(startDoc, d.ids);
    const targets = snapTargets(doc(), d.ids);
    const guidesX = [];
    const guidesY = [];
    if (!evt.altKey) {
      for (const off of [0, box.width / 2, box.width]) {
        const s = snap(box.x + dx + off, targets.xs, 6 / app.zoom);
        if (s.guide !== null) { dx = s.value - box.x - off; guidesX.push(s.guide); break; }
      }
      for (const off of [0, box.height / 2, box.height]) {
        const s = snap(box.y + dy + off, targets.ys, 6 / app.zoom);
        if (s.guide !== null) { dy = s.value - box.y - off; guidesY.push(s.guide); break; }
      }
    }
    commit(updateLayers(doc(), d.ids, (l) => ({ x: d.starts[l.id].x + dx, y: d.starts[l.id].y + dy })), d.key);
    renderGuides(guidesX, guidesY);
  } else if (d.mode === 'resize') {
    const s = d.start;
    let { x, y, width, height } = s;
    if (d.handle.includes('e')) width = s.width + dx;
    if (d.handle.includes('s')) height = s.height + dy;
    if (d.handle.includes('w')) { x = s.x + dx; width = s.width - dx; }
    if (d.handle.includes('n')) { y = s.y + dy; height = s.height - dy; }
    if (evt.shiftKey && s.type !== 'line' && s.width && s.height) height = (width * s.height) / s.width;
    const patch = s.type === 'line' ? { x, y, width, height } : { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) };
    commit(updateLayer(doc(), d.id, patch), d.key);
  }
});

function endDrag() {
  if (!app.drag) return;
  if (app.drag.mode === 'create') {
    const l = findLayer(doc(), app.drag.id);
    if (l && l.type !== 'line' && l.width < 4 && l.height < 4) {
      const size = l.type === 'text' ? { width: 400, height: 60 } : { width: 200, height: 120 };
      commit(updateLayer(doc(), l.id, size), app.drag.key);
    }
    setTool('select');
  }
  app.drag = null;
  app.history = endCoalesce(app.history);
  renderGuides();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

// ---------- layers panel ----------
$('#layers').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = li.dataset.id;
  const action = e.target.dataset.action;
  const l = findLayer(doc(), id);
  if (action === 'visible') return commit(updateLayer(doc(), id, { visible: !l.visible }));
  if (action === 'locked') return commit(updateLayer(doc(), id, { locked: !l.locked }));
  if (action === 'up' || action === 'down') return commit(moveLayer(doc(), id, action));
  app.selection = e.shiftKey ? [...new Set([...app.selection, id])] : [id];
  render();
});

// ---------- commands ----------
function setTool(tool) {
  app.tool = tool;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  svg.classList.toggle('drawing', tool !== 'select');
}
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
for (const b of document.querySelectorAll('[data-align]')) b.addEventListener('click', () => commit(alignLayers(doc(), app.selection, b.dataset.align)));

const commands = {
  undo() { app.history = undo(app.history); app.selection = app.selection.filter((id) => findLayer(doc(), id)); render(); },
  redo() { app.history = redo(app.history); render(); },
  delete() { if (app.selection.length) { commit(removeLayers(doc(), app.selection)); app.selection = []; render(); } },
  duplicate() {
    if (!app.selection.length) return;
    const r = duplicateLayers(doc(), app.selection);
    app.selection = r.ids;
    commit(r.doc);
  },
  nudge(dx, dy) {
    const ids = app.selection.filter((id) => !findLayer(doc(), id).locked);
    if (ids.length) commit(updateLayers(doc(), ids, (l) => ({ x: l.x + dx, y: l.y + dy })), `nudge-${ids.join()}`);
  },
};
$('#undo').addEventListener('click', commands.undo);
$('#redo').addEventListener('click', commands.redo);
$('#delete').addEventListener('click', commands.delete);
$('#duplicate').addEventListener('click', commands.duplicate);

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea, select');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? commands.redo() : commands.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); commands.redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); commands.duplicate(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); commands.delete(); return; }
  if (e.key === 'Escape') { app.selection = []; setTool('select'); render(); return; }
  const step = e.shiftKey ? 10 : 1;
  const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (arrows[e.key]) { e.preventDefault(); commands.nudge(...arrows[e.key]); return; }
  const tools = { v: 'select', r: 'rect', o: 'ellipse', t: 'text', l: 'line' };
  if (!mod && tools[e.key.toLowerCase()]) setTool(tools[e.key.toLowerCase()]);
});
document.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow')) app.history = endCoalesce(app.history); });

// ---------- zoom ----------
function setZoom(z) { app.zoom = Math.min(8, Math.max(0.05, z)); render(); }
function fit() {
  const stage = $('#stage');
  setZoom(Math.min((stage.clientWidth - 64) / doc().width, (stage.clientHeight - 96) / doc().height));
}
$('#zoom-in').addEventListener('click', () => setZoom(app.zoom * 1.25));
$('#zoom-out').addEventListener('click', () => setZoom(app.zoom / 1.25));
$('#zoom-fit').addEventListener('click', fit);
$('#stage').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(app.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ---------- images ----------
$('#image-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return setStatus('Only PNG, JPEG, GIF and WebP images are supported.', true);
  if (file.size > 5 * 1024 * 1024) return setStatus('Images must be 5 MB or smaller.', true);
  const src = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, (doc().width * 0.6) / img.naturalWidth, (doc().height * 0.6) / img.naturalHeight);
  const layer = createLayer('image', { src, name: file.name.slice(0, 60), width: img.naturalWidth * scale, height: img.naturalHeight * scale, x: 40, y: 40 });
  commit(addLayer(doc(), layer));
  app.selection = [layer.id];
  render();
});

// ---------- persistence ----------
async function api(path, options) {
  const res = await fetch(`/api/${path}`, options);
  if (res.status === 204) return null;
  const body = await res.json();
  if (!res.ok) throw new Error(body.errors?.slice(0, 3).join('; ') ?? body.error ?? `request failed (${res.status})`);
  return body;
}

async function save() {
  try {
    await api(`designs/${doc().id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: serialize(doc()) });
    app.savedSnapshot = doc();
    setStatus(`Saved “${doc().name}”.`);
    await loadDesignList();
    render();
  } catch (err) { setStatus(`Save failed: ${err.message}`, true); }
}
$('#save').addEventListener('click', save);

async function loadDesignList() {
  const designs = await api('designs');
  $('#open-select').replaceChildren(new Option('Open…', ''), ...designs.map((d) => new Option(`${d.name} (${d.layers} layers)`, d.id)));
}

function loadDocument(next, saved = false) {
  app.history = createHistory(next);
  app.selection = [];
  app.savedSnapshot = saved ? next : null;
  fit();
}

$('#open-select').addEventListener('change', async (e) => {
  const id = e.target.value;
  e.target.value = '';
  if (!id) return;
  try {
    const r = deserialize(await api(`designs/${encodeURIComponent(id)}`));
    if (!r.ok) throw new Error(r.errors[0]);
    loadDocument(r.doc, true);
    setStatus(`Opened “${r.doc.name}”.`);
  } catch (err) { setStatus(`Open failed: ${err.message}`, true); }
});

$('#template-select').replaceChildren(new Option('New from template…', ''), ...TEMPLATES.map((t) => new Option(`${t.name} · ${t.width}×${t.height}`, t.id)));
$('#template-select').addEventListener('change', (e) => {
  if (!e.target.value) return;
  loadDocument(createFromTemplate(e.target.value));
  e.target.value = '';
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const r = deserialize(await file.text());
  if (!r.ok) return setStatus(`Import rejected: ${r.errors.slice(0, 3).join('; ')}`, true);
  loadDocument(r.doc);
  setStatus(`Imported “${r.doc.name}”.`);
});

// ---------- export ----------
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileBase = () => doc().name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'design';

$('#export-json').addEventListener('click', () => download(new Blob([serialize(doc())], { type: 'application/json' }), `${fileBase()}.json`));
$('#export-svg').addEventListener('click', () => {
  const text = toSVG(doc());
  document.body.dataset.lastExport = String(text.length);
  download(new Blob([text], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
});
$('#export-png').addEventListener('click', async () => {
  try {
    const url = URL.createObjectURL(new Blob([toSVG(doc())], { type: 'image/svg+xml' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = doc().width;
    canvas.height = doc().height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => download(blob, `${fileBase()}.png`), 'image/png');
  } catch (err) { setStatus(`PNG export failed: ${err.message}`, true); }
});

window.addEventListener('beforeunload', (e) => { if (app.savedSnapshot !== doc()) e.preventDefault(); });
window.addEventListener('resize', () => renderOverlay());

loadDesignList().catch((err) => setStatus(err.message, true));
fit();
document.body.dataset.ready = 'true';
