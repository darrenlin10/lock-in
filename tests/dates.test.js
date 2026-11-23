import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  calendarDaysBetween,
  computeCountdown,
  countdownText,
  dateInZone,
  formatDateLong,
  isValidDateString,
  normalizeDeadline,
  zonedWallTimeToInstant,
} from '../src/dates.js';

const LA = 'America/Los_Angeles';

test('calendar days ignore DST transitions', () => {
  // US DST ended Nov 1, 2026; that day is 25 hours long in Los Angeles.
  assert.equal(calendarDaysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(calendarDaysBetween('2026-03-07', '2026-03-09'), 2); // spring-forward weekend
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('date-only countdown uses the deadline timezone, not UTC', () => {
  const dl = { title: 'Report', kind: 'date', date: '2026-11-23', timeZone: LA };
  // 2026-11-23T05:00Z is still Nov 22 (9 PM) in Los Angeles.
  assert.deepEqual(
    pick(computeCountdown(dl, new Date('2026-11-23T05:00:00Z'))),
    { status: 'upcoming', days: 1, asOfDate: '2026-11-22' },
  );
  assert.equal(computeCountdown(dl, new Date('2026-11-23T09:00:00Z')).status, 'due-today');
  assert.equal(computeCountdown(dl, new Date('2026-11-24T07:59:00Z')).status, 'due-today'); // 11:59 PM PST on the 23rd
  assert.equal(computeCountdown(dl, new Date('2026-11-24T08:00:00Z')).status, 'overdue');
});

test('countdown across the fall-back DST change is not off by one', () => {
  const dl = { title: 'X', kind: 'date', date: '2026-11-02', timeZone: LA };
  // 11:30 PM PDT on Oct 31 → two calendar days, even though 49 hours elapse.
  assert.equal(computeCountdown(dl, new Date('2026-11-01T06:30:00Z')).days, 2);
});

test('timed deadlines switch to overdue exactly at the instant', () => {
  const dl = normalizeDeadline({ title: 'Submit', kind: 'timed', date: '2026-11-23', time: '23:59', timeZone: LA });
  assert.equal(dl.instant, '2026-11-24T07:59:00.000Z');
  assert.equal(computeCountdown(dl, new Date('2026-11-24T07:58:59Z')).status, 'due-today');
  const after = computeCountdown(dl, new Date('2026-11-24T07:59:00Z'));
  assert.equal(after.status, 'overdue');
  assert.equal(after.passed, true);
});

test('wall time conversion handles DST gaps and overlaps', () => {
  // 02:30 does not exist on 2026-03-08 in LA; we land after the gap.
  const gap = zonedWallTimeToInstant('2026-03-08', '02:30', LA);
  assert.equal(dateInZone(gap, LA), '2026-03-08');
  // 01:30 happens twice on 2026-11-01; we pick the earlier (PDT) occurrence.
  assert.equal(zonedWallTimeToInstant('2026-11-01', '01:30', LA).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(zonedWallTimeToInstant('2026-07-01', '09:00', 'Asia/Kolkata').toISOString(), '2026-07-01T03:30:00.000Z');
});

test('countdown text always carries the absolute date and an as-of date', () => {
  const t = countdownText({ title: 'R', kind: 'date', date: '2026-12-11', timeZone: LA }, new Date('2026-11-04T18:00:00Z'));
  assert.equal(t.big, '37');
  assert.equal(t.unit, 'days left');
  assert.equal(t.dateLine, 'Due Fri, Dec 11, 2026');
  assert.equal(t.asOfLine, 'As of Wed, Nov 4, 2026');
  const one = countdownText({ kind: 'date', date: '2026-11-05', timeZone: LA }, new Date('2026-11-04T18:00:00Z'));
  assert.equal(one.unit, 'day left');
  const timed = countdownText({ kind: 'timed', date: '2026-11-23', time: '23:59', timeZone: LA }, new Date('2026-11-04T18:00:00Z'));
  assert.match(timed.dateLine, /^Due Mon, Nov 23, 2026 · 11:59 PM PST$/);
  assert.equal(countdownText({ kind: 'date', date: '', timeZone: LA }).status, 'unset');
});

test('validation helpers', () => {
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('2026-02-28'), true);
  assert.equal(formatDateLong('2026-01-01'), 'Thu, Jan 1, 2026');
  assert.equal(normalizeDeadline({ timeZone: 'Not/AZone' }).timeZone, 'UTC');
});

function pick(c) {
  return { status: c.status, days: c.days, asOfDate: c.asOfDate };
}

test('dates follow the English variant of the user locale; other languages fall back to en-US', async () => {
  const { setDisplayLocale, formatDateLong, formatDateShort, formatTimeWithZone } = await import('../src/dates.js');
  try {
    assert.equal(setDisplayLocale('en-GB'), 'en-GB');
    assert.match(formatDateLong('2026-12-04'), /^Fri,? 4 Dec 2026$/); // comma varies by ICU version
    assert.equal(formatDateShort('2026-12-04'), '4 Dec');
    assert.match(formatTimeWithZone('2026-12-04T23:59:00Z', 'UTC'), /^23:59/);
    assert.equal(setDisplayLocale('fr-FR'), 'en-US');
    assert.equal(formatDateLong('2026-12-04'), 'Fri, Dec 4, 2026');
    assert.equal(setDisplayLocale(undefined), 'en-US');
  } finally {
    setDisplayLocale('en-US');
  }
});
