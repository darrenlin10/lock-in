// Single functional rendering pipeline (design doc §4.2):
//
//   bundled or Gemini/uploaded desk background
//     + app-rendered paper, texture, border and shadow
//     + app-rendered deadline, task labels and checkboxes
//     → device-sized image → preview → export
//
// The paper is drawn at known coordinates, so text placement never depends on
// where an image model happened to put a sheet of paper.

import { computeSheetLayout } from '../layout.js';
import { deskTexture, drawAccessories, drawLighting, mulberry32 } from './backgrounds.js';

export const PAPERS = {
  white: { name: 'Crisp White Cardstock', fill: '#fbfbf8', ink: '#1b2230', muted: '#555d6b', accent: '#1f3a8a' },
  cream: { name: 'Warm Cream Stationery', fill: '#f6eedc', ink: '#2a2118', muted: '#62574a', accent: '#8a3b12' },
  legal: { name: 'Lined Legal Pad', fill: '#fbf3b4', ink: '#1b2230', muted: '#57584a', accent: '#1f3a8a' },
  dots: { name: 'Dot Grid', fill: '#fafaf6', ink: '#1b2230', muted: '#555d6b', accent: '#0f5e55' },
};

export const FONTS = {
  serif: { name: 'Classic serif', stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  sans: { name: 'Clean sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  mono: { name: 'Typewriter', stack: '"SF Mono", Menlo, Consolas, "Courier New", monospace' },
};

function makeMeasure(ctx, family) {
  const cache = new Map();
  return (text, size, weight = 400) => {
    const key = `${weight}|${size.toFixed(2)}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = `${weight} ${size}px ${family}`;
      w = ctx.measureText(text).width;
      cache.set(key, w);
    }
    return w;
  };
}

/** Draw `img` to cover w×h (centre crop), like CSS object-fit: cover. */
export function drawCover(ctx, img, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
}

function drawPaper(ctx, rect, paperKey, bodyPx, lighting, canvasW) {
  const p = PAPERS[paperKey] || PAPERS.white;
  const s = canvasW / 1000;
  const radius = Math.max(2, 5 * s);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.38)';
  ctx.shadowBlur = 36 * s;
  ctx.shadowOffsetY = 14 * s;
  ctx.shadowOffsetX = 4 * s;
  ctx.fillStyle = p.fill;
  roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.clip();

  // Subtle fibre texture.
  const rand = mulberry32(99);
  for (let i = 0; i < 900; i += 1) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(0,0,0,0.018)' : 'rgba(255,255,255,0.05)';
    const x = rect.x + rand() * rect.w;
    const y = rect.y + rand() * rect.h;
    ctx.fillRect(x, y, (1 + rand() * 3) * s, (0.6 + rand()) * s);
  }

  const pad = Math.round(Math.min(rect.w, rect.h) * 0.08);
  if (paperKey === 'legal') {
    // Binding strip, ruled lines, red margin.
    ctx.fillStyle = 'rgba(150,40,30,0.85)';
    ctx.fillRect(rect.x, rect.y, rect.w, Math.max(4, pad * 0.32));
    const spacing = bodyPx * 1.28;
    ctx.strokeStyle = 'rgba(70,120,190,0.32)';
    ctx.lineWidth = Math.max(1, 1.4 * s);
    for (let y = rect.y + pad * 1.2; y < rect.y + rect.h - 2; y += spacing) {
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(200,50,50,0.45)';
    const mx = rect.x + pad * 0.55;
    for (const dx of [0, 3.5 * s]) {
      ctx.beginPath();
      ctx.moveTo(mx + dx, rect.y);
      ctx.lineTo(mx + dx, rect.y + rect.h);
      ctx.stroke();
    }
  } else if (paperKey === 'dots') {
    const spacing = rect.w / 22;
    ctx.fillStyle = 'rgba(60,60,70,0.22)';
    const r = Math.max(1, 1.8 * s);
    for (let y = rect.y + spacing / 2; y < rect.y + rect.h; y += spacing) {
      for (let x = rect.x + spacing / 2; x < rect.x + rect.w; x += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Gentle shading so the sheet sits in the scene's light without hurting contrast.
  const shade = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
  if (lighting === 'evening') {
    shade.addColorStop(0, 'rgba(255,200,140,0.10)');
    shade.addColorStop(1, 'rgba(60,30,0,0.06)');
  } else {
    shade.addColorStop(0, 'rgba(255,255,255,0.08)');
    shade.addColorStop(1, 'rgba(0,0,0,0.04)');
  }
  ctx.fillStyle = shade;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();

  // Hairline edge.
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = Math.max(1, s);
  roundedRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, radius);
  ctx.stroke();
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawOps(ctx, ops, paperKey, family) {
  const p = PAPERS[paperKey] || PAPERS.white;
  const colors = { ink: p.ink, muted: p.muted, accent: p.accent };
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  for (const op of ops) {
    if (op.type === 'text') {
      ctx.font = `${op.weight} ${op.size}px ${family}`;
      ctx.fillStyle = colors[op.role] || p.ink;
      ctx.textAlign = op.align;
      ctx.fillText(op.text, op.x, op.y);
    } else if (op.type === 'checkbox') {
      ctx.strokeStyle = p.ink;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1.5, op.size * 0.09);
      roundedRect(ctx, op.x, op.y, op.size, op.size, op.size * 0.14);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (op.type === 'rule') {
      ctx.strokeStyle = p.muted;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = op.thickness;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y);
      ctx.lineTo(op.x2, op.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

/**
 * Render a complete wallpaper into `canvas` (resized to the device).
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {object} opts
 * @param {{w:number,h:number}} opts.size output pixels
 * @param {{x:number,y:number,w:number,h:number}} opts.rect paper rect as fractions
 * @param {object} opts.design { desk, paper, lighting, font, accessories }
 * @param {CanvasImageSource|null} opts.backgroundImage Gemini/uploaded scenery, or null for bundled
 * @param {object} opts.content sheet content (see layout.js)
 * @returns layout result (ops, warnings, bodyPx, …)
 */
export function renderWallpaper(canvas, { size, rect, design, backgroundImage, content }) {
  const { w, h } = size;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const paperRect = {
    x: Math.round(rect.x * w),
    y: Math.round(rect.y * h),
    w: Math.round(rect.w * w),
    h: Math.round(rect.h * h),
  };
  const family = (FONTS[design.font] || FONTS.serif).stack;
  const layout = computeSheetLayout({ rect: paperRect, canvas: { w, h }, content, measure: makeMeasure(ctx, family) });

  // 1. Background
  if (backgroundImage) {
    drawCover(ctx, backgroundImage, w, h);
  } else {
    ctx.drawImage(deskTexture(design.desk, w, h), 0, 0);
    drawAccessories(ctx, w, h, paperRect, design.accessories || {});
    drawLighting(ctx, w, h, design.lighting);
  }

  // 2. Paper
  drawPaper(ctx, paperRect, design.paper, layout.bodyPx, design.lighting, Math.min(w, h));

  // 3. Text and checkboxes
  drawOps(ctx, layout.ops, design.paper, family);

  return { ...layout, paperRect };
}
