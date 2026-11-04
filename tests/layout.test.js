import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSheetLayout, wrapText, MIN_BODY_FRACTION } from '../src/layout.js';

// Deterministic fake measurement: each character is 0.55em wide.
const measure = (text, size) => text.length * size * 0.55;

const canvas = { w: 1179, h: 2556 };
const rect = { x: 94, y: 869, w: 990, h: 1278 };

function content(items, extra = {}) {
  return {
    eyebrow: 'Deadline',
    title: 'Capstone final report',
    big: '37',
    unit: 'days left',
    dateLine: 'Due Fri, Dec 11, 2026',
    sectionLabel: 'Next actions',
    items,
    hiddenCount: 0,
    emptyText: 'No open actions — add your next step.',
    footerLeft: 'As of Wed, Nov 4, 2026',
    footerRight: 'LOCK-IN',
    ...extra,
  };
}

const item = (label, i) => ({ id: `t${i}`, label, sub: 'by Nov 10' });
const textOps = (r) => r.ops.filter((o) => o.type === 'text').map((o) => o.text);

test('wrapText wraps, hard-breaks and ellipsises', () => {
  const w = wrapText('one two three four five six', 10 * 0.55 * 10, 10, 400, measure, 2);
  assert.equal(w.lines.length, 2);
  assert.equal(w.truncated, true);
  assert.ok(w.lines[1].endsWith('…'));
  const hb = wrapText('supercalifragilistic', 5 * 0.55 * 10, 10, 400, measure);
  assert.ok(hb.lines.length >= 4);
  assert.equal(wrapText('', 100, 10, 400, measure).lines.length, 1);
});

test('three short tasks fit at the starting size with no warnings', () => {
  const r = computeSheetLayout({ rect, canvas, content: content(['Outline', 'Draft', 'Review'].map(item)), measure });
  assert.equal(r.shownItems, 3);
  assert.equal(r.hidden, 0);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ops.filter((o) => o.type === 'checkbox').length, 3);
  assert.ok(textOps(r).includes('As of Wed, Nov 4, 2026'));
  assert.ok(textOps(r).includes('Due Fri, Dec 11, 2026'));
});

test('no tasks shows the empty message', () => {
  const r = computeSheetLayout({ rect, canvas, content: content([]), measure });
  assert.ok(textOps(r).some((t) => t.startsWith('No open actions')));
  assert.equal(r.ops.filter((o) => o.type === 'checkbox').length, 0);
});

test('long labels are capped at two lines and reported', () => {
  const long = 'Collect and annotate every single primary source mentioned in the syllabus reading list for week nine';
  const r = computeSheetLayout({ rect, canvas, content: content([item(long, 0)]), measure });
  assert.ok(r.warnings.some((w) => w.type === 'label-truncated' && w.id === 't0'));
  assert.ok(textOps(r).some((t) => t.endsWith('…')));
});

test('text never shrinks below the minimum readable size; extra rows overflow', () => {
  const short = { ...rect, h: 900 };
  const items = Array.from({ length: 6 }, (_, i) => item(`Task number ${i + 1}`, i));
  const r = computeSheetLayout({ rect: short, canvas, content: content(items, { hiddenCount: 2 }), measure });
  const min = Math.round(Math.min(canvas.w, canvas.h) * MIN_BODY_FRACTION);
  assert.ok(r.bodyPx >= min);
  for (const op of r.ops.filter((o) => o.type === 'text' && o.role === 'ink' && o.weight === 500 && o.text.startsWith('Task'))) {
    assert.ok(op.size >= min);
  }
  assert.ok(r.shownItems < 6);
  assert.equal(r.hidden, 2 + (6 - r.shownItems));
  assert.ok(textOps(r).includes(`+${r.hidden} more in your plan`));
  assert.ok(r.warnings.some((w) => w.type === 'items-overflowed'));
});

test('everything stays inside the paper rectangle', () => {
  const items = ['A fairly long action label that wraps', 'Second', 'Third'].map(item);
  const r = computeSheetLayout({ rect, canvas, content: content(items), measure });
  for (const op of r.ops) {
    if (op.type !== 'text') continue;
    const w = measure(op.text, op.size);
    const x0 = op.align === 'right' ? op.x - w : op.x;
    assert.ok(x0 >= rect.x && x0 + w <= rect.x + rect.w + 0.5, `"${op.text}" overflows horizontally`);
    assert.ok(op.y <= rect.y + rect.h && op.y >= rect.y, `"${op.text}" overflows vertically`);
  }
});

test('status words like "Due today" are shrunk to fit the width', () => {
  const narrow = { x: 0, y: 0, w: 420, h: 1600 };
  const r = computeSheetLayout({ rect: narrow, canvas, content: content([], { big: 'Due today', unit: '' }), measure });
  const op = r.ops.find((o) => o.text === 'Due today');
  assert.ok(measure(op.text, op.size) <= narrow.w);
});

test('computer (landscape) screens use a smaller minimum fraction', () => {
  const r = computeSheetLayout({
    rect: { x: 1536, y: 233, w: 768, h: 1165 },
    canvas: { w: 2560, h: 1664 },
    content: content(['Outline', 'Draft', 'Review'].map(item)),
    measure,
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.minBodyPx, Math.round(1664 * 0.022));
});
