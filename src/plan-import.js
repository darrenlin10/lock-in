// Parse a backward plan pasted from Gemini (or typed by hand) into actions.
//
// Accepts lines such as:
//   2026-11-10 — Draft outline
//   - [ ] Nov 12: Collect sources
//   3. Thu, Nov 19, 2026 - Final review buffer
//   | 11/20 | Submit |
// Lines with neither a date nor a list marker (prose, headings, assumptions)
// are ignored. The UI always shows a preview before anything is added.
//
// Pure module.

import { addDays, calendarDaysBetween, isValidDateString, pad2 } from './dates.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\\.?,?\\s+)?';

const PATTERNS = [
  { re: new RegExp(`${WEEKDAY_RE}(\\d{4})-(\\d{1,2})-(\\d{1,2})`, 'i'), get: (m) => [m[1], m[2], m[3]] },
  {
    re: new RegExp(`${WEEKDAY_RE}\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i'),
    get: (m) => [m[3] || null, MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, m[2]],
  },
  { re: new RegExp(`${WEEKDAY_RE}\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, 'i'), get: (m) => [m[3] || null, m[1], m[2]] },
];

const LIST_MARKER = /^\s*(?:[-*•+]|\d+[.)]|\[[ xX]?\]|step\s+\d+[:.)]?)\s*/i;

function inferYear(month, day, today) {
  const y = Number(today.slice(0, 4));
  const candidate = `${y}-${pad2(month)}-${pad2(day)}`;
  if (!isValidDateString(candidate)) return null;
  // Dates more than ~2 months in the past are assumed to be next year.
  return calendarDaysBetween(addDays(today, -60), candidate) < 0 ? y + 1 : y;
}

function extractDate(line, today) {
  for (const { re, get } of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    let [y, mo, d] = get(m);
    mo = Number(mo);
    d = Number(d);
    if (y === null) y = inferYear(mo, d, today);
    else if (String(y).length === 2) y = 2000 + Number(y);
    const iso = `${y}-${pad2(mo)}-${pad2(d)}`;
    if (y && isValidDateString(iso)) return { iso, match: m[0], index: m.index };
  }
  return null;
}

function cleanTitle(s) {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/\|/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/^[\s\-–—:|,.>]+/, '')
    .replace(/[\s\-–—:|,]+$/, '')
    .replace(/^(?:by|due|on|until)\b[\s:]*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * @param {string} text pasted plan
 * @param {{today: string}} opts today's date 'YYYY-MM-DD' (for year inference)
 * @returns {{title: string, due: string|null}[]}
 */
export function parsePlanText(text, { today }) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^\|?\s*:?-{3,}/.test(line)) continue;
    const hasMarker = LIST_MARKER.test(line);
    const date = extractDate(line, today);
    if (!date && !hasMarker) continue;
    let rest = line;
    if (date) rest = rest.slice(0, date.index) + ' ' + rest.slice(date.index + date.match.length);
    rest = rest.replace(LIST_MARKER, '').replace(/^\s*\[[ xX]?\]\s*/, '');
    const title = cleanTitle(rest);
    if (!title || (!date && /:$/.test(line))) continue;
    out.push({ title, due: date ? date.iso : null });
  }
  return out;
}
