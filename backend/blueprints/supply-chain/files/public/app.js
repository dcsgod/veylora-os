const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, options);
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `request failed (${res.status})`), { body });
  return body;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return node;
}

function fillTable(selector, rows, columns) {
  const tbody = $(`${selector} tbody`);
  tbody.replaceChildren(...rows.map((row) => el('tr', {}, ...columns.map((col) => {
    const value = typeof col.value === 'function' ? col.value(row) : row[col.value];
    const td = el('td', col.num ? { class: 'num' } : {});
    if (value instanceof Node) td.append(value);
    else td.textContent = value ?? '';
    return td;
  }))));
}

const state = { products: [], suppliers: [] };

async function loadSummary() {
  const s = await api('summary');
  $('#synthetic-badge').hidden = !s.synthetic;
  const cards = [
    ['Products', s.products], ['Locations', s.locations], ['Suppliers', s.suppliers],
    ['Open orders', s.openOrders], ['Reorders needed', s.reorderNeeded], ['High urgency', s.highUrgency],
  ];
  $('#summary').replaceChildren(...cards.map(([label, value]) => el('div', { class: 'metric' },
    el('span', { class: 'metric-label' }, label), el('span', { class: 'metric-value' }, value))));
}

async function loadInventory() {
  const [inventory, products] = await Promise.all([api('inventory'), api('products')]);
  state.products = products;
  const names = Object.fromEntries(products.map((p) => [p.sku, p.name]));
  fillTable('#inventory-table', inventory, [
    { value: 'sku' }, { value: (r) => names[r.sku] }, { value: 'locationId' },
    { value: (r) => fmt.format(r.onHand), num: true }, { value: (r) => fmt.format(r.onOrder), num: true },
  ]);
  const sku = $('#forecast-sku');
  const current = sku.value;
  sku.replaceChildren(...products.map((p) => el('option', { value: p.sku }, `${p.sku} · ${p.name}`)));
  if (current) sku.value = current;
}

