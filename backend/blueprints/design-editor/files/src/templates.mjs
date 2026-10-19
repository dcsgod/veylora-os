// Original starter templates. No third-party branding or assets.

import { createDocument, createLayer } from './model.mjs';

export const TEMPLATES = [
  { id: 'blank-square', name: 'Blank square', width: 1080, height: 1080 },
  { id: 'social-announcement', name: 'Social announcement', width: 1080, height: 1080 },
  { id: 'presentation-title', name: 'Presentation title slide', width: 1920, height: 1080 },
  { id: 'event-poster', name: 'Event poster', width: 1240, height: 1754 },
];

const BUILDERS = {
  'blank-square': () => [],
  'social-announcement': () => [
    createLayer('rect', { name: 'Backdrop', x: 0, y: 0, width: 1080, height: 1080, fill: '#1f2a3a' }),
    createLayer('ellipse', { name: 'Accent circle', x: 640, y: -120, width: 600, height: 600, fill: '#3a6fd8', opacity: 0.85 }),
    createLayer('text', { name: 'Headline', text: 'Something new\nis coming', x: 80, y: 560, width: 900, height: 240, fontSize: 96, fill: '#ffffff', fontWeight: 700 }),
    createLayer('line', { name: 'Rule', x: 80, y: 860, width: 240, height: 0, stroke: '#e2a03f', strokeWidth: 8 }),
    createLayer('text', { name: 'Detail', text: 'Launching 12 June', x: 80, y: 900, width: 900, height: 60, fontSize: 40, fill: '#c9d3e0', fontWeight: 400 }),
  ],
  'presentation-title': () => [
    createLayer('rect', { name: 'Side band', x: 0, y: 0, width: 120, height: 1080, fill: '#3a6fd8' }),
    createLayer('text', { name: 'Title', text: 'Quarterly review', x: 240, y: 380, width: 1500, height: 140, fontSize: 120, fontWeight: 700 }),
    createLayer('text', { name: 'Subtitle', text: 'Operations and planning', x: 240, y: 560, width: 1500, height: 70, fontSize: 56, fontWeight: 400, fill: '#5d6773' }),
  ],
  'event-poster': () => [
    createLayer('rect', { name: 'Backdrop', x: 0, y: 0, width: 1240, height: 1754, fill: '#f3efe6' }),
    createLayer('rect', { name: 'Panel', x: 100, y: 100, width: 1040, height: 1000, fill: '#e2a03f', radius: 24 }),
    createLayer('text', { name: 'Event', text: 'Community\nDesign Day', x: 160, y: 1180, width: 920, height: 300, fontSize: 120, fontWeight: 800, fill: '#1d2228' }),
    createLayer('text', { name: 'Date', text: 'Saturday · 10:00 – 16:00', x: 160, y: 1540, width: 920, height: 60, fontSize: 48, fontWeight: 500, fill: '#3a4450' }),
  ],
};

export function createFromTemplate(id) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) throw new Error(`unknown template ${id}`);
  return createDocument({ name: tpl.name, width: tpl.width, height: tpl.height, layers: BUILDERS[id]() });
}
