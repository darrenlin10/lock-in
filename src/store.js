// Local, authoritative data store (design doc §4.1).
//
// The persisted JSON record is the source of truth. Generated images are
// derived output and are never read back as data. Wallpaper snapshots keep
// only metadata (generated → exported → applied), not pixels.
//
// localStorage access is wrapped: in private windows or with blocked storage
// the app still works for the session and warns that data won't persist.

import { localTimeZone, normalizeDeadline, isValidTimeString } from './dates.js';
import { normalizeTask } from './tasks.js';

export const STORAGE_KEY = 'lock-in:v1';
export const SCHEMA_VERSION = 2;
export const MAX_SNAPSHOTS = 20;

export const CHALLENGE_STEPS = [
  { n: 1, title: 'Verify the signed-in brief', done: 'Deadline, required tools, submission fields and judging terms recorded from the official mission page.' },
  { n: 2, title: 'Choose one deadline and target device', done: 'Goal, exact due date/time, timezone and screen dimensions are unambiguous.' },
  { n: 3, title: 'Create and review the backward plan with Gemini', done: 'Plan is realistic and the next three display actions are selected.' },
  { n: 4, title: 'Create the desk-and-paper lock-screen design', done: 'Image contains the verified deadline and readable next actions.' },
  { n: 5, title: 'Install and inspect the image', done: 'Installed image is readable on the real device and correctly dated.' },
  { n: 6, title: 'Schedule and verify reminders', done: 'Entries exist at the intended times (a generated suggestion alone does not count).' },
  { n: 7, title: 'Prepare the requested submission evidence', done: 'All required materials are ready and accurate.' },
  { n: 8, title: 'Review and submit through Handshake', done: 'Handshake confirms submission.' },
];

export function defaultState(now = new Date()) {
  return {
    schema: SCHEMA_VERSION,
    deadline: normalizeDeadline({ title: '', kind: 'date', date: '', time: '23:59', timeZone: localTimeZone() }),
    goal: '',
    capacity: '',
    tasks: [],
    display: { maxVisible: 3, showDue: true, showStamp: true, eyebrow: 'Deadline', sectionLabel: 'Next actions' },
    design: {
      deviceId: 'iphone-6.1',
      customW: 1179,
      customH: 2556,
      desk: 'walnut',
      paper: 'cream',
      lighting: 'day',
      font: 'serif',
      accessories: { pen: true, cup: true, plant: false },
      background: { type: 'bundled', assetId: null, label: null, model: null },
    },
    rects: {},
    snapshots: [],
    reminders: { time: '09:00', refresh: 'weekly', verified: {} },
    challenge: { steps: {}, notes: '' },
    // Image generation: the user picks the provider/API and model.
    // A model is remembered per provider. API keys are never stored.
    ai: { provider: 'gemini', models: {}, baseUrl: '', size: '' },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** Merge unknown/partial input onto defaults so older or hand-edited data loads safely. */
export function migrate(raw, now = new Date()) {
  const base = defaultState(now);
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw };
  s.schema = SCHEMA_VERSION;
  s.deadline = normalizeDeadline({ ...base.deadline, ...(raw.deadline || {}) });
  s.tasks = Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask) : [];
  s.display = { ...base.display, ...(raw.display || {}) };
  s.display.maxVisible = Math.min(6, Math.max(1, Math.round(Number(s.display.maxVisible) || 3)));
  s.design = {
    ...base.design,
    ...(raw.design || {}),
    accessories: { ...base.design.accessories, ...(raw.design?.accessories || {}) },
    background: { ...base.design.background, ...(raw.design?.background || {}) },
  };
  s.rects = raw.rects && typeof raw.rects === 'object' ? raw.rects : {};
  s.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots.slice(-MAX_SNAPSHOTS) : [];
  s.reminders = { ...base.reminders, ...(raw.reminders || {}) };
  if (!isValidTimeString(s.reminders.time)) s.reminders.time = '09:00';
  if (!['none', 'daily', 'weekly'].includes(s.reminders.refresh)) s.reminders.refresh = 'weekly';
  s.reminders.verified = s.reminders.verified && typeof s.reminders.verified === 'object' ? s.reminders.verified : {};
  s.challenge = { ...base.challenge, ...(raw.challenge || {}) };
  const rawAi = raw.ai && typeof raw.ai === 'object' ? raw.ai : {};
  s.ai = {
    provider: ['gemini', 'openai', 'compatible'].includes(rawAi.provider) ? rawAi.provider : 'gemini',
    models: rawAi.models && typeof rawAi.models === 'object' ? { ...rawAi.models } : {},
    baseUrl: typeof rawAi.baseUrl === 'string' ? rawAi.baseUrl : '',
    size: typeof rawAi.size === 'string' ? rawAi.size : '',
  };
  // Schema 1 stored a single Gemini model ID.
  if (raw.gemini?.model && !s.ai.models.gemini) s.ai.models.gemini = String(raw.gemini.model);
  for (const k of Object.keys(s.ai.models)) if (typeof s.ai.models[k] !== 'string') delete s.ai.models[k];
  // Never carry a key forward, even if an old or hand-edited backup contained one.
  delete s.gemini;
  delete s.ai.apiKey;
  return s;
}

