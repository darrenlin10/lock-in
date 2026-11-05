// Bundled desk backgrounds, drawn procedurally so the app works offline and
// without any AI access (design doc §4.3: "Bundle three usable backgrounds").
// Seeded randomness keeps every render of the same desk identical.

export const DESKS = {
  walnut: { name: 'Warm Walnut', prompt: 'warm walnut wood with visible natural grain' },
  black: { name: 'Matte Black Executive', prompt: 'matte black executive desk surface with a fine soft texture' },
  marble: { name: 'White Carrara Marble', prompt: 'white Carrara marble with soft grey veining' },
};

export const LIGHTING = {
  day: { name: 'Morning daylight', prompt: 'soft, even morning daylight from a nearby window' },
  evening: { name: 'Warm evening lamp', prompt: 'warm evening desk-lamp glow with gentle falloff' },
};

export const ACCESSORIES = {
  pen: { name: 'Fountain pen', prompt: 'a fountain pen' },
  cup: { name: 'Espresso cup', prompt: 'an espresso cup on a saucer' },
  plant: { name: 'Eucalyptus sprig', prompt: 'a small eucalyptus sprig' },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Offscreen canvas with a working 2D context (older Safari lacks one). */
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h);
      if (oc.getContext('2d')) return oc;
    } catch {
      /* fall through */
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function addNoise(ctx, w, h, amount, rand) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function drawWalnut(ctx, w, h, rand) {
  const s = Math.min(w, h) / 1000;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#5b3923');
  g.addColorStop(0.5, '#6a442a');
  g.addColorStop(1, '#4c2f1c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Grain runs along the long axis.
  const vertical = h >= w;
  const len = vertical ? h : w;
  const across = vertical ? w : h;

  // Broad figure bands.
  for (let i = 0; i < 14; i += 1) {
    const pos = rand() * across;
    const width = (40 + rand() * 160) * s;
    const band = vertical ? ctx.createLinearGradient(pos - width, 0, pos + width, 0) : ctx.createLinearGradient(0, pos - width, 0, pos + width);
    const tone = rand() > 0.5 ? '255,220,180' : '30,15,5';
    band.addColorStop(0, `rgba(${tone},0)`);
    band.addColorStop(0.5, `rgba(${tone},${0.05 + rand() * 0.06})`);
    band.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, w, h);
  }

  // Fine grain lines.
  const lines = Math.round(across / (3.2 * s));
  for (let i = 0; i < lines; i += 1) {
    const base = rand() * across;
    const amp = (4 + rand() * 22) * s;
    const freq = (0.6 + rand() * 1.6) / (len / 1000) / 1000;
    const phase = rand() * Math.PI * 2;
    const dark = rand() > 0.35;
    ctx.strokeStyle = dark ? `rgba(35,18,8,${0.05 + rand() * 0.13})` : `rgba(255,214,170,${0.03 + rand() * 0.07})`;
    ctx.lineWidth = (0.6 + rand() * 2.4) * s;
    ctx.beginPath();
    const step = 24 * s;
    for (let t = -step; t <= len + step; t += step) {
      const off = base + amp * Math.sin(t * freq * 6.283 + phase) + amp * 0.3 * Math.sin(t * freq * 17 + phase * 2);
      if (vertical) t === -step ? ctx.moveTo(off, t) : ctx.lineTo(off, t);
      else t === -step ? ctx.moveTo(t, off) : ctx.lineTo(t, off);
    }
    ctx.stroke();
  }
  addNoise(ctx, w, h, 14, rand);
}

function drawBlack(ctx, w, h, rand) {
  const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
  g.addColorStop(0, '#26272b');
  g.addColorStop(1, '#141518');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Very soft mottling.
  const s = Math.min(w, h) / 1000;
  for (let i = 0; i < 40; i += 1) {
    const x = rand() * w;
    const y = rand() * h;
    const r = (80 + rand() * 260) * s;
    const m = ctx.createRadialGradient(x, y, 0, x, y, r);
    m.addColorStop(0, `rgba(255,255,255,${0.012 + rand() * 0.02})`);
    m.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = m;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  addNoise(ctx, w, h, 10, rand);
}

function drawMarble(ctx, w, h, rand) {
  const s = Math.min(w, h) / 1000;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#f4f2ee');
  g.addColorStop(0.5, '#ebe8e3');
  g.addColorStop(1, '#f1efea');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Cloudy undertone.
  for (let i = 0; i < 30; i += 1) {
    const x = rand() * w;
    const y = rand() * h;
    const r = (120 + rand() * 300) * s;
    const m = ctx.createRadialGradient(x, y, 0, x, y, r);
    m.addColorStop(0, `rgba(170,168,165,${0.04 + rand() * 0.05})`);
    m.addColorStop(1, 'rgba(170,168,165,0)');
    ctx.fillStyle = m;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Veins: meandering random walks, drawn wide-and-faint then thin-and-darker.
  const veins = 9;
  for (let v = 0; v < veins; v += 1) {
    const pts = [];
    let x = rand() * w;
    let y = rand() > 0.5 ? -50 * s : rand() * h;
    let angle = Math.PI * (0.25 + rand() * 0.5);
    const steps = 60 + Math.floor(rand() * 60);
    for (let i = 0; i < steps; i += 1) {
      pts.push([x, y]);
      angle += (rand() - 0.5) * 0.6;
      const stepLen = (18 + rand() * 26) * s;
      x += Math.cos(angle) * stepLen;
      y += Math.sin(angle) * stepLen;
    }
    const strength = 0.4 + rand() * 0.6;
    for (const [width, alpha] of [
      [14, 0.035],
      [5, 0.08],
      [1.6, 0.22],
    ]) {
      ctx.strokeStyle = `rgba(110,110,115,${alpha * strength})`;
      ctx.lineWidth = width * s * (0.6 + rand() * 0.8);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
    }
    // Hairline branches.
    for (let b = 0; b < 3; b += 1) {
      const start = pts[Math.floor(rand() * pts.length)];
      let [bx, by] = start;
      let ba = rand() * Math.PI * 2;
      ctx.strokeStyle = `rgba(120,120,125,${0.12 * strength})`;
      ctx.lineWidth = 1.1 * s;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      for (let i = 0; i < 18; i += 1) {
        ba += (rand() - 0.5) * 0.9;
        bx += Math.cos(ba) * 14 * s;
        by += Math.sin(ba) * 14 * s;
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
  }
  addNoise(ctx, w, h, 6, rand);
}

const DRAWERS = { walnut: drawWalnut, black: drawBlack, marble: drawMarble };
const SEEDS = { walnut: 1031, black: 2207, marble: 4409 };

/**
 * Release a canvas's pixel memory now. iOS Safari counts every canvas
 * against a fixed budget (~384 MB) until it is garbage-collected, so canvases
 * we stop using are shrunk to 0×0 immediately.
 */
export function freeCanvas(c) {
  if (!c) return;
  try {
    c.width = 0;
    c.height = 0;
  } catch {
    /* ignore */
  }
}

// Only the texture in use is kept. Regenerating one takes ~100–300 ms, which
// is fine on a style change and keeps memory to a single full-size canvas.
let textureCache = { key: null, canvas: null };

/** Cached desk texture canvas for `desk` at w×h. */
export function deskTexture(desk, w, h) {
  const key = `${desk}|${w}|${h}`;
  if (textureCache.key === key && textureCache.canvas) return textureCache.canvas;
  freeCanvas(textureCache.canvas);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  (DRAWERS[desk] || drawWalnut)(ctx, w, h, mulberry32(SEEDS[desk] || 1));
  textureCache = { key, canvas: c };
  return c;
}

// ---- Accessories (vector, positioned relative to the paper so they stay outside it) ----

function drawPen(ctx, cx, cy, length, angle, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const r = 15 * s;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 18 * s;
  ctx.shadowOffsetX = 6 * s;
  ctx.shadowOffsetY = 10 * s;
  // Barrel
  const body = ctx.createLinearGradient(-r, 0, r, 0);
  body.addColorStop(0, '#0b0c10');
  body.addColorStop(0.45, '#3a3d48');
  body.addColorStop(0.55, '#24262e');
  body.addColorStop(1, '#07080b');
  ctx.fillStyle = body;
  roundRect(ctx, -r, -length / 2, r * 2, length * 0.78, r);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  // Gold band and clip
  ctx.fillStyle = '#c9a35a';
  ctx.fillRect(-r, -length / 2 + length * 0.3, r * 2, 5 * s);
  ctx.fillRect(-r * 0.25, -length / 2 + 8 * s, r * 0.5, length * 0.24);
  // Section + nib
  ctx.fillStyle = '#15161b';
  roundRect(ctx, -r * 0.8, -length / 2 + length * 0.78, r * 1.6, length * 0.1, r * 0.4);
  ctx.fill();
  const nib = ctx.createLinearGradient(-r, 0, r, 0);
  nib.addColorStop(0, '#a8823c');
  nib.addColorStop(0.5, '#f1d690');
  nib.addColorStop(1, '#a8823c');
  ctx.fillStyle = nib;
  ctx.beginPath();
  ctx.moveTo(-r * 0.7, -length / 2 + length * 0.88);
  ctx.lineTo(r * 0.7, -length / 2 + length * 0.88);
  ctx.lineTo(0, length / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,40,10,0.7)';
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.moveTo(0, -length / 2 + length * 0.9);
  ctx.lineTo(0, length / 2 - 4 * s);
  ctx.stroke();
  ctx.restore();
}

function drawCup(ctx, cx, cy, r, s) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 30 * s;
  ctx.shadowOffsetX = 8 * s;
  ctx.shadowOffsetY = 14 * s;
  // Saucer
  const saucer = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.2, cx, cy, r);
  saucer.addColorStop(0, '#ffffff');
  saucer.addColorStop(1, '#dcdad6');
  ctx.fillStyle = saucer;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
  ctx.stroke();
  // Handle
  ctx.fillStyle = '#f3f2ef';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-2.4);
  roundRect(ctx, r * 0.5, -r * 0.09, r * 0.34, r * 0.18, r * 0.09);
  ctx.fill();
  ctx.restore();
  // Cup rim + coffee
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 10 * s;
  ctx.fillStyle = '#fbfbfa';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const coffee = ctx.createRadialGradient(cx - r * 0.1, cy - r * 0.1, 0, cx, cy, r * 0.5);
  coffee.addColorStop(0, '#c08a55');
  coffee.addColorStop(0.55, '#7a4a25');
  coffee.addColorStop(1, '#3b200d');
  ctx.fillStyle = coffee;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.49, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSprig(ctx, x, y, length, angle, s, rand) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 12 * s;
  ctx.shadowOffsetX = 4 * s;
  ctx.shadowOffsetY = 8 * s;
  ctx.strokeStyle = '#6f7d6a';
  ctx.lineWidth = 4 * s;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(length * 0.1, -length * 0.5, 0, -length);
  ctx.stroke();
  for (let i = 1; i <= 7; i += 1) {
    const t = i / 8;
    const py = -length * t;
    const px = length * 0.1 * Math.sin(t * Math.PI) * 0.9;
    for (const side of [-1, 1]) {
      const leafR = (34 - i * 2.4) * s;
      ctx.fillStyle = rand() > 0.5 ? '#8ea68e' : '#7d977f';
      ctx.beginPath();
      ctx.ellipse(px + side * leafR * 0.95, py, leafR, leafR * 0.82, side * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw enabled accessories in the margins around `paper` (px rect), keeping
 * them outside the paper and away from the clock/shortcut bands.
 */
export function drawAccessories(ctx, w, h, paper, accessories) {
  const s = Math.min(w, h) / 1000;
  const rand = mulberry32(77);
  const gap = 14 * s;
  const leftMargin = paper.x;
  const rightMargin = w - (paper.x + paper.w);

  if (accessories.pen) {
    const length = Math.min(paper.h * 0.62, 620 * s);
    // Centre the pen in the left margin; if the margin is narrow it peeks in from the edge.
    if (w > h) {
      // Computer screens: lie the pen beside the paper and low, away from the
      // centred clock (macOS) at the top.
      drawPen(ctx, paper.x - gap - 70 * s, paper.y + paper.h * 0.62, length, 0.06, s);
    } else {
      const cx = Math.min(leftMargin - gap - 18 * s, leftMargin / 2 + 4 * s);
      drawPen(ctx, cx, paper.y + paper.h * 0.42, length, 0.06, s);
    }
  }
  if (accessories.cup) {
    const r = Math.min(150 * s, Math.max(70 * s, (rightMargin - gap) / 0.62));
    // Fully visible when the margin is wide; otherwise it peeks in from the edge.
    const cx = Math.max(paper.x + paper.w + gap + r, w - r - gap);
    drawCup(ctx, cx, paper.y + paper.h * 0.22, r, s);
  }
  if (accessories.plant) {
    const length = Math.min(paper.h * 0.42, 420 * s);
    const x = Math.max(w - rightMargin / 2, paper.x + paper.w + gap + 30 * s);
    drawSprig(ctx, x, paper.y + paper.h * 0.98, length, -0.08, s, rand);
  }
}

/** Lighting overlay for bundled desks. */
export function drawLighting(ctx, w, h, lighting) {
  if (lighting === 'evening') {
    const glow = ctx.createRadialGradient(w * 0.95, h * 0.05, 0, w * 0.95, h * 0.05, Math.max(w, h) * 0.9);
    glow.addColorStop(0, 'rgba(255,176,88,0.30)');
    glow.addColorStop(0.5, 'rgba(255,150,60,0.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const vig = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.3, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(10,5,0,0)');
    vig.addColorStop(1, 'rgba(10,5,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  } else {
    const light = ctx.createLinearGradient(0, 0, w, h);
    light.addColorStop(0, 'rgba(255,252,245,0.14)');
    light.addColorStop(0.6, 'rgba(255,255,255,0)');
    light.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, w, h);
  }
}
