// Regression tests for issues found by stress-testing (randomized inputs,
// corrupted backups, extreme sizes, DST edge cases).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedWallTimeToInstant, zonedParts } from '../src/dates.js';
import { computeSheetLayout, wrapText, graphemes } from '../src/layout.js';
import { parsePlanText } from '../src/plan-import.js';
import { buildIcs, buildReminderItems } from '../src/reminders.js';
import { migrate, DESIGN_KEYS } from '../src/store.js';
import { normalizeTask, createTask, clip } from '../src/tasks.js';
import { resolveDevice, MAX_CANVAS_AREA } from '../src/devices.js';
import { PAPERS, FONTS } from '../src/render/compositor.js';
import { DESKS, LIGHTING } from '../src/render/backgrounds.js';

const measure = (t, size) => graphemes(t).length * size * 0.55;
const content = (over = {}) => ({
  eyebrow: 'Deadline',
  title: 'Capstone final report',
  big: '30',
  unit: 'days left',
  dateLine: 'Due Fri, Dec 4, 2026',
  sectionLabel: 'Next actions',
  items: ['Confirm rubric', 'Draft outline', 'Finish analysis + figures'].map((label, i) => ({ id: `t${i}`, label, sub: 'by Nov 9' })),
  hiddenCount: 0,
  emptyText: 'No open actions',
  footerLeft: 'As of Wed, Nov 4, 2026',
  footerRight: 'LOCK-IN',
  ...over,
});

function assertInside(r, rect) {
  for (const op of r.ops) {
    if (op.type !== 'text') continue;
    const w = measure(op.text, op.size);
    const x0 = op.align === 'right' ? op.x - w : op.x;
    assert.ok(x0 >= rect.x - 0.5 && x0 + w <= rect.x + rect.w + 0.5, `"${op.text}" escapes horizontally`);
    assert.ok(op.bottom <= rect.y + rect.h + 0.5 && op.top >= rect.y - 0.5, `"${op.text}" escapes vertically`);
  }
}

test('times skipped by DST move forward, never backward', () => {
  const LA = 'America/Los_Angeles';
  const t = zonedWallTimeToInstant('2026-03-08', '02:30', LA);
  const p = zonedParts(t, LA);
  assert.deepEqual([p.hour, p.minute], [3, 30]);
  // 30-minute DST shift (Lord Howe Island).
  const lh = zonedParts(zonedWallTimeToInstant('2026-10-04', '02:15', 'Australia/Lord_Howe'), 'Australia/Lord_Howe');
  assert.deepEqual([lh.hour, lh.minute], [2, 45]);
  // Midnight that doesn't exist (Santiago) stays on the same date.
  const sc = zonedParts(zonedWallTimeToInstant('2026-09-06', '00:00', 'America/Santiago'), 'America/Santiago');
  assert.deepEqual([sc.day, sc.hour], [6, 1]);
});

test('narrow paper: footer never overlaps, "As of" always kept, nothing leaves the paper', () => {
  const canvas = { w: 1179, h: 2556 };
  for (const wf of [0.84, 0.5, 0.3, 0.2, 0.15]) {
    for (const hf of [0.5, 0.2, 0.15]) {
      for (const big of [['30', 'days left'], ['Due today', ''], ['2912135', 'days left']]) {
        const rect = { x: 40, y: 700, w: Math.round(wf * canvas.w), h: Math.round(hf * canvas.h) };
        const r = computeSheetLayout({ rect, canvas, content: content({ big: big[0], unit: big[1] }), measure });
        assertInside(r, rect);
        const brand = r.ops.find((o) => o.text === 'LOCK-IN');
        const asOf = r.ops.filter((o) => o.role === 'muted' && /As of|Nov 4|2026/.test(o.text) && o.top >= rect.y + rect.h * 0.5);
        assert.ok(asOf.length >= 1, `as-of missing at ${wf}x${hf}`);
        if (brand) for (const a of asOf) assert.ok(a.x + measure(a.text, a.size) < brand.x - measure('LOCK-IN', brand.size) || a.top !== brand.top);
      }
    }
  }
});

