// Date and countdown semantics (design doc §3.3).
//
// Rules implemented here:
// - Date-only deadlines count remaining *calendar days* in the deadline's
//   timezone. "Due today" on the target date, "Overdue" after it.
// - Timed deadlines store a target instant plus a display timezone. When the
//   instant is reached the status becomes "passed" (shown as "Overdue").
// - Calendar-day differences are computed from Y-M-D tuples via Date.UTC, so
//   daylight-saving transitions never produce off-by-one results (we never
//   divide an elapsed-seconds value by 86,400).
//
// Pure module: no DOM access, safe to import from Node tests.

const DAY_MS = 86_400_000;

const partsFormatterCache = new Map();
function partsFormatter(timeZone) {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function zonedParts(instant, timeZone) {
  const out = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0; // defensive: some engines emit 24 at midnight
  return out;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' for the calendar date of `instant` in `timeZone`. */
export function dateInZone(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTimeString(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Integer day index for a 'YYYY-MM-DD' string, independent of any timezone. */
export function dayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Calendar days from `fromDate` to `toDate` (both 'YYYY-MM-DD'). */
export function calendarDaysBetween(fromDate, toDate) {
  return dayNumber(toDate) - dayNumber(fromDate);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function offsetMs(instantMs, timeZone) {
  const p = zonedParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Convert a wall-clock date + time in `timeZone` to an absolute instant.
 * Matches the "compatible" rule used by Temporal and most calendar apps:
 * - a time repeated by a DST fall-back resolves to the earlier occurrence;
 * - a time skipped by a DST jump (e.g. 02:30 when clocks go 02:00 → 03:00)
 *   moves forward by the length of the gap (03:30), never backwards, so a
 *   deadline is never earlier than the user asked for.
 */
export function zonedWallTimeToInstant(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const roundTrips = (t) => {
    const p = zonedParts(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0) === guess;
  };
  // The offset just before and just after the requested wall time covers
  // every DST transition (they are at most a day apart).
  const offBefore = offsetMs(guess - DAY_MS, timeZone);
  const offAfter = offsetMs(guess + DAY_MS, timeZone);
  const candidates = [...new Set([guess - offBefore, guess - offAfter, guess - offsetMs(guess, timeZone)])].filter(roundTrips);
  if (candidates.length) return new Date(Math.min(...candidates));
  // In a gap: interpret with the pre-transition offset, which lands the same
  // distance past the gap as the requested time was into it.
  return new Date(guess - offBefore);
}

/** Normalise a deadline record and attach its absolute instant when timed. */
export function normalizeDeadline(dl) {
  const out = {
    title: String(dl?.title ?? '').trim(),
    kind: dl?.kind === 'timed' ? 'timed' : 'date',
    date: isValidDateString(dl?.date) ? dl.date : '',
    time: isValidTimeString(dl?.time) ? dl.time : '23:59',
    timeZone: isValidTimeZone(dl?.timeZone) ? dl.timeZone : 'UTC',
  };
  out.instant =
    out.kind === 'timed' && out.date ? zonedWallTimeToInstant(out.date, out.time, out.timeZone).toISOString() : null;
  return out;
}

/**
 * Countdown for a deadline as of `now`.
 * Returns { status, days, asOfDate } where status is one of
 * 'unset' | 'upcoming' | 'due-today' | 'overdue'.
 * For timed deadlines `passed` is true once the instant has been reached.
 */
export function computeCountdown(deadline, now = new Date()) {
  const dl = normalizeDeadline(deadline);
  if (!dl.date) return { status: 'unset', days: null, asOfDate: dateInZone(now, dl.timeZone), passed: false };
  const asOfDate = dateInZone(now, dl.timeZone);
  const days = calendarDaysBetween(asOfDate, dl.date);
  if (dl.kind === 'timed') {
    const passed = now.getTime() >= Date.parse(dl.instant);
    if (passed) return { status: 'overdue', days, asOfDate, passed: true };
    // Before the instant: calendar-day logic on the wall date in the display tz.
    return { status: days <= 0 ? 'due-today' : 'upcoming', days: Math.max(days, 0), asOfDate, passed: false };
  }
  if (days < 0) return { status: 'overdue', days, asOfDate, passed: true };
  if (days === 0) return { status: 'due-today', days, asOfDate, passed: false };
  return { status: 'upcoming', days, asOfDate, passed: false };
}

const dateFmtCache = new Map();
function fmt(key, opts) {
  let f = dateFmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', opts);
    dateFmtCache.set(key, f);
  }
  return f;
}

/** 'Fri, Dec 11, 2026' for a 'YYYY-MM-DD' string (no timezone shift). */
export function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmt('long', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** 'Dec 11' for a 'YYYY-MM-DD' string. */
export function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmt('short', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** '11:59 PM PST' for an instant shown in `timeZone`. */
export function formatTimeWithZone(instant, timeZone) {
  return fmt(`time:${timeZone}`, { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(
    new Date(instant),
  );
}

/** Human text pieces for the countdown block on the sheet. */
export function countdownText(deadline, now = new Date()) {
  const dl = normalizeDeadline(deadline);
  const cd = computeCountdown(dl, now);
  const when = dl.date
    ? dl.kind === 'timed'
      ? `${formatDateLong(dl.date)} · ${formatTimeWithZone(dl.instant, dl.timeZone)}`
      : formatDateLong(dl.date)
    : '';
  const dateLine = when ? `Due ${when}` : 'Set a deadline date';
  let big;
  let unit = '';
  switch (cd.status) {
    case 'unset':
      big = '—';
      break;
    case 'overdue':
      big = 'Overdue';
      break;
    case 'due-today':
      big = 'Due today';
      break;
    default:
      big = String(cd.days);
      unit = cd.days === 1 ? 'day left' : 'days left';
  }
  return { ...cd, big, unit, dateLine, asOfLine: `As of ${formatDateLong(cd.asOfDate)}` };
}

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
