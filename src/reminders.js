// Reminder schedule → calendar files and links (design doc §2.3 "Reminders").
//
// Lock-In never claims a reminder is scheduled. It produces:
//   - an .ics file the user imports into their calendar app, and
//   - per-item Google Calendar "add event" links (no API access needed).
// Each item can then be ticked as "verified in my calendar". A verification is
// tied to the item's signature (title/date/time); if the plan changes, the
// verification is invalidated and the UI asks the user to re-check.
//
// Pure module.

import { addDays, normalizeDeadline, zonedWallTimeToInstant, dateInZone } from './dates.js';
import { displayLabel, orderedOpenTasks } from './tasks.js';

const EVENT_MINUTES = 30;

/**
 * Build the list of reminder items from local data.
 * @param {object} deadline
 * @param {object[]} tasks
 * @param {{time: string, refresh: 'none'|'daily'|'weekly', now?: Date}} opts
 */
export function buildReminderItems(deadline, tasks, { time = '09:00', refresh = 'weekly', now = new Date() } = {}) {
  const dl = normalizeDeadline(deadline);
  const tz = dl.timeZone;
  const items = [];
  const deadlineName = dl.title || 'your deadline';

  for (const t of orderedOpenTasks(tasks)) {
    if (!t.due) continue;
    const start = zonedWallTimeToInstant(t.due, time, tz);
    items.push({
      uid: `task-${t.id}@lock-in`,
      kind: 'action',
      title: displayLabel(t),
      description: `${t.title}\nPart of: ${deadlineName}`,
      date: t.due,
      time,
      timeZone: tz,
      start,
      end: new Date(start.getTime() + EVENT_MINUTES * 60_000),
      alarms: [0],
    });
  }

  if (dl.date) {
    const dTime = dl.kind === 'timed' ? dl.time : time;
    const start = dl.kind === 'timed' ? new Date(dl.instant) : zonedWallTimeToInstant(dl.date, time, tz);
    items.push({
      uid: 'deadline@lock-in',
      kind: 'deadline',
      title: `Deadline: ${deadlineName}`,
      description: dl.kind === 'timed' ? `Due at ${dl.time} (${tz}).` : `Due on ${dl.date} (${tz}).`,
      date: dl.date,
      time: dTime,
      timeZone: tz,
      start,
      end: new Date(start.getTime() + EVENT_MINUTES * 60_000),
      alarms: [24 * 60, 0],
    });

    const today = dateInZone(now, tz);
    const firstRefresh = addDays(today, 1);
    if (refresh !== 'none' && firstRefresh < dl.date) {
      const rStart = zonedWallTimeToInstant(firstRefresh, time, tz);
      items.push({
        uid: `refresh-${refresh}@lock-in`,
        kind: 'refresh',
        title: 'Refresh your Lock-In wallpaper',
        description: 'Open Lock-In, review your next actions and export a fresh lock screen. The installed image is a snapshot and does not update by itself.',
        date: firstRefresh,
        time,
        timeZone: tz,
        start: rStart,
        end: new Date(rStart.getTime() + 10 * 60_000),
        alarms: [0],
        rrule: `FREQ=${refresh === 'daily' ? 'DAILY' : 'WEEKLY'};UNTIL=${icsDateTime(zonedWallTimeToInstant(dl.date, '23:59', tz))}`,
      });
    }
  }

  return items.map((it) => ({ ...it, sig: signature(it) }));
}

export function signature(item) {
  return [item.title, item.date, item.time, item.timeZone, item.rrule || ''].join('|');
}

/** Verification is valid only if it was recorded for the current signature. */
export function isVerified(item, verified = {}) {
  return Boolean(verified[item.uid] && verified[item.uid].sig === item.sig);
}

export function icsDateTime(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets (RFC 5545 §3.1). */
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '';
  let currentLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (currentLen + len > limit) {
      parts.push(current);
      current = '';
      currentLen = 0;
    }
    current += ch;
    currentLen += len;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(items, { now = new Date(), calendarName = 'Lock-In plan' } = {}) {
  const stamp = icsDateTime(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lock-In//Countdown Lock Screen//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ];
  for (const it of items) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${it.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDateTime(it.start)}`,
      `DTEND:${icsDateTime(it.end)}`,
      `SUMMARY:${icsEscape(it.title)}`,
      `DESCRIPTION:${icsEscape(it.description)}`,
    );
    if (it.rrule) lines.push(`RRULE:${it.rrule}`);
    for (const minutes of it.alarms) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape(it.title)}`,
        `TRIGGER:${minutes === 0 ? 'PT0M' : `-PT${minutes}M`}`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Google Calendar "create event" template link (opens a prefilled form). */
export function googleCalendarUrl(item) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: item.title,
    dates: `${icsDateTime(item.start)}/${icsDateTime(item.end)}`,
    details: item.description,
  });
  if (item.rrule) params.set('recur', `RRULE:${item.rrule}`);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
