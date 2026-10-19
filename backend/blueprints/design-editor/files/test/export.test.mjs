import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, createDocument, createLayer } from '../src/model.mjs';
import { escapeXml, toSVG } from '../src/export.mjs';
import { createFromTemplate } from '../src/templates.mjs';

test('escapes XML special characters', () => {
  assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
});

test('exports every layer type', () => {
  let doc = createDocument({ width: 500, height: 400, background: '#fafafa' });
  doc = addLayer(doc, createLayer('rect', { x: 1, y: 2, width: 30, height: 40, radius: 4, strokeWidth: 2 }));
  doc = addLayer(doc, createLayer('ellipse', { x: 100, y: 100, width: 50, height: 20 }));
  doc = addLayer(doc, createLayer('line', { x: 0, y: 0, width: 100, height: 0 }));
  doc = addLayer(doc, createLayer('text', { text: 'Line one\nLine <two>', align: 'center', width: 200 }));
  doc = addLayer(doc, createLayer('image', { src: 'data:image/png;base64,iVBORw0KGgo=' }));
  const svg = toSVG(doc);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="500" height="400"/);
  assert.match(svg, /<rect x="1" y="2" width="30" height="40" rx="4"/);
  assert.match(svg, /stroke-width="2"/);
  assert.match(svg, /<ellipse cx="125" cy="110" rx="25" ry="10"/);
  assert.match(svg, /<line x1="0" y1="0" x2="100" y2="0"/);
  assert.match(svg, /text-anchor="middle"/);
  assert.match(svg, /Line &lt;two&gt;/);
  assert.equal((svg.match(/<tspan/g) ?? []).length, 2);
  assert.match(svg, /<image [^>]*href="data:image\/png;base64,/);
});

test('hidden layers are omitted and rotation is applied about the centre', () => {
  let doc = createDocument();
  doc = addLayer(doc, createLayer('rect', { x: 0, y: 0, width: 100, height: 100, rotation: 45 }));
  doc = addLayer(doc, createLayer('ellipse', { visible: false }));
  const svg = toSVG(doc);
  assert.match(svg, /transform="rotate\(45 50 50\)"/);
  assert.doesNotMatch(svg, /<ellipse/);
});

test('template exports are well-formed enough to count elements', () => {
  const svg = toSVG(createFromTemplate('event-poster'));
  assert.equal((svg.match(/data-layer-id=/g) ?? []).length, 4);
});

test('refuses to export invalid documents', () => {
  assert.throws(() => toSVG({ ...createDocument(), background: 'red;evil' }), /cannot export/);
});
