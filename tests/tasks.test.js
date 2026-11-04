import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, displayLabel, normalizeTask, selectVisibleTasks, updateTask, progress } from '../src/tasks.js';

const now = new Date('2026-11-04T12:00:00Z');
const mk = (title, extra = {}) => createTask({ title, ...extra }, now);

test('visible order: pinned first, then due date, priority, manual order', () => {
  const tasks = [
    mk('undated high', { priority: 1, order: 1 }),
    mk('late', { due: '2026-11-20', order: 2 }),
    mk('early low', { due: '2026-11-10', priority: 3, order: 3 }),
    mk('early high', { due: '2026-11-10', priority: 1, order: 4 }),
    mk('pinned', { pinned: true, order: 5 }),
  ];
  const { visible, hidden } = selectVisibleTasks(tasks, 3);
  assert.deepEqual(visible.map((t) => t.title), ['pinned', 'early high', 'early low']);
  assert.equal(hidden, 2);
});

test('completed tasks leave the next snapshot', () => {
  const a = mk('a', { due: '2026-11-05' });
  const b = mk('b', { due: '2026-11-06' });
  const done = updateTask(a, { done: true }, now);
  assert.deepEqual(selectVisibleTasks([done, b], 3).visible.map((t) => t.title), ['b']);
  assert.deepEqual(progress([done, b]), { done: 1, total: 2 });
});

test('pinned tasks are never silently replaced; overflow is flagged', () => {
  const tasks = [1, 2, 3, 4].map((i) => mk(`p${i}`, { pinned: true, order: i }));
  const r = selectVisibleTasks(tasks, 3);
  assert.equal(r.pinnedOverflow, true);
  assert.deepEqual(r.visible.map((t) => t.title), ['p1', 'p2', 'p3']);
});

test('short display label is used on the wallpaper, full title is kept', () => {
  const t = mk('Write the full literature review section with 12 sources', { label: 'Lit review' });
  assert.equal(displayLabel(t), 'Lit review');
  assert.equal(t.title, 'Write the full literature review section with 12 sources');
});

test('normalizeTask sanitises bad input', () => {
  const t = normalizeTask({ title: '  x ', priority: 9, due: 'tomorrow' });
  assert.equal(t.title, 'x');
  assert.equal(t.priority, 2);
  assert.equal(t.due, null);
  assert.ok(t.id);
});

test('updateTask bumps updatedAt and keeps identity', () => {
  const t = mk('a');
  const later = new Date('2026-11-05T00:00:00Z');
  const u = updateTask(t, { title: 'b', id: 'hijack' }, later);
  assert.equal(u.id, t.id);
  assert.equal(u.updatedAt, later.toISOString());
  assert.equal(u.createdAt, t.createdAt);
});
