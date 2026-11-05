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
// - Nothing is ever placed outside the paper. If the paper is too small even
//   for the header, lower-priority lines are dropped and a warning is raised.
//
// Pure module: text measurement is injected, so it runs in Node tests.

export const MIN_BODY_FRACTION = 0.036; // of the canvas short side (phones, portrait)
// Computer screens are viewed with larger physical pixels and more distance per
// pixel, so a smaller fraction of the short side still gives ~12pt+ text.
export const MIN_BODY_FRACTION_LANDSCAPE = 0.022;
export const START_BODY_FRACTION = 0.06; // of the paper width
export const MAX_LABEL_LINES = 2;
const ELLIPSIS = '…';

// Split into user-perceived characters so emoji (incl. ZWJ sequences and
// flags) and combining marks are never cut in half.
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function graphemes(s) {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** Longest prefix (in graphemes) of `chars` that fits; at least one grapheme. */
function fittingPrefix(chars, fits, suffix = '') {
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join('') + suffix)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Greedy word wrap with hard breaks for over-long words and ellipsis truncation.
 * @returns {{lines: string[], truncated: boolean}}
 */
export function wrapText(text, maxWidth, size, weight, measure, maxLines = Infinity) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const fits = (s) => measure(s, size, weight) <= maxWidth;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (fits(word)) {
      line = word;
      continue;
    }
    // Hard-break a word wider than the line (binary search per line).
    let rest = graphemes(word);
    // Stop once we know the text must be truncated: only maxLines are kept.
    while (rest.length && lines.length <= maxLines + 1) {
      const n = Math.max(1, fittingPrefix(rest, fits));
      const chunk = rest.slice(0, n).join('');
      rest = rest.slice(n);
      if (rest.length) lines.push(chunk);
      else line = chunk;
    }
    if (lines.length > maxLines + 1) break; // enough to know we must truncate
  }
  if (line) lines.push(line);
  if (lines.length === 0) lines.push('');

  if (lines.length <= maxLines) return { lines, truncated: false };

  const kept = lines.slice(0, maxLines);
  const tail = graphemes(`${kept[maxLines - 1]} ${lines[maxLines]}`);
  const n = fittingPrefix(tail, fits, ELLIPSIS);
  kept[maxLines - 1] = tail.slice(0, n).join('').trimEnd() + ELLIPSIS;
  return { lines: kept, truncated: true };
}

function baselineFor(top, lineHeight, size) {
  return top + (lineHeight - size) / 2 + size * 0.8;
}

/**
 * Lay out one attempt at body size `b` with `itemCount` items.
 * Returns ops and whether everything fits above the footer.
 */
