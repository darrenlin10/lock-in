// Deterministic sheet layout (design doc §3.2, §4.2).
//
// The compositor, not the image model, owns geometry: paper bounds, padding,
// font size, wrapping, maximum rows and overflow. This module turns content
// plus a paper rectangle into a list of draw operations.
//
// Readability rules:
// - Body text starts proportional to the paper width and may shrink only down
//   to a minimum readable size derived from the output's short side.
// - It never shrinks below that minimum. If content still doesn't fit, trailing
//   actions move into an overflow count ("+N more in your plan").
// - Labels wrap to at most two lines; anything longer is ellipsised and
//   reported as a warning so the user can write a shorter display label.
//
// Pure module: text measurement is injected, so it runs in Node tests.

export const MIN_BODY_FRACTION = 0.036; // of the canvas short side (phones, portrait)
// Computer screens are viewed with larger physical pixels and more distance per
// pixel, so a smaller fraction of the short side still gives ~12pt+ text.
export const MIN_BODY_FRACTION_LANDSCAPE = 0.022;
export const START_BODY_FRACTION = 0.06; // of the paper width
export const MAX_LABEL_LINES = 2;
const ELLIPSIS = '…';

/**
 * Greedy word wrap with hard breaks for over-long words and ellipsis truncation.
 * @returns {{lines: string[], truncated: boolean}}
 */
