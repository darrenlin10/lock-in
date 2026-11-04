import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, buildReminderItems, foldLine, googleCalendarUrl, icsEscape, isVerified } from '../src/reminders.js';
import { createTask } from '../src/tasks.js';

const now = new Date('2026-11-04T18:00:00Z');
const deadline = { title: 'Capstone report', kind: 'date', date: '2026-12-11', timeZone: 'America/Los_Angeles' };
const tasks = [
  createTask({ title: 'Draft outline', due: '2026-11-10' }, now),
  createTask({ title: 'No date yet' }, now),
  { ...createTask({ title: 'Done already', due: '2026-11-08' }, now), done: true },
];

test('reminder items: dated open actions, the deadline, and a refresh reminder', () => {
  const items = buildReminderItems(deadline, tasks, { time: '09:00', refresh: 'weekly', now });
  assert.deepEqual(items.map((i) => i.kind), ['action', 'deadline', 'refresh']);
  const action = items[0];
  assert.equal(action.title, 'Draft outline');
  assert.equal(action.start.toISOString(), '2026-11-10T17:00:00.000Z'); // 9 AM PST
  const dl = items[1];
  assert.deepEqual(dl.alarms, [1440, 0]);
  assert.match(items[2].rrule, /^FREQ=WEEKLY;UNTIL=20261212T075900Z$/);
});

test('no refresh reminder when disabled', () => {
  const items = buildReminderItems(deadline, tasks, { refresh: 'none', now });
  assert.ok(!items.some((i) => i.kind === 'refresh'));
});

test('verification is invalidated when the reminder changes', () => {
  const [item] = buildReminderItems(deadline, tasks, { now });
  const verified = { [item.uid]: { sig: item.sig, at: now.toISOString() } };
  assert.equal(isVerified(item, verified), true);
  const [moved] = buildReminderItems(deadline, tasks, { time: '10:00', now });
  assert.equal(isVerified(moved, verified), false);
});

test('ICS output is valid-looking RFC 5545', () => {
  const items = buildReminderItems(deadline, tasks, { now });
  const ics = buildIcs(items, { now });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, items.length);
  assert.ok(ics.includes('DTSTART:20261110T170000Z'));
  assert.ok(ics.includes('TRIGGER:-PT1440M'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test('escaping and folding', () => {
  assert.equal(icsEscape('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const folded = foldLine('DESCRIPTION:' + 'é'.repeat(80));
  assert.ok(folded.split('\r\n ').every((l) => new TextEncoder().encode(l).length <= 75));
});

test('Google Calendar link is a prefilled template', () => {
  const [item] = buildReminderItems(deadline, tasks, { now });
  const url = new URL(googleCalendarUrl(item));
  assert.equal(url.hostname, 'calendar.google.com');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('dates'), '20261110T170000Z/20261110T173000Z');
});