function layoutAttempt(input, b, itemCount) {
  const { rect, content, measure } = input;
  const pad = Math.round(Math.min(rect.w, rect.h) * 0.08);
  const left = rect.x + pad;
  const right = rect.x + rect.w - pad;
  const innerW = Math.max(1, right - left);
  const ops = [];
  const warnings = [];
  let y = rect.y + pad;

  // Each op records its top/bottom so overflowing lines can be dropped later.
  const pushText = (text, x, top, lh, size, weight, role, align = 'left') => {
    ops.push({ type: 'text', text, x, y: baselineFor(top, lh, size), size, weight, role, align, top, bottom: top + lh });
  };
  const textBlock = (text, size, weight, role, maxLines, lineHeightMul = 1.2, opts = {}) => {
    const lh = size * lineHeightMul;
    const indent = opts.indent || 0;
    const wrapped = wrapText(text, innerW - indent, size, weight, measure, maxLines);
    for (const ln of wrapped.lines) {
      pushText(ln, left + indent, y, lh, size, weight, role);
      y += lh;
    }
    return wrapped;
  };

  // Footer first: it is anchored to the bottom and must never collide.
  // The "As of" date is required (§3.2); the brand mark is optional.
  const footerSize = b * 0.55;
  const footerLh = footerSize * 1.2;
  let footerLines = [];
  let showBrand = false;
  if (content.footerLeft) {
    const brandW = content.footerRight ? measure(content.footerRight, footerSize, 700) : 0;
    const leftW = measure(content.footerLeft, footerSize, 500);
    showBrand = Boolean(content.footerRight) && leftW + footerSize * 1.5 + brandW <= innerW;
    footerLines = wrapText(content.footerLeft, innerW, footerSize, 500, measure, 2).lines;
  }
  const footerTop = rect.y + rect.h - pad - footerLh * Math.max(1, footerLines.length);
  footerLines.forEach((ln, i) => pushText(ln, left, footerTop + i * footerLh, footerLh, footerSize, 500, 'muted'));
  if (showBrand) pushText(content.footerRight, right, footerTop + (footerLines.length - 1) * footerLh, footerLh, footerSize, 700, 'muted', 'right');

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
    while (numSize > b && measure(content.big, numSize, 800) > innerW) numSize *= 0.94;
    const numW = measure(content.big, numSize, 800);
    const top = y;
    pushText(content.big, left, top, numSize, numSize, 800, 'accent');
    // Drop the ascent fudge from baselineFor so the number sits like before.
    ops[ops.length - 1].y = top + numSize * 0.85;
    if (numW + gap + unitW <= innerW) {
      ops.push({ type: 'text', text: content.unit, x: left + numW + gap, y: top + numSize * 0.85, size: unitSize, weight: 500, role: 'ink', align: 'left', top, bottom: top + numSize });
      y += numSize;
    } else {
      // Not enough room beside the number: put "days left" underneath.
      y += numSize * 1.02;
      textBlock(content.unit, unitSize, 500, 'ink', 2);
    }
  } else {
    let size = b * 2.0;
    while (size > b && measure(content.big, size, 800) > innerW) size *= 0.94;
    textBlock(content.big, size, 800, 'accent', 2, 1.1);
  }
  y += b * 0.3;

  // Absolute date (always shown, §3.2)
  textBlock(content.dateLine, b * 0.8, 500, 'ink', 2);
  y += b * 0.65;

  // Divider
  ops.push({ type: 'rule', x1: left, x2: right, y, thickness: Math.max(1, b * 0.05), top: y, bottom: y });
  y += b * 0.7;

  // Actions
  if (content.sectionLabel) {
    textBlock(content.sectionLabel.toUpperCase(), b * 0.6, 700, 'accent', 1);
    y += b * 0.4;
  }

  const items = content.items.slice(0, itemCount);
  const cb = b * 0.82;
  const indent = Math.min(cb + b * 0.55, innerW * 0.4);
  // Only say "no open actions" when there really are none (not when they
  // were all moved into the overflow count).
  if (content.items.length === 0 && !content.hiddenCount && content.emptyText) {
    textBlock(content.emptyText, b * 0.85, 400, 'muted', 2);
  }
  items.forEach((item, i) => {
    const lh = b * 1.28;
    const top = y;
    const wrapped = textBlock(item.label, b, 500, 'ink', MAX_LABEL_LINES, 1.28, { indent });
    ops.push({ type: 'checkbox', x: left, y: top + (lh - cb) / 2, size: Math.min(cb, indent * 0.8), top, bottom: top + lh });
    if (wrapped.truncated) warnings.push({ type: 'label-truncated', id: item.id, label: item.label });
    if (item.sub) textBlock(item.sub, b * 0.68, 500, 'muted', 1, 1.3, { indent });
    if (i < items.length - 1) y += b * 0.5;
  });

  const hidden = (content.hiddenCount || 0) + (content.items.length - items.length);
  if (hidden > 0) {
    y += b * 0.45;
    textBlock(`+${hidden} more in your plan`, b * 0.7, 600, 'muted', 2, 1.3, { indent: items.length ? indent : 0 });
  }

  const contentBottom = y + b * 0.5;
  return { ops, warnings, fits: contentBottom <= footerTop, footerTop, hidden, shownItems: items.length };
}

/**
 * Compute the full sheet layout.
 * @param {object} input
 * @param {{x:number,y:number,w:number,h:number}} input.rect paper rectangle (px)
 * @param {{w:number,h:number}} input.canvas output size (px)
 * @param {object} input.content text content (see app.js buildContent)
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
  let ops = attempt.ops;
  if (!attempt.fits) {
    // 3) Still too short: never draw over the footer or off the paper.
    warnings.push({ type: 'paper-too-short' });
    ops = ops.filter((o) => o.bottom <= input.rect.y + input.rect.h && (o.bottom <= attempt.footerTop + 0.5 || o.top >= attempt.footerTop - 0.5));
  }
  if (count < total) warnings.push({ type: 'items-overflowed', count: total - count });

  return {
    ops,
    warnings: [...warnings, ...attempt.warnings],
    bodyPx: b,
    minBodyPx: minBody,
    shownItems: attempt.shownItems,
    hidden: attempt.hidden,
  };
}