test('"No open actions" only when there truly are none', () => {
  const tiny = { x: 0, y: 0, w: 300, h: 420 };
  const r = computeSheetLayout({ rect: tiny, canvas: { w: 1179, h: 2556 }, content: content(), measure });
  assert.ok(!r.ops.some((o) => o.text === 'No open actions'));
  const empty = computeSheetLayout({ rect: { x: 0, y: 0, w: 990, h: 1300 }, canvas: { w: 1179, h: 2556 }, content: content({ items: [] }), measure });
  assert.ok(empty.ops.some((o) => o.text === 'No open actions'));
});

test('wrapping and truncation never split emoji or combined characters', () => {
  const text = '👩‍💻👩‍💻👩‍💻👩‍💻 🇺🇸🇺🇸🇺🇸 é́é́é́é́é́ 🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯';
  for (let width = 10; width < 200; width += 7) {
    const w = wrapText(text, width, 10, 400, measure, 2);
    for (const line of w.lines) {
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(line), 'lone surrogate');
      assert.ok(!/‍(…|$)/.test(line), 'dangling zero-width joiner');
    }
  }
  assert.equal(clip('ab🎯', 3), 'ab');
});

test('very long unbroken words lay out quickly', () => {
  const word = 'x'.repeat(5000);
  const t0 = performance.now();
  const r = computeSheetLayout({ rect: { x: 0, y: 0, w: 990, h: 1300 }, canvas: { w: 1179, h: 2556 }, content: content({ title: word, items: [{ id: 'a', label: word }] }), measure });
  assert.ok(performance.now() - t0 < 500);
  assert.ok(r.warnings.some((w) => w.type === 'label-truncated'));
});

test('randomized layouts stay inside the paper', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const words = ['Draft', 'outline', '报告初稿', '🎯', 'supercalifragilisticexpialidocious', 'https://example.com/a/very/long/path', 'مراجعة'];
  const sentence = () => Array.from({ length: 1 + Math.floor(rnd() * 15) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  for (let i = 0; i < 400; i++) {
    const canvas = [{ w: 1179, h: 2556 }, { w: 3840, h: 2160 }, { w: 750, h: 1334 }][i % 3];
    const fx = rnd() * 0.5;
    const fy = rnd() * 0.5;
    const rect = { x: Math.round(fx * canvas.w), y: Math.round(fy * canvas.h), w: Math.round((0.15 + rnd() * (0.85 - fx)) * canvas.w), h: Math.round((0.15 + rnd() * (0.85 - fy)) * canvas.h) };
    const items = Array.from({ length: Math.floor(rnd() * 7) }, (_, k) => ({ id: `r${k}`, label: sentence(), sub: rnd() < 0.5 ? 'by Nov 9' : '' }));
    const r = computeSheetLayout({ rect, canvas, content: content({ title: sentence(), items, big: ['3', 'Overdue', 'Due today'][i % 3], unit: i % 3 ? '' : 'days left' }), measure });
    assertInside(r, rect);
  }
});

test('plan import: fractions are not dates; leap days and "by M/D" work', () => {
  const today = '2026-11-05';
  assert.deepEqual(parsePlanText('- Write 1/2 of the draft\n- Read chapter 3/4 notes', { today }), [
    { title: 'Write 1/2 of the draft', due: null },
    { title: 'Read chapter 3/4 notes', due: null },
  ]);
  assert.deepEqual(parsePlanText('- Submit by 11/20', { today }), [{ title: 'Submit', due: '2026-11-20' }]);
  assert.deepEqual(parsePlanText('- Feb 29: leap task', { today: '2027-11-05' }), [{ title: 'leap task', due: '2028-02-29' }]);
  const t0 = performance.now();
  parsePlanText('- ' + 'monday '.repeat(20000) + '1/'.repeat(20000), { today });
  assert.ok(performance.now() - t0 < 1000, 'no catastrophic regex backtracking');
});

test('calendar export cannot be injected through task IDs or text', () => {
  const s = migrate({ tasks: [{ id: 'x\r\nBEGIN:VEVENT\r\nSUMMARY:pwn', title: 'T\r\nBEGIN:VEVENT', due: '2026-11-20' }], deadline: { date: '2026-12-01', timeZone: 'UTC' } });
  const ics = buildIcs(buildReminderItems(s.deadline, s.tasks, { now: new Date('2026-11-05T00:00:00Z') }));
  assert.equal((ics.match(/^BEGIN:VEVENT$/gm) || []).length, 3);
  assert.equal(normalizeTask({ id: '"><script>' }).id.includes('<'), false);
});

test('reminders already in the past are flagged', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const items = buildReminderItems({ title: 'D', kind: 'date', date: '2026-12-01', timeZone: 'UTC' }, [createTask({ title: 'old', due: '2026-11-01' }), createTask({ title: 'new', due: '2026-11-20' })], { now });
  assert.deepEqual(items.filter((i) => i.past).map((i) => i.title), ['old']);
});