export function wrapText(text, maxWidth, size, weight, measure, maxLines = Infinity) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const fits = (s) => measure(s, size, weight) <= maxWidth;

  const pushWord = (word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      return;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (fits(word)) {
      line = word;
      return;
    }
    // Hard-break a single word that is wider than the line.
    let chunk = '';
    for (const ch of word) {
      if (fits(chunk + ch) || !chunk) chunk += ch;
      else {
        lines.push(chunk);
        chunk = ch;
      }
    }
    line = chunk;
  };

  for (const w of words) pushWord(w);
  if (line) lines.push(line);
  if (lines.length === 0) lines.push('');

  if (lines.length <= maxLines) return { lines, truncated: false };

  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]} ${lines[maxLines]}`;
  while (last.length > 0 && !fits(last + ELLIPSIS)) last = last.slice(0, -1);
  kept[maxLines - 1] = last.trimEnd() + ELLIPSIS;
  return { lines: kept, truncated: true };
}

function baselineFor(top, lineHeight, size) {
  return top + (lineHeight - size) / 2 + size * 0.8;
}

/**
 * Lay out one attempt at body size `b` with `itemCount` items.
 * Returns ops and the total height used.
 */
function layoutAttempt(input, b, itemCount) {
  const { rect, content, measure } = input;
  const pad = Math.round(Math.min(rect.w, rect.h) * 0.08);
  const left = rect.x + pad;
  const right = rect.x + rect.w - pad;
  const innerW = right - left;
  const ops = [];
  const warnings = [];
  let y = rect.y + pad;

  const textBlock = (text, size, weight, role, maxLines, lineHeightMul = 1.2, opts = {}) => {
    const lh = size * lineHeightMul;
    const indent = opts.indent || 0;
    const wrapped = wrapText(text, innerW - indent, size, weight, measure, maxLines);
    for (const ln of wrapped.lines) {
      ops.push({ type: 'text', text: ln, x: left + indent, y: baselineFor(y, lh, size), size, weight, role, align: 'left' });
      y += lh;
    }
    return wrapped;
  };

  // Eyebrow
  if (content.eyebrow) {
    textBlock(content.eyebrow.toUpperCase(), b * 0.6, 700, 'accent', 1);
    y += b * 0.3;
  }

  // Deadline title
  const title = textBlock(content.title || 'Untitled deadline', b * 1.25, 700, 'ink', 2, 1.18);
  if (title.truncated) warnings.push({ type: 'title-truncated' });
  y += b * 0.45;

  // Countdown
  if (content.unit) {
    let numSize = b * 3.2;
    const unitSize = b * 1.0;
    const gap = b * 0.35;
    const unitW = measure(content.unit, unitSize, 500);
    while (numSize > b * 1.5 && measure(content.big, numSize, 800) + gap + unitW > innerW) numSize *= 0.94;
    const numW = measure(content.big, numSize, 800);
    const lh = numSize * 1.0;
    const base = y + numSize * 0.85;
    ops.push({ type: 'text', text: content.big, x: left, y: base, size: numSize, weight: 800, role: 'accent', align: 'left' });
    ops.push({ type: 'text', text: content.unit, x: left + numW + gap, y: base, size: unitSize, weight: 500, role: 'ink', align: 'left' });
    y += lh;
  } else {
    let size = b * 2.0;
    while (size > b * 1.2 && measure(content.big, size, 800) > innerW) size *= 0.94;
    const lh = size * 1.1;
    ops.push({ type: 'text', text: content.big, x: left, y: baselineFor(y, lh, size), size, weight: 800, role: 'accent', align: 'left' });
    y += lh;
  }
  y += b * 0.3;

  // Absolute date (always shown, §3.2)
  textBlock(content.dateLine, b * 0.8, 500, 'ink', 2);
  y += b * 0.65;

  // Divider
  ops.push({ type: 'rule', x1: left, x2: right, y, thickness: Math.max(1, b * 0.05) });
  y += b * 0.7;

  // Actions
  if (content.sectionLabel) {
    textBlock(content.sectionLabel.toUpperCase(), b * 0.6, 700, 'accent', 1);
    y += b * 0.4;
  }

  const items = content.items.slice(0, itemCount);
  const cb = b * 0.82;
  const indent = cb + b * 0.55;
  if (items.length === 0 && content.emptyText) {
    textBlock(content.emptyText, b * 0.85, 400, 'muted', 2);
  }
  items.forEach((item, i) => {
    const lh = b * 1.28;
    ops.push({ type: 'checkbox', x: left, y: y + (lh - cb) / 2, size: cb });
    const wrapped = textBlock(item.label, b, 500, 'ink', MAX_LABEL_LINES, 1.28, { indent });
    if (wrapped.truncated) warnings.push({ type: 'label-truncated', id: item.id, label: item.label });
    if (item.sub) textBlock(item.sub, b * 0.68, 500, 'muted', 1, 1.3, { indent });
    if (i < items.length - 1) y += b * 0.5;
  });

  const hidden = (content.hiddenCount || 0) + (content.items.length - items.length);
  if (hidden > 0) {
    y += b * 0.45;
    textBlock(`+${hidden} more in your plan`, b * 0.7, 600, 'muted', 1, 1.3, { indent: items.length ? indent : 0 });
  }

  // Footer is anchored to the bottom of the paper.
  const footerSize = b * 0.55;
  const footerLh = footerSize * 1.2;
  const footerTop = rect.y + rect.h - pad - footerLh;
  const contentBottom = y + b * 0.5;
  if (content.footerLeft) {
    ops.push({ type: 'text', text: content.footerLeft, x: left, y: baselineFor(footerTop, footerLh, footerSize), size: footerSize, weight: 500, role: 'muted', align: 'left' });
  }
  if (content.footerRight) {
    ops.push({ type: 'text', text: content.footerRight, x: right, y: baselineFor(footerTop, footerLh, footerSize), size: footerSize, weight: 700, role: 'muted', align: 'right' });
  }

  return { ops, warnings, fits: contentBottom <= footerTop, hidden, shownItems: items.length, pad, innerW };
}

/**
 * Compute the full sheet layout.
 * @param {object} input
 * @param {{x:number,y:number,w:number,h:number}} input.rect paper rectangle (px)
 * @param {{w:number,h:number}} input.canvas output size (px)
 * @param {object} input.content text content (see app.js buildSheetContent)
 * @param {(text:string,size:number,weight:number)=>number} input.measure
 */
export function computeSheetLayout(input) {
  const shortSide = Math.min(input.canvas.w, input.canvas.h);
  const frac = input.canvas.w > input.canvas.h ? MIN_BODY_FRACTION_LANDSCAPE : MIN_BODY_FRACTION;
  const minBody = Math.round(shortSide * frac);
  let b = Math.min(input.rect.w * START_BODY_FRACTION, input.rect.h * 0.05);
  const warnings = [];
  if (b < minBody) {
    b = minBody;
    warnings.push({ type: 'paper-small' });
  }
  const total = input.content.items.length;

  // 1) Shrink text toward the minimum while keeping every selected item.
  let attempt = layoutAttempt(input, b, total);
  while (!attempt.fits && b > minBody) {
    b = Math.max(minBody, b * 0.95);
    attempt = layoutAttempt(input, b, total);
  }
  // 2) At the minimum size, move trailing items into the overflow count.
  let count = total;
  while (!attempt.fits && count > 0) {
    count -= 1;
    attempt = layoutAttempt(input, b, count);
  }
  if (!attempt.fits) warnings.push({ type: 'paper-too-short' });
  if (count < total) warnings.push({ type: 'items-overflowed', count: total - count });

  return {
    ops: attempt.ops,
    warnings: [...warnings, ...attempt.warnings],
    bodyPx: b,
    minBodyPx: minBody,
    shownItems: attempt.shownItems,
    hidden: attempt.hidden,
  };
}