function drawChart(history, forecast) {
  const svg = $('#forecast-chart');
  const W = 800; const H = 260; const pad = 28;
  const all = [...history, ...forecast];
  const max = Math.max(...all, 1);
  const x = (i) => pad + (i / Math.max(all.length - 1, 1)) * (W - pad * 2);
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const path = (values, offset) => values.map((v, i) => `${i ? 'L' : 'M'}${x(i + offset).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const nodes = [
    make('line', { x1: pad, y1: H - pad, x2: W - pad, y2: H - pad, class: 'axis' }),
    make('line', { x1: x(history.length - 1), y1: pad, x2: x(history.length - 1), y2: H - pad, class: 'divider' }),
    make('path', { d: path(history, 0), class: 'series-history' }),
    make('path', { d: path([history[history.length - 1], ...forecast], history.length - 1), class: 'series-forecast' }),
  ];
  const label = make('text', { x: pad, y: pad - 8, class: 'chart-label' });
  label.textContent = `max ${fmt.format(max)} units/week · solid = history, dashed = forecast`;
  nodes.push(label);
  svg.replaceChildren(...nodes);
}

async function loadForecast() {
  const form = new FormData($('#forecast-form'));
  const params = new URLSearchParams({ sku: form.get('sku') ?? '', method: form.get('method'), horizon: form.get('horizon') });
  const data = await api(`forecast?${params}`);
  drawChart(data.history, data.forecast);
  fillTable('#backtest-table', data.backtest, [
    { value: 'method' }, { value: (r) => fmt.format(r.mae), num: true },
    { value: (r) => (r.mape === null ? 'n/a' : fmt.format(r.mape)), num: true },
  ]);
  $('#forecast-note').textContent = data.note;
}

function urgencyPill(u) {
  return el('span', { class: `pill pill-${u}` }, u);
}

async function loadReplenishment() {
  const sl = new FormData($('#replenishment-form')).get('serviceLevel');
  const rows = await api(`replenishment?serviceLevel=${encodeURIComponent(sl)}`);
  rows.sort((a, b) => ['high', 'medium', 'low', 'none'].indexOf(a.urgency) - ['high', 'medium', 'low', 'none'].indexOf(b.urgency));
  fillTable('#replenishment-table', rows, [
    { value: 'sku' }, { value: 'locationId' }, { value: 'inventoryPosition', num: true }, { value: 'safetyStock', num: true },
    { value: 'reorderPoint', num: true }, { value: 'orderQty', num: true }, { value: (r) => money.format(r.orderValue), num: true },
    { value: (r) => urgencyPill(r.urgency) }, { value: 'reason' },
  ]);
}

function renderCapacity(target, rows) {
  target.replaceChildren(...rows.map((r) => el('div', { class: `cap cap-${r.status}`, 'data-location': r.locationId },
    el('div', { class: 'cap-head' }, el('strong', {}, r.name), el('span', {}, `${r.status}`)),
    el('div', { class: 'bar' }, Object.assign(el('div', { class: 'bar-fill' }), { style: `width:${Math.min(r.utilization, 100)}%` }),
      Object.assign(el('div', { class: 'bar-projected' }), { style: `width:${Math.min(r.projectedUtilization, 100)}%` })),
    el('div', { class: 'cap-meta' }, `${fmt.format(r.used)} / ${fmt.format(r.capacity)} m³ used (${r.utilization}%) · projected ${r.projectedUtilization}% with inbound`))));
}

async function loadCapacity() {
  renderCapacity($('#capacity-list'), await api('capacity'));
}

async function loadSuppliers() {
  state.suppliers = await api('suppliers');
  fillTable('#suppliers-table', state.suppliers, [
    { value: 'id' }, { value: 'name' }, { value: 'leadTimeDays', num: true }, { value: 'minOrderQty', num: true },
    { value: (r) => `${Math.round(r.reliability * 100)}%`, num: true },
  ]);
  const sel = $('#scenario-supplier');
  sel.replaceChildren(el('option', { value: '' }, 'None'), ...state.suppliers.map((s) => el('option', { value: s.id }, `${s.id} · ${s.name}`)));
}

async function loadScenarios() {
  const rows = await api('scenarios');
  fillTable('#scenarios-table', rows, [
    { value: 'name' }, { value: (r) => new Date(r.createdAt).toLocaleString() },
    { value: (r) => money.format(r.summary.baselineOrderValue), num: true },
    { value: (r) => money.format(r.summary.scenarioOrderValue), num: true }, { value: (r) => r.summary.highUrgency, num: true },
  ]);
}

function showError(target, err) {
  const details = err.body?.errors?.map((e) => (typeof e === 'string' ? e : `${JSON.stringify(e.record)}: ${e.errors.join('; ')}`)) ?? [];
  target.replaceChildren(el('div', { class: 'error' }, err.message), ...details.map((d) => el('div', { class: 'error-detail' }, d)));
}

$('#forecast-form').addEventListener('submit', (e) => { e.preventDefault(); loadForecast().catch(console.error); });
$('#replenishment-form').addEventListener('submit', (e) => { e.preventDefault(); loadReplenishment().catch(console.error); });

$('#ingest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const file = form.get('file');
  const out = $('#ingest-result');
  if (!file || !file.size) { out.textContent = 'Choose a CSV file first.'; return; }
  try {
    const result = await api(`ingest/${form.get('kind')}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await file.text() });
    out.replaceChildren(el('div', {}, `Imported ${result.applied} record(s); ${result.errors.length} rejected.`),
      ...result.errors.map((x) => el('div', { class: 'error-detail' }, `${x.row ? `row ${x.row}: ` : ''}${(x.errors ?? []).join('; ')}`)));
    await refresh();
  } catch (err) { showError(out, err); }
});

$('#supplier-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const out = $('#supplier-result');
  try {
    await api('suppliers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    out.textContent = `Saved ${body.id}.`;
    e.target.reset();
    await refresh();
  } catch (err) { showError(out, err); }
});

$('#scenario-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  const params = {
    demandMultiplier: Number(form.demandMultiplier),
    leadTimeDeltaDays: Number(form.leadTimeDeltaDays),
    serviceLevel: Number(form.serviceLevel),
  };
  if (form.disruptedSupplierId) params.disruptedSupplierId = form.disruptedSupplierId;
  const out = $('#scenario-result');
  try {
    const r = await api('scenarios', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.name, params }) });
    const delta = r.summary.scenarioOrderValue - r.summary.baselineOrderValue;
    const cap = el('div', { class: 'capacity' });
    renderCapacity(cap, r.capacity);
    out.replaceChildren(
      el('div', { class: 'scenario-summary', id: 'scenario-summary' },
        el('div', {}, `Baseline order value ${money.format(r.summary.baselineOrderValue)} (${r.summary.baselineOrders} orders)`),
        el('div', {}, `Scenario order value ${money.format(r.summary.scenarioOrderValue)} (${r.summary.scenarioOrders} orders)`),
        el('div', { class: delta > 0 ? 'up' : 'down' }, `Change ${money.format(delta)} · ${r.summary.highUrgency} high-urgency lines`)),
      cap,
    );
    await loadScenarios();
  } catch (err) { showError(out, err); }
});

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[data-tab]')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('[data-panel]')) p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
  });
}

async function refresh() {
  await Promise.all([loadSummary(), loadInventory(), loadSuppliers(), loadCapacity(), loadScenarios()]);
  await Promise.all([loadForecast(), loadReplenishment()]);
}

refresh().then(() => document.body.setAttribute('data-ready', 'true')).catch((err) => {
  document.body.setAttribute('data-ready', 'error');
  console.error(err);
});
