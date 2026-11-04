import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanText } from '../src/plan-import.js';
import { nearestAspectRatio, GEMINI_ASPECT_RATIOS } from '../src/ai.js';
import { planningPrompt, sceneryPrompt, PLANNING_TEMPLATE } from '../src/prompts.js';
import { resolveDevice, rectFor, clampRect, describeRect } from '../src/devices.js';
import {
  defaultState,
  migrate,
  createStorage,
  hashString,
  stableStringify,
  recordExport,
  markApplied,
  wallpaperStatus,
} from '../src/store.js';

test('plan import understands common Gemini formats and ignores prose', () => {
  const text = `Here's a backward plan for your report:

## Plan
- **2026-11-10** — Draft outline
- [ ] Nov 12: Collect sources
3. Thu, Nov 19, 2026 - Final review buffer
| 11/20 | Submit report |
|---|---|
Assumptions:
- Confirm the citation style with your instructor
I can't schedule reminders for you.`;
  const items = parsePlanText(text, { today: '2026-11-04' });
  assert.deepEqual(items, [
    { title: 'Draft outline', due: '2026-11-10' },
    { title: 'Collect sources', due: '2026-11-12' },
    { title: 'Final review buffer', due: '2026-11-19' },
    { title: 'Submit report', due: '2026-11-20' },
    { title: 'Confirm the citation style with your instructor', due: null },
  ]);
});

test('plan import rolls dates without a year into next year when needed', () => {
  assert.deepEqual(parsePlanText('- Jan 5: Kickoff', { today: '2026-11-04' }), [{ title: 'Kickoff', due: '2027-01-05' }]);
  assert.deepEqual(parsePlanText('- Feb 30: Nope', { today: '2026-11-04' }), [{ title: 'Feb 30: Nope', due: null }]);
});

test('prompts are filled from the verbatim templates', () => {
  const p = planningPrompt({ goal: 'Finish report', deadlineText: 'Dec 11, 2026 (America/Los_Angeles)', currentDate: 'Nov 4, 2026', capacity: '' });
  assert.ok(p.includes('- Goal: Finish report'));
  assert.ok(p.includes('- Available work time and constraints: [capacity and constraints]'));
  assert.ok(p.includes('Do not claim reminders are scheduled.'));
  assert.ok(PLANNING_TEMPLATE.startsWith('Help me plan backward from this deadline:'));
  const s = sceneryPrompt({ desk: 'warm walnut', lighting: 'morning daylight', accessories: 'fountain pen', rectDescription: 'rectangle from 8% to 92%', orientation: 'horizontal' });
  assert.ok(s.startsWith('Create a horizontal, top-down flat-lay'));
  assert.ok(s.includes('Do not draw paper, text, numbers'));
});

test('devices: aspect ratio, custom sizes, rect clamping', () => {
  assert.equal(nearestAspectRatio(1179, 2556, GEMINI_ASPECT_RATIOS), '9:16');
  assert.equal(nearestAspectRatio(1920, 1080, GEMINI_ASPECT_RATIOS), '16:9');
  const custom = resolveDevice({ deviceId: 'custom', customW: 2000, customH: 1000 });
  assert.equal(custom.group, 'Custom');
  assert.ok(custom.rect.w < 0.5); // landscape → computer-style default
  const r = clampRect({ x: 0.9, y: -1, w: 0.5, h: 2 });
  assert.deepEqual(r, { x: 0.5, y: 0, w: 0.5, h: 1 });
  const dev = resolveDevice({ deviceId: 'pixel-9' });
  assert.deepEqual(rectFor(dev, { 'pixel-9': { x: 0.1, y: 0.4, w: 0.8, h: 0.4 } }), { x: 0.1, y: 0.4, w: 0.8, h: 0.4 });
  assert.match(describeRect({ x: 0.08, y: 0.34, w: 0.84, h: 0.5 }), /8% to 92% of the width and 34% to 84%/);
});

test('migrate fills defaults, sanitises and never keeps an API key', () => {
  const s = migrate({ tasks: [{ title: 'x' }], display: { maxVisible: 99 }, gemini: { apiKey: 'secret', model: 'm' } });
  assert.equal(s.tasks.length, 1);
  assert.equal(s.display.maxVisible, 6);
  assert.ok(!JSON.stringify(s).includes('secret'));
  assert.equal(s.gemini, undefined);
  assert.deepEqual(s.ai, { provider: 'gemini', models: { gemini: 'm' }, baseUrl: '', size: '' });
  assert.equal(migrate(null).schema, 2);
  const t = migrate({ ai: { provider: 'nope', models: { openai: 'gpt-image-1', bad: 5 }, apiKey: 'k2' } });
  assert.equal(t.ai.provider, 'gemini');
  assert.deepEqual(t.ai.models, { openai: 'gpt-image-1' });
  assert.ok(!JSON.stringify(t).includes('k2'));
});

test('storage degrades gracefully when the backend throws', () => {
  const broken = { setItem() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, removeItem() {} };
  const st = createStorage(broken);
  assert.equal(st.available, false);
  assert.equal(st.load(), null);
  assert.equal(st.save({}), false);
  const mem = new Map();
  const ok = createStorage({ setItem: (k, v) => mem.set(k, v), getItem: (k) => mem.get(k) ?? null, removeItem: (k) => mem.delete(k) });
  assert.equal(ok.save({ a: 1 }), true);
  assert.deepEqual(ok.load(), { a: 1 });
});

test('stable hashing ignores key order', () => {
  assert.equal(hashString(stableStringify({ a: 1, b: [1, 2] })), hashString(stableStringify({ b: [1, 2], a: 1 })));
  assert.notEqual(hashString('a'), hashString('b'));
});

test('wallpaper status separates exported from applied and detects staleness', () => {
  const device = { id: 'iphone-6.1', name: 'iPhone', w: 1179, h: 2556 };
  let s = defaultState(new Date('2026-11-04T00:00:00Z'));
  assert.equal(wallpaperStatus(s, 'v1').kind, 'none');
  s = recordExport(s, { version: 'v1', asOfDate: '2026-11-04', device, background: 'walnut', now: new Date('2026-11-04T10:00:00Z') });
  assert.equal(wallpaperStatus(s, 'v1').kind, 'exported');
  s = markApplied(s, s.snapshots[0].id, new Date('2026-11-04T10:05:00Z'));
  assert.equal(wallpaperStatus(s, 'v1').kind, 'current');
  assert.equal(wallpaperStatus(s, 'v2').kind, 'stale');
  s = recordExport(s, { version: 'v2', asOfDate: '2026-11-05', device, background: 'walnut', now: new Date('2026-11-05T10:00:00Z') });
  const st = wallpaperStatus(s, 'v2');
  assert.equal(st.kind, 'stale');
  assert.ok(st.pendingExport);
});