test('corrupted or hostile backups always load into a renderable state', () => {
  const junk = [
    null, 1, 'str', [], { display: { eyebrow: 5, sectionLabel: {}, showDue: 'yes' } }, { challenge: { steps: null, notes: 7 } },
    { snapshots: [null, {}, { state: 'applied' }, { id: 's', version: 'v', asOfDate: 'x', device: {}, state: 'exported', exportedAt: 'nope' }] },
    { tasks: [null, 5, { order: 'x' }, { title: 'a', order: 0, id: 'dup' }, { title: 'b', order: 0, id: 'dup' }] },
    { design: { accessories: 'abc', background: null, deviceId: 'nokia', paper: 'papyrus', desk: 'lava' } },
    { reminders: { verified: 'x', time: 99, refresh: 'hourly' } }, { rects: { 'iphone-6.1': 'nope', other: { x: 'a' } } },
    { deadline: { date: '2026-02-31', timeZone: 'Mars/Base', title: 42 } }, { ai: { models: null, provider: {} } }, { goal: {}, capacity: [] },
  ];
  for (const j of junk) {
    const s = migrate(j);
    assert.equal(typeof s.display.eyebrow, 'string');
    assert.equal(typeof s.display.sectionLabel, 'string');
    assert.equal(typeof s.display.showDue, 'boolean');
    assert.equal(typeof s.challenge.steps, 'object');
    assert.notEqual(s.challenge.steps, null);
    assert.equal(typeof s.challenge.notes, 'string');
    assert.equal(typeof s.goal, 'string');
    for (const sn of s.snapshots) assert.ok(sn.device && typeof sn.asOfDate === 'string');
    const ids = s.tasks.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'unique task IDs');
    const orders = s.tasks.map((t) => t.order);
    assert.equal(new Set(orders).size, orders.length, 'unique task order');
    assert.ok(DESIGN_KEYS.paper.includes(s.design.paper) && DESIGN_KEYS.desk.includes(s.design.desk));
    for (const r of Object.values(s.rects)) assert.ok(['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])));
  }
  // Valid data survives unchanged in substance.
  const ok = migrate({ tasks: [{ id: 'a1', title: 'Keep me', order: 5 }], snapshots: [{ id: 's1', version: 'v', asOfDate: '2026-11-04', device: { id: 'x', name: 'iPhone' }, state: 'applied', exportedAt: '2026-11-04T10:00:00Z', appliedAt: '2026-11-04T10:05:00Z' }] });
  assert.equal(ok.tasks[0].title, 'Keep me');
  assert.equal(ok.snapshots.length, 1);
});

test('design keys in the store match what the renderer knows', () => {
  assert.deepEqual(DESIGN_KEYS.paper, Object.keys(PAPERS));
  assert.deepEqual(DESIGN_KEYS.font, Object.keys(FONTS));
  assert.deepEqual(DESIGN_KEYS.desk, Object.keys(DESKS));
  assert.deepEqual(DESIGN_KEYS.lighting, Object.keys(LIGHTING));
});

test('custom sizes are capped to what browsers can export, keeping the shape', () => {
  const d = resolveDevice({ deviceId: 'custom', customW: 8000, customH: 8000 });
  assert.ok(d.w * d.h <= MAX_CANVAS_AREA);
  assert.equal(d.w, d.h);
  assert.equal(d.capped, true);
  const tall = resolveDevice({ deviceId: 'custom', customW: 3000, customH: 9000 });
  assert.ok(tall.h <= 8192 && tall.w * tall.h <= MAX_CANVAS_AREA);
  assert.equal(resolveDevice({ deviceId: 'custom', customW: 1179, customH: 2556 }).capped, false);
});
