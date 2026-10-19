// Renders a document to a standalone SVG string. Text is XML-escaped; images must already be embedded data URLs.

import { boundsOf } from './model.mjs';
import { validateDocument } from './serialize.mjs';

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

const n = (v) => Math.round(v * 100) / 100;

function transform(layer) {
  if (!layer.rotation) return '';
  const b = boundsOf(layer);
  return ` transform="rotate(${n(layer.rotation)} ${n(b.x + b.width / 2)} ${n(b.y + b.height / 2)})"`;
}

function strokeAttrs(l) {
  return l.strokeWidth > 0 ? ` stroke="${escapeXml(l.stroke)}" stroke-width="${n(l.strokeWidth)}"` : '';
}

export function layerToSvg(l) {
  if (!l.visible) return '';
  const common = `${transform(l)}${l.opacity < 1 ? ` opacity="${n(l.opacity)}"` : ''} data-layer-id="${escapeXml(l.id)}"`;
  const b = boundsOf(l);
  switch (l.type) {
    case 'rect':
      return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(l.radius)}" fill="${escapeXml(l.fill)}"${strokeAttrs(l)}${common}/>`;
    case 'ellipse':
      return `<ellipse cx="${n(b.x + b.width / 2)}" cy="${n(b.y + b.height / 2)}" rx="${n(b.width / 2)}" ry="${n(b.height / 2)}" fill="${escapeXml(l.fill)}"${strokeAttrs(l)}${common}/>`;
    case 'line':
      return `<line x1="${n(l.x)}" y1="${n(l.y)}" x2="${n(l.x + l.width)}" y2="${n(l.y + l.height)}" stroke="${escapeXml(l.stroke)}" stroke-width="${n(l.strokeWidth)}" stroke-linecap="round"${common}/>`;
    case 'text': {
      const anchor = { left: 'start', center: 'middle', right: 'end' }[l.align];
      const x = l.align === 'center' ? b.x + b.width / 2 : l.align === 'right' ? b.x + b.width : b.x;
      const lines = String(l.text).split('\n');
      const lh = l.fontSize * 1.2;
      const spans = lines.map((t, i) => `<tspan x="${n(x)}" dy="${i === 0 ? n(l.fontSize) : n(lh)}">${escapeXml(t)}</tspan>`).join('');
      return `<text x="${n(x)}" y="${n(b.y)}" font-family="${escapeXml(l.fontFamily)}" font-size="${n(l.fontSize)}" font-weight="${n(l.fontWeight)}" fill="${escapeXml(l.fill)}" text-anchor="${anchor}"${common}>${spans}</text>`;
    }
    case 'image': {
      if (!l.src) return '';
      const par = { cover: 'xMidYMid slice', contain: 'xMidYMid meet', fill: 'none' }[l.fit];
      return `<image x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" preserveAspectRatio="${par}" href="${escapeXml(l.src)}"${common}/>`;
    }
    default:
      return '';
  }
}

export function toSVG(doc) {
  const errors = validateDocument(doc);
  if (errors.length) throw new Error(`cannot export invalid document: ${errors[0]}`);
  const body = doc.layers.map(layerToSvg).filter(Boolean).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">
  <title>${escapeXml(doc.name)}</title>
  <rect width="100%" height="100%" fill="${escapeXml(doc.background)}"/>
  ${body}
</svg>
`;
}