export function createStorage(backend = globalThis.localStorage) {
  let available = true;
  try {
    const probe = '__lock-in-probe__';
    backend.setItem(probe, '1');
    backend.removeItem(probe);
  } catch {
    available = false;
  }
  return {
    get available() {
      return available;
    },
    load() {
      if (!available) return null;
      try {
        const txt = backend.getItem(STORAGE_KEY);
        return txt ? JSON.parse(txt) : null;
      } catch {
        return null;
      }
    },
    save(state) {
      if (!available) return false;
      try {
        backend.setItem(STORAGE_KEY, JSON.stringify(state));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        backend.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

/** FNV-1a 32-bit hash → 8 hex chars. Used as the snapshot "source-data version". */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Snapshot lifecycle (design doc §5.1). `generated` = rendered in the app,
 * `exported` = file saved/shared, `applied` = the user confirmed they installed
 * and checked it. A web app cannot observe the lock screen, so "applied" is
 * always labelled as user-confirmed.
 */
export function recordExport(state, { version, asOfDate, device, background, now = new Date() }) {
  const snap = {
    id: `s_${now.getTime().toString(36)}`,
    version,
    asOfDate,
    device: { id: device.id, name: device.name, w: device.w, h: device.h },
    background,
    generatedAt: now.toISOString(),
    exportedAt: now.toISOString(),
    appliedAt: null,
    state: 'exported',
  };
  return { ...state, snapshots: [...state.snapshots, snap].slice(-MAX_SNAPSHOTS) };
}

export function markApplied(state, snapshotId, now = new Date()) {
  return {
    ...state,
    snapshots: state.snapshots.map((s) =>
      s.id === snapshotId ? { ...s, state: 'applied', appliedAt: now.toISOString() } : s,
    ),
  };
}

export function latestSnapshot(state, predicate = () => true) {
  for (let i = state.snapshots.length - 1; i >= 0; i -= 1) if (predicate(state.snapshots[i])) return state.snapshots[i];
  return null;
}

/**
 * Truthful wallpaper status for the UI.
 * kind: 'none' | 'exported' | 'current' | 'stale'
 */
export function wallpaperStatus(state, currentVersion) {
  const applied = latestSnapshot(state, (s) => s.state === 'applied');
  const exported = latestSnapshot(state, (s) => s.state === 'exported');
  if (applied) {
    if (applied.version === currentVersion) return { kind: 'current', snapshot: applied, pendingExport: exported && exported.exportedAt > applied.appliedAt ? exported : null };
    return { kind: 'stale', snapshot: applied, pendingExport: exported && exported.exportedAt > applied.appliedAt ? exported : null };
  }
  if (exported) return { kind: 'exported', snapshot: exported, pendingExport: exported };
  return { kind: 'none', snapshot: null, pendingExport: null };
}
