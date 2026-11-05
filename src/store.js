// Local, authoritative data store (design doc §4.1).
//
// The persisted JSON record is the source of truth. Generated images are
// derived output and are never read back as data. Wallpaper snapshots keep
// only metadata (generated → exported → applied), not pixels.
//
// localStorage access is wrapped: in private windows or with blocked storage
// the app still works for the session and warns that data won't persist.

import { localTimeZone, normalizeDeadline, isValidTimeString } from './dates.js';
import { normalizeTask, clip } from './tasks.js';
import { DEVICES, CUSTOM_DEVICE_ID } from './devices.js';

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

// Keys the renderer understands (kept in sync with render/*.js by a unit test).
export const DESIGN_KEYS = {
  paper: ['white', 'cream', 'legal', 'dots'],
  font: ['serif', 'sans', 'mono'],
  desk: ['walnut', 'black', 'marble'],
  lighting: ['day', 'evening'],
};

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback, max = 200) => (typeof v === 'string' ? clip(v, max) : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

function validSnapshot(sn) {
  return (
    isObj(sn) &&
    typeof sn.id === 'string' &&
    typeof sn.version === 'string' &&
    typeof sn.asOfDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(sn.asOfDate) &&
    isObj(sn.device) &&
    typeof sn.device.name === 'string' &&
    ['exported', 'applied'].includes(sn.state) &&
    typeof sn.exportedAt === 'string' &&
    !Number.isNaN(Date.parse(sn.exportedAt)) &&
    (sn.state !== 'applied' || (typeof sn.appliedAt === 'string' && !Number.isNaN(Date.parse(sn.appliedAt))))
  );
}

/**
 * Merge unknown/partial input onto defaults so older, corrupted or
 * hand-edited data always loads into a state every screen can render.
 */
export function migrate(raw, now = new Date()) {
  const base = defaultState(now);
  if (!isObj(raw)) return base;
  const s = { ...base };
  s.createdAt = str(raw.createdAt, base.createdAt);
  s.deadline = normalizeDeadline({ ...base.deadline, ...(isObj(raw.deadline) ? raw.deadline : {}) });
  s.goal = str(raw.goal, '', 600);
  s.capacity = str(raw.capacity, '', 600);

  // Tasks: unique IDs and a unique manual order (up/down swaps orders).
  const seen = new Set();
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter(isObj)
    .map((t, i) => ({ t: normalizeTask(t), i }))
    .sort((a, b) => a.t.order - b.t.order || a.i - b.i)
    .map(({ t }, i) => {
      let id = t.id;
      while (seen.has(id)) id = `${t.id.slice(0, 50)}_${i}${seen.size}`;
      seen.add(id);
      return { ...t, id, order: i + 1 };
    });
  s.tasks = tasks;

  const d = isObj(raw.display) ? raw.display : {};
  s.display = {
    maxVisible: Math.min(6, Math.max(1, Math.round(Number(d.maxVisible) || 3))),
    showDue: typeof d.showDue === 'boolean' ? d.showDue : base.display.showDue,
    eyebrow: str(d.eyebrow, base.display.eyebrow, 24),
    sectionLabel: str(d.sectionLabel, base.display.sectionLabel, 24),
  };

  const ds = isObj(raw.design) ? raw.design : {};
  const acc = isObj(ds.accessories) ? ds.accessories : {};
  const bg = isObj(ds.background) ? ds.background : {};
  s.design = {
    deviceId: oneOf(ds.deviceId, [...DEVICES.map((x) => x.id), CUSTOM_DEVICE_ID], base.design.deviceId),
    customW: Number.isFinite(Number(ds.customW)) ? Number(ds.customW) : base.design.customW,
    customH: Number.isFinite(Number(ds.customH)) ? Number(ds.customH) : base.design.customH,
    desk: oneOf(ds.desk, DESIGN_KEYS.desk, base.design.desk),
    paper: oneOf(ds.paper, DESIGN_KEYS.paper, base.design.paper),
    lighting: oneOf(ds.lighting, DESIGN_KEYS.lighting, base.design.lighting),
    font: oneOf(ds.font, DESIGN_KEYS.font, base.design.font),
    accessories: Object.fromEntries(Object.keys(base.design.accessories).map((k) => [k, typeof acc[k] === 'boolean' ? acc[k] : base.design.accessories[k]])),
    background: {
      type: bg.type === 'custom' ? 'custom' : 'bundled',
      assetId: typeof bg.assetId === 'string' ? bg.assetId : null,
      label: typeof bg.label === 'string' ? bg.label.slice(0, 120) : null,
      model: typeof bg.model === 'string' ? bg.model.slice(0, 120) : null,
      provider: typeof bg.provider === 'string' ? bg.provider : null,
    },
  };
  s.rects = {};
  if (isObj(raw.rects)) {
    for (const [k, r] of Object.entries(raw.rects)) {
      if (isObj(r) && ['x', 'y', 'w', 'h'].every((n) => Number.isFinite(r[n]))) s.rects[k] = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  }
  s.snapshots = (Array.isArray(raw.snapshots) ? raw.snapshots : []).filter(validSnapshot).slice(-MAX_SNAPSHOTS);

  const rm = isObj(raw.reminders) ? raw.reminders : {};
  s.reminders = {
    time: isValidTimeString(rm.time) ? rm.time : '09:00',
    refresh: oneOf(rm.refresh, ['none', 'daily', 'weekly'], 'weekly'),
    verified: {},
  };
  if (isObj(rm.verified)) {
    for (const [uid, v] of Object.entries(rm.verified)) if (isObj(v) && typeof v.sig === 'string') s.reminders.verified[uid] = { sig: v.sig, at: str(v.at, '') };
  }

  const ch = isObj(raw.challenge) ? raw.challenge : {};
  s.challenge = { steps: {}, notes: str(ch.notes, '', 4000) };
  if (isObj(ch.steps)) {
    for (const [n, v] of Object.entries(ch.steps)) if (isObj(v)) s.challenge.steps[n] = { done: Boolean(v.done) };
  }

  const rawAi = isObj(raw.ai) ? raw.ai : {};
  s.ai = {
    provider: oneOf(rawAi.provider, ['gemini', 'openai', 'compatible'], 'gemini'),
    models: {},
    baseUrl: str(rawAi.baseUrl, '', 300),
    size: str(rawAi.size, '', 20),
  };
  if (isObj(rawAi.models)) {
    for (const [k, v] of Object.entries(rawAi.models)) if (typeof v === 'string' && ['gemini', 'openai', 'compatible'].includes(k)) s.ai.models[k] = v.slice(0, 120);
  }
  // Schema 1 stored a single Gemini model ID.
  if (isObj(raw.gemini) && typeof raw.gemini.model === 'string' && !s.ai.models.gemini) s.ai.models.gemini = raw.gemini.model.slice(0, 120);
  // Only known fields are copied above, so an API key can never be carried forward.
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
