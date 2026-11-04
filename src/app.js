// Lock-In app controller: wires the local store, deterministic compositor,
// optional Gemini BYOK scenery, reminders and the challenge checklist.

import {
  countdownText,
  computeCountdown,
  dateInZone,
  formatDateLong,
  formatDateShort,
  formatTimeWithZone,
  localTimeZone,
  normalizeDeadline,
  addDays,
  zonedWallTimeToInstant,
} from './dates.js';
import { createTask, displayLabel, progress, selectVisibleTasks, updateTask } from './tasks.js';
import { DEVICES, CUSTOM_DEVICE_ID, resolveDevice, rectFor, rectKey, clampRect, describeRect, nearestAspectRatio } from './devices.js';
import { planningPrompt, sceneryPrompt } from './prompts.js';
import { parsePlanText } from './plan-import.js';
import { buildIcs, buildReminderItems, googleCalendarUrl, isVerified } from './reminders.js';
import {
  CHALLENGE_STEPS,
  createStorage,
  defaultState,
  hashString,
  markApplied,
  migrate,
  recordExport,
  stableStringify,
  wallpaperStatus,
} from './store.js';
import { renderWallpaper, drawCover, PAPERS, FONTS } from './render/compositor.js';
import { DESKS, LIGHTING, ACCESSORIES } from './render/backgrounds.js';
import * as gemini from './gemini.js';
import { putAsset, getAsset, clearAssets } from './idb.js';

// ---------------------------------------------------------------- utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtStamp = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  }
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// -------------------------------------------------------------------- state

const storage = createStorage(safeLocalStorage());
let state = migrate(storage.load());
let now = new Date();
let bgImage = null; // accepted custom background (ImageBitmap)
let candidate = null; // { image, blob, source, label, model, assessment }
let lastRender = null; // { version, layout, content, device, rect, asOfDate }
let importPreview = [];
let bgMissing = false;

function persist() {
  state.updatedAt = new Date().toISOString();
  const ok = storage.save(state);
  const pill = $('#storage-pill');
  if (!storage.available || !ok) {
    pill.textContent = 'Not saved: browser storage unavailable';
    pill.className = 'pill bad';
  } else {
    pill.textContent = 'Saved on this device';
    pill.className = 'pill';
  }
}

const device = () => resolveDevice(state.design);
const currentRect = () => rectFor(device(), state.rects);
const tz = () => state.deadline.timeZone;
const today = () => dateInZone(now, tz());

function setDeadline(patch) {
  state.deadline = normalizeDeadline({ ...state.deadline, ...patch });
}

// ----------------------------------------------------------- sheet content

function buildContent() {
  const cd = countdownText(state.deadline, now);
  const sel = selectVisibleTasks(state.tasks, state.display.maxVisible);
  const items = sel.visible.map((t) => ({
    id: t.id,
    label: displayLabel(t),
    sub: state.display.showDue && t.due ? `by ${formatDateShort(t.due)}` : '',
  }));
  return {
    content: {
      eyebrow: state.display.eyebrow,
      title: state.deadline.title || 'Your deadline',
      big: cd.big,
      unit: cd.unit,
      dateLine: cd.dateLine,
      sectionLabel: state.display.sectionLabel,
      items,
      hiddenCount: sel.hidden,
      emptyText: 'No open actions. Add your next step.',
      // The as-of date is always printed: the wallpaper is a snapshot.
      footerLeft: cd.asOfLine,
      footerRight: 'LOCK-IN',
    },
    countdown: cd,
    selection: sel,
  };
}

function backgroundId() {
  if (candidate) return `candidate:${candidate.source}`;
  const bg = state.design.background;
  return bg.type === 'custom' && bgImage ? `custom:${bg.assetId}:${bg.label}` : 'bundled';
}

function computeVersion(content, dev, rect) {
  const d = state.design;
  return hashString(
    stableStringify({
      content,
      size: [dev.w, dev.h],
      rect,
      design: { paper: d.paper, font: d.font, desk: d.desk, lighting: d.lighting, accessories: d.accessories },
      bg: backgroundId(),
    }),
  );
}

// ------------------------------------------------------------------ preview

const canvas = $('#canvas');
let raf = 0;
function schedulePreview() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderPreview();
  });
}

function renderPreview() {
  const dev = device();
  const rect = currentRect();
  const { content, countdown, selection } = buildContent();
  const custom = state.design.background.type === 'custom';
  bgMissing = custom && !bgImage && !candidate;
  const bg = candidate?.image || (custom ? bgImage : null);
  const layout = renderWallpaper(canvas, { size: dev, rect, design: state.design, backgroundImage: bg, content });
  lastRender = { version: computeVersion(content, dev, rect), layout, content, device: dev, rect, asOfDate: countdown.asOfDate, selection, countdown };

  const frame = $('#frame');
  frame.classList.toggle('landscape', dev.w > dev.h);
  frame.style.maxWidth = dev.w > dev.h ? '100%' : '';
  $('#preview-meta').textContent = `${dev.name} · ${dev.w}×${dev.h}px`;
  canvas.setAttribute('aria-label', `Lock screen preview: ${content.title}, ${content.big} ${content.unit}. ${content.items.map((i) => i.label).join('; ')}`);
  renderGuides(dev, rect);
  renderWarnings();
  refreshTaskBadges();
  renderWallpaperStatus();
  renderTabMarkers();
}

function renderGuides(dev, rect) {
  const g = $('#guides');
  if (!$('#show-guides').checked) {
    g.innerHTML = '';
    return;
  }
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
  g.innerHTML = dev.guides
    .map(
      (gd, i) =>
        `<div class="guide ${i === 0 && dev.h >= dev.w ? 'clock' : ''}" data-time="${esc(time)}" style="left:${gd.x * 100}%;top:${gd.y * 100}%;width:${gd.w * 100}%;height:${gd.h * 100}%"><span>${esc(gd.label)}</span></div>`,
    )
    .join('');
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function currentWarnings() {
  if (!lastRender) return [];
  const out = [];
  const { layout, device: dev, rect, selection, countdown } = lastRender;
  if (countdown.status === 'unset') out.push({ msg: 'Set a deadline date in step 1.', tab: 'deadline' });
  if (!state.deadline.title) out.push({ msg: 'Add a deadline title in step 1.', tab: 'deadline' });
  for (const w of layout.warnings) {
    if (w.type === 'label-truncated') out.push({ msg: `“${w.label}” doesn't fit in two lines at the minimum readable size. Add a short label in step 2.`, tab: 'plan', taskId: w.id });
    else if (w.type === 'title-truncated') out.push({ msg: 'The deadline title is cut off. Shorten it.', tab: 'deadline' });
    else if (w.type === 'items-overflowed') out.push({ msg: `${plural(w.count, 'action')} moved into “+N more” to keep text readable. Make the paper taller or show fewer actions.`, tab: 'design' });
    else if (w.type === 'paper-small') out.push({ msg: 'The paper is narrow for this screen; text is at its minimum readable size.', tab: 'design' });
    else if (w.type === 'paper-too-short') out.push({ msg: 'The paper is too short for the header. Increase its height.', tab: 'design' });
  }
  if (selection.pinnedOverflow) out.push({ msg: `More actions are pinned than fit. Only the first ${state.display.maxVisible} pinned are shown.`, tab: 'plan' });
  for (const g of dev.guides) {
    if (dev.h >= dev.w || g.label.includes('Clock')) {
      if (overlaps(rect, g)) out.push({ msg: `The paper overlaps the “${g.label}” area and may be covered on the lock screen.`, tab: 'design' });
    }
  }
  if (bgMissing) out.push({ msg: 'Custom background not found on this device. Showing the bundled desk; upload or generate one in step 3.', tab: 'design' });
  if (candidate) out.push({ msg: 'Previewing a new background. Use it or discard it in step 3 before exporting.', tab: 'design' });
  return out;
}

function renderWarnings() {
  const list = currentWarnings();
  $('#warnings').innerHTML = list
    .map((w) => `<li>${esc(w.msg)} <a href="#${w.tab}" data-goto="${w.tab}" ${w.taskId ? `data-task="${esc(w.taskId)}"` : ''}>Fix</a></li>`)
    .join('');
}

// --------------------------------------------------------------------- tabs

const TAB_IDS = ['deadline', 'plan', 'design', 'install', 'reminders', 'challenge'];
function showTab(id, focusTask) {
  if (!TAB_IDS.includes(id)) id = 'deadline';
  for (const t of $$('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === id));
  for (const p of $$('.panel')) p.hidden = p.dataset.panel !== id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (id === 'plan') renderPlanPrompt();
  if (id === 'design') renderSceneryPrompt();
  if (id === 'reminders') renderReminders();
  if (id === 'challenge') renderChallenge();
  if (id === 'install') renderInstall();
  if (focusTask) {
    const input = $(`.task[data-id="${CSS.escape(focusTask)}"] .t-label`);
    if (input) {
      input.focus();
      input.scrollIntoView({ block: 'center' });
    }
  }
}

function renderTabMarkers() {
  const status = lastRender ? wallpaperStatus(state, lastRender.version).kind : 'none';
  const rem = reminderItems();
  const marks = {
    deadline: Boolean(state.deadline.date && state.deadline.title),
    plan: state.tasks.some((t) => t.title),
    design: lastRender ? currentWarnings().filter((w) => w.tab === 'design').length === 0 : false,
    install: status === 'current',
    reminders: rem.length > 0 && rem.every((i) => isVerified(i, state.reminders.verified)),
    challenge: CHALLENGE_STEPS.every((s) => state.challenge.steps[s.n]?.done),
  };
  for (const t of $$('.tab')) t.classList.toggle('done', Boolean(marks[t.dataset.tab]));
}

// ----------------------------------------------------------------- deadline

function initDeadline() {
  const tzSel = $('#dl-tz');
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'];
  }
  const local = localTimeZone();
  for (const z of [local, tz()]) if (!zones.includes(z)) zones.unshift(z);
  tzSel.innerHTML = zones.map((z) => `<option value="${esc(z)}">${esc(z.replace(/_/g, ' '))}${z === local ? ' (this device)' : ''}</option>`).join('');

  $('#dl-title').addEventListener('input', (e) => {
    setDeadline({ title: e.target.value });
    persist();
    schedulePreview();
    renderDeadlineReadout();
  });
  $('#dl-goal').addEventListener('input', (e) => {
    state.goal = e.target.value;
    persist();
  });
  for (const r of $$('input[name="dl-kind"]')) {
    r.addEventListener('change', () => {
      setDeadline({ kind: r.value });
      $('#dl-time-field').hidden = r.value !== 'timed';
      onDeadlineChanged();
    });
  }
  $('#dl-date').addEventListener('change', (e) => {
    setDeadline({ date: e.target.value });
    onDeadlineChanged();
  });
  $('#dl-time').addEventListener('change', (e) => {
    setDeadline({ time: e.target.value || '23:59' });
    onDeadlineChanged();
  });
  tzSel.addEventListener('change', (e) => {
    setDeadline({ timeZone: e.target.value });
    onDeadlineChanged();
  });
}

function syncDeadlineInputs() {
  const dl = state.deadline;
  $('#dl-title').value = dl.title;
  $('#dl-goal').value = state.goal;
  for (const r of $$('input[name="dl-kind"]')) r.checked = r.value === dl.kind;
  $('#dl-time-field').hidden = dl.kind !== 'timed';
  $('#dl-date').value = dl.date;
  $('#dl-time').value = dl.time;
  $('#dl-tz').value = dl.timeZone;
  renderDeadlineReadout();
}

function onDeadlineChanged() {
  persist();
  schedulePreview();
  renderDeadlineReadout();
}

function renderDeadlineReadout() {
  const cd = countdownText(state.deadline, now);
  const el = $('#dl-readout');
  if (cd.status === 'unset') {
    el.className = 'callout';
    el.textContent = 'Choose a due date to start the countdown.';
    return;
  }
  const head = cd.unit ? `${cd.big} ${cd.unit}` : cd.big;
  const exact = state.deadline.kind === 'timed' ? ` Exact instant: ${new Date(state.deadline.instant).toUTCString()}.` : '';
  el.className = `callout ${cd.status === 'overdue' ? 'bad' : cd.status === 'due-today' ? 'warn' : 'ok'}`;
  el.innerHTML = `<strong>${esc(head)}</strong>, ${esc(cd.asOfLine.toLowerCase())} in ${esc(state.deadline.timeZone)}. ${esc(cd.dateLine)}.${esc(exact)}`;
}

// --------------------------------------------------------------------- plan

function deadlineDescription() {
  const dl = state.deadline;
  if (!dl.date) return '';
  if (dl.kind === 'timed') return `${formatDateLong(dl.date)} at ${formatTimeWithZone(dl.instant, dl.timeZone)} (${dl.timeZone})`;
  return `${formatDateLong(dl.date)}, end of day (${dl.timeZone})`;
}

function renderPlanPrompt() {
  $('#plan-prompt').value = planningPrompt({
    goal: state.goal || state.deadline.title,
    deadlineText: deadlineDescription(),
    currentDate: formatDateLong(today()),
    capacity: state.capacity,
    includeFormatHint: $('#plan-format-hint').checked,
  });
}

function initPlan() {
  $('#plan-capacity').addEventListener('input', (e) => {
    state.capacity = e.target.value;
    persist();
    renderPlanPrompt();
  });
  $('#plan-format-hint').addEventListener('change', renderPlanPrompt);
  $('#plan-copy').addEventListener('click', () => copyText($('#plan-prompt').value, 'Planning prompt copied. Paste it into Gemini.'));

  $('#plan-parse').addEventListener('click', () => {
    importPreview = parsePlanText($('#plan-paste').value, { today: today() }).map((it) => ({ ...it, include: true }));
    renderImportPreview();
  });
  $('#plan-import-preview').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i);
    if (Number.isInteger(i)) importPreview[i].include = e.target.checked;
    renderImportPreview(true);
  });
  $('#plan-import-preview').addEventListener('click', (e) => {
    if (e.target.id !== 'plan-import-add') return;
    const existing = new Set(state.tasks.map((t) => `${t.title.toLowerCase()}|${t.due}`));
    let order = nextOrder();
    let added = 0;
    for (const it of importPreview) {
      if (!it.include || existing.has(`${it.title.toLowerCase()}|${it.due}`)) continue;
      state.tasks.push(createTask({ title: it.title, due: it.due, order: order++ }));
      added += 1;
    }
    importPreview = [];
    $('#plan-paste').value = '';
    renderImportPreview();
    persist();
    renderTasks();
    schedulePreview();
    toast(`${plural(added, 'action')} added. Review the dates and labels below.`);
  });

  $('#task-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#task-new-title').value.trim();
    if (!title) return;
    state.tasks.push(createTask({ title, due: $('#task-new-due').value || null, priority: Number($('#task-new-priority').value), order: nextOrder() }));
    $('#task-new-title').value = '';
    $('#task-new-due').value = '';
    persist();
    renderTasks();
    schedulePreview();
    $('#task-new-title').focus();
  });

  const list = $('#task-list');
  list.addEventListener('input', (e) => {
    const li = e.target.closest('.task');
    if (!li) return;
    if (e.target.classList.contains('t-title')) patchTask(li.dataset.id, { title: e.target.value });
    else if (e.target.classList.contains('t-label')) patchTask(li.dataset.id, { label: e.target.value });
  });
  list.addEventListener('change', (e) => {
    const li = e.target.closest('.task');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.classList.contains('t-done')) {
      patchTask(id, { done: e.target.checked });
      li.classList.toggle('done', e.target.checked);
    } else if (e.target.classList.contains('t-due')) patchTask(id, { due: e.target.value || null });
    else if (e.target.classList.contains('t-priority')) patchTask(id, { priority: Number(e.target.value) });
    else if (e.target.classList.contains('t-title') && !e.target.value.trim()) {
      e.target.value = state.tasks.find((t) => t.id === id)?.title || '';
    }
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const li = e.target.closest('.task');
    if (!btn || !li) return;
    const id = li.dataset.id;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    if (btn.classList.contains('t-pin')) patchTask(id, { pinned: !task.pinned });
    else if (btn.classList.contains('t-up') || btn.classList.contains('t-down')) moveTask(id, btn.classList.contains('t-up') ? -1 : 1);
    else if (btn.classList.contains('t-del')) {
      if (!confirm(`Delete “${task.title}”?`)) return;
      state.tasks = state.tasks.filter((t) => t.id !== id);
      persist();
    }
    renderTasks();
    schedulePreview();
  });

  $('#disp-max').addEventListener('input', (e) => {
    const v = Math.min(6, Math.max(1, Math.round(Number(e.target.value) || 3)));
    state.display.maxVisible = v;
    $('#disp-max-warn').hidden = v <= 3;
    persist();
    schedulePreview();
  });
  $('#disp-eyebrow').addEventListener('input', (e) => {
    state.display.eyebrow = e.target.value;
    persist();
    schedulePreview();
  });
  $('#disp-section').addEventListener('input', (e) => {
    state.display.sectionLabel = e.target.value;
    persist();
    schedulePreview();
  });
  $('#disp-due').addEventListener('change', (e) => {
    state.display.showDue = e.target.checked;
    persist();
    schedulePreview();
  });
}

function syncPlanInputs() {
  $('#plan-capacity').value = state.capacity;
  $('#disp-max').value = state.display.maxVisible;
  $('#disp-max-warn').hidden = state.display.maxVisible <= 3;
  $('#disp-eyebrow').value = state.display.eyebrow;
  $('#disp-section').value = state.display.sectionLabel;
  $('#disp-due').checked = state.display.showDue;
}

function renderImportPreview(keepScroll) {
  const el = $('#plan-import-preview');
  if (!importPreview.length) {
    el.innerHTML = $('#plan-paste').value.trim() && !keepScroll ? '<p class="hint">No dated actions or list items found. Try one action per line.</p>' : '';
    return;
  }
  const n = importPreview.filter((i) => i.include).length;
  el.innerHTML = `
    <p class="hint">Review before adding. Uncheck anything you don't accept.</p>
    <ul class="import-list">${importPreview
      .map(
        (it, i) =>
          `<li><label class="check"><input type="checkbox" data-i="${i}" ${it.include ? 'checked' : ''}/> <span><strong>${esc(it.due ? formatDateLong(it.due) : 'No date')}</strong> · ${esc(it.title)}</span></label></li>`,
      )
      .join('')}</ul>
    <div class="buttons"><button class="btn primary" id="plan-import-add" ${n ? '' : 'disabled'}>Add ${plural(n, 'action')}</button></div>`;
}

function nextOrder() {
  return state.tasks.reduce((m, t) => Math.max(m, t.order), 0) + 1;
}

function patchTask(id, patch) {
  state.tasks = state.tasks.map((t) => (t.id === id ? updateTask(t, patch) : t));
  persist();
  schedulePreview();
}

function moveTask(id, dir) {
  const ordered = [...state.tasks].sort((a, b) => a.order - b.order);
  const i = ordered.findIndex((t) => t.id === id);
  const j = i + dir;
  if (j < 0 || j >= ordered.length) return;
  const a = ordered[i];
  const b = ordered[j];
  state.tasks = state.tasks.map((t) => (t.id === a.id ? { ...t, order: b.order } : t.id === b.id ? { ...t, order: a.order } : t));
  persist();
}

function renderTasks() {
  const list = $('#task-list');
  const ordered = [...state.tasks].sort((a, b) => a.order - b.order);
  if (!ordered.length) {
    list.innerHTML = '<li class="empty">No actions yet. Add one above or paste a plan from Gemini.</li>';
  } else {
    list.innerHTML = ordered
      .map(
        (t) => `
      <li class="task ${t.done ? 'done' : ''}" data-id="${esc(t.id)}">
        <input type="checkbox" class="t-done" ${t.done ? 'checked' : ''} aria-label="Mark “${esc(t.title)}” done" />
        <div class="t-main">
          <input type="text" class="t-title" value="${esc(t.title)}" maxlength="200" aria-label="Full title" />
          <input type="text" class="t-label" value="${esc(t.label)}" maxlength="60" placeholder="Short label for the lock screen (optional)" aria-label="Short lock-screen label" />
          <div class="t-meta">
            <input type="date" class="t-due" value="${esc(t.due || '')}" aria-label="Due date" />
            <select class="t-priority" aria-label="Priority">
              ${[1, 2, 3].map((p) => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${['', 'High', 'Medium', 'Low'][p]}</option>`).join('')}
            </select>
            <span class="badge t-badge" hidden></span>
          </div>
        </div>
        <div class="t-tools">
          <button type="button" class="icon-btn t-pin" aria-pressed="${t.pinned}" title="${t.pinned ? 'Unpin' : 'Pin to the lock screen'}" aria-label="Pin">★</button>
          <button type="button" class="icon-btn t-del" title="Delete" aria-label="Delete">✕</button>
          <button type="button" class="icon-btn t-up" title="Move up" aria-label="Move up">↑</button>
          <button type="button" class="icon-btn t-down" title="Move down" aria-label="Move down">↓</button>
        </div>
      </li>`,
      )
      .join('');
  }
  refreshTaskBadges();
}

function refreshTaskBadges() {
  const sel = selectVisibleTasks(state.tasks, state.display.maxVisible);
  const shown = lastRender ? lastRender.layout.shownItems : sel.visible.length;
  const pos = new Map(sel.visible.map((t, i) => [t.id, i]));
  for (const li of $$('#task-list .task')) {
    const badge = $('.t-badge', li);
    const i = pos.get(li.dataset.id);
    if (i === undefined) {
      badge.hidden = true;
    } else {
      badge.hidden = false;
      badge.textContent = i < shown ? `On lock screen #${i + 1}` : 'In “+N more” (no room)';
      badge.classList.toggle('warn', i >= shown);
    }
  }
  const p = progress(state.tasks);
  $('#task-progress').textContent = p.total ? `${p.done}/${p.total} done` : '';
}

// ------------------------------------------------------------------- design

function initDesign() {
  const groups = {};
  for (const d of DEVICES) (groups[d.group] ||= []).push(d);
  $('#dev-select').innerHTML =
    Object.entries(groups)
      .map(([g, ds]) => `<optgroup label="${esc(g)}">${ds.map((d) => `<option value="${d.id}">${esc(d.name)} · ${d.w}×${d.h}</option>`).join('')}</optgroup>`)
      .join('') + `<option value="${CUSTOM_DEVICE_ID}">Custom size…</option>`;
  $('#des-paper').innerHTML = Object.entries(PAPERS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  $('#des-font').innerHTML = Object.entries(FONTS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  $('#des-desk').innerHTML = Object.entries(DESKS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  $('#des-lighting').innerHTML = Object.entries(LIGHTING).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  $('#des-accessories').innerHTML = Object.entries(ACCESSORIES)
    .map(([k, v]) => `<label class="check"><input type="checkbox" data-acc="${k}" /> ${esc(v.name)}</label>`)
    .join('');

  $('#dev-select').addEventListener('change', (e) => {
    state.design.deviceId = e.target.value;
    onDesignChanged(true);
  });
  for (const id of ['dev-w', 'dev-h']) {
    $(`#${id}`).addEventListener('change', (e) => {
      state.design[id === 'dev-w' ? 'customW' : 'customH'] = Number(e.target.value);
      onDesignChanged(true);
    });
  }
  for (const k of ['x', 'y', 'w', 'h']) {
    $(`#rect-${k}`).addEventListener('input', (e) => {
      const r = { ...currentRect(), [k]: Number(e.target.value) / 100 };
      state.rects[rectKey(device())] = clampRect(r);
      persist();
      syncRectInputs();
      schedulePreview();
    });
  }
  $('#rect-reset').addEventListener('click', () => {
    delete state.rects[rectKey(device())];
    onDesignChanged(true);
  });
  $('#show-guides').addEventListener('change', schedulePreview);

  const bind = (sel, key) =>
    $(sel).addEventListener('change', (e) => {
      state.design[key] = e.target.value;
      onDesignChanged();
    });
  bind('#des-paper', 'paper');
  bind('#des-font', 'font');
  bind('#des-desk', 'desk');
  bind('#des-lighting', 'lighting');
  $('#des-accessories').addEventListener('change', (e) => {
    const k = e.target.dataset.acc;
    if (k) state.design.accessories[k] = e.target.checked;
    onDesignChanged();
  });
  for (const r of $$('input[name="bg-type"]')) {
    r.addEventListener('change', () => {
      state.design.background.type = r.value;
      if (r.value === 'custom') $('#scenery-card').open = true;
      onDesignChanged();
    });
  }

  $('#scenery-copy').addEventListener('click', () => copyText($('#scenery-prompt').value, 'Scenery prompt copied.'));
  $('#bg-upload').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Use a PNG, JPEG or WebP image.');
    if (file.size > 20 * 1024 * 1024) return toast('That image is over 20 MB.');
    try {
      const image = await createImageBitmap(file);
      setCandidate({ image, blob: file, source: 'upload', label: file.name, model: null });
    } catch {
      toast('Could not read that image.');
    }
  });

  // BYOK
  $('#gem-model').addEventListener('change', (e) => {
    state.gemini.model = e.target.value.trim() || gemini.DEFAULT_IMAGE_MODEL;
    persist();
  });
  $('#gem-key').addEventListener('input', (e) => gemini.setApiKey(e.target.value));
  $('#gem-forget').addEventListener('click', () => {
    gemini.forgetApiKey();
    $('#gem-key').value = '';
    gemStatus('Key forgotten.', '');
  });
  $('#gem-verify').addEventListener('click', async () => {
    gemStatus('Checking…', '');
    try {
      const m = await gemini.verifyModel(state.gemini.model);
      gemStatus(`Connected. ${m.displayName} is available to this key.`, 'ok');
    } catch (err) {
      gemStatus(err.message, 'bad');
    }
  });
  $('#gem-generate').addEventListener('click', generateWithGemini);
  $('#candidate-accept').addEventListener('click', acceptCandidate);
  $('#candidate-discard').addEventListener('click', () => {
    candidate = null;
    renderCandidate();
    schedulePreview();
  });
}

function gemStatus(msg, kind) {
  const el = $('#gem-status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

async function generateWithGemini() {
  if (!gemini.hasApiKey()) return gemStatus('Enter your Gemini API key first.', 'bad');
  const dev = device();
  const btn = $('#gem-generate');
  btn.disabled = true;
  gemStatus('Generating scenery… this can take up to a minute.', '');
  try {
    const res = await gemini.generateScenery({
      model: state.gemini.model,
      prompt: $('#scenery-prompt').value,
      aspectRatio: nearestAspectRatio(dev.w, dev.h),
    });
    const image = await createImageBitmap(res.blob);
    if (image.width < 256 || image.height < 256) throw new gemini.GeminiError('no-image', 'The returned image was too small to use.');
    setCandidate({ image, blob: res.blob, source: 'gemini', label: `Gemini (${state.gemini.model})`, model: state.gemini.model });
    gemStatus('Done. Review the preview and choose whether to use it.', 'ok');
  } catch (err) {
    gemStatus(err.message || 'Generation failed. Your current background is unchanged.', 'bad');
  } finally {
    btn.disabled = false;
  }
}

function setCandidate(c) {
  const dev = device();
  const guides = dev.guides.filter((g) => dev.h >= dev.w || g.label.includes('Clock'));
  c.assessment = gemini.assessScenery(c.image, dev, guides, drawCover);
  candidate = c;
  renderCandidate();
  schedulePreview();
}

function renderCandidate() {
  const bar = $('#candidate-bar');
  bar.hidden = !candidate;
  if (!candidate) return;
  const a = candidate.assessment;
  const scale = Math.max(device().w / candidate.image.width, device().h / candidate.image.height);
  const upscale = scale > 1.05 ? ` It is ${candidate.image.width}×${candidate.image.height}px and will be upscaled ${scale.toFixed(1)}× (may look soft).` : '';
  $('#candidate-msg').textContent = a.ok
    ? `New background previewed: ${candidate.label}. The clock and shortcut areas look calm.${upscale}`
    : `New background previewed: ${candidate.label}. The ${a.busyRegions.join(' and ')} area looks busy and may hurt readability. Consider regenerating.${upscale}`;
}

async function acceptCandidate() {
  if (!candidate) return;
  const c = candidate;
  const saved = await putAsset('bg-current', c.blob);
  bgImage = c.image;
  state.design.background = { type: 'custom', assetId: 'bg-current', label: c.label, model: c.model };
  candidate = null;
  persist();
  syncDesignInputs();
  renderCandidate();
  schedulePreview();
  toast(saved ? 'Background saved on this device.' : 'Background in use for this session (browser storage unavailable).');
}

function onDesignChanged(deviceChanged) {
  persist();
  syncDesignInputs();
  renderSceneryPrompt();
  schedulePreview();
  if (deviceChanged && candidate) setCandidate(candidate); // re-assess for the new size
}

function syncRectInputs() {
  const r = currentRect();
  for (const k of ['x', 'y', 'w', 'h']) {
    $(`#rect-${k}`).value = (r[k] * 100).toFixed(1);
    $(`#rect-${k}-out`).textContent = `${Math.round(r[k] * 100)}%`;
  }
}

function syncDesignInputs() {
  const d = state.design;
  $('#dev-select').value = d.deviceId;
  $('#dev-custom').hidden = d.deviceId !== CUSTOM_DEVICE_ID;
  $('#dev-w').value = d.customW;
  $('#dev-h').value = d.customH;
  $('#des-paper').value = d.paper;
  $('#des-font').value = d.font;
  $('#des-desk').value = d.desk;
  $('#des-lighting').value = d.lighting;
  for (const cb of $$('#des-accessories input')) cb.checked = Boolean(d.accessories[cb.dataset.acc]);
  for (const r of $$('input[name="bg-type"]')) r.checked = r.value === d.background.type;
  $('#bundled-controls').hidden = d.background.type !== 'bundled';
  $('#gem-model').value = state.gemini.model;
  $('#bg-current').textContent =
    d.background.type === 'custom'
      ? bgImage
        ? `Using: ${d.background.label || 'custom background'}.`
        : 'No custom background yet. Upload one or generate it with your key.'
      : '';
  syncRectInputs();
}

function renderSceneryPrompt() {
  const d = state.design;
  const dev = device();
  const acc = Object.entries(d.accessories)
    .filter(([, on]) => on)
    .map(([k]) => ACCESSORIES[k]?.prompt)
    .filter(Boolean);
  $('#scenery-prompt').value = sceneryPrompt({
    desk: DESKS[d.desk]?.prompt,
    lighting: LIGHTING[d.lighting]?.prompt,
    accessories: acc.join(', '),
    rectDescription: describeRect(currentRect()),
    orientation: dev.h >= dev.w ? 'vertical' : 'horizontal',
  });
}

async function loadBackground() {
  const bg = state.design.background;
  if (bg.type !== 'custom' || !bg.assetId) return;
  const blob = await getAsset(bg.assetId);
  if (blob) {
    try {
      bgImage = await createImageBitmap(blob);
    } catch {
      bgImage = null;
    }
  }
  syncDesignInputs();
  schedulePreview();
}

// ------------------------------------------------------------------ install

function initInstall() {
  $('#export-png').addEventListener('click', () => exportPng(false));
  $('#export-png-2').addEventListener('click', () => exportPng(false));
  $('#share-png').addEventListener('click', () => exportPng(true));
  try {
    const probe = new File([new Blob(['x'])], 'x.png', { type: 'image/png' });
    $('#share-png').hidden = !(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch {
    $('#share-png').hidden = true;
  }
  $('#apply-card').addEventListener('change', () => {
    $('#mark-applied').disabled = !$$('.apply-check').every((c) => c.checked);
  });
  $('#mark-applied').addEventListener('click', () => {
    const st = wallpaperStatus(state, lastRender?.version);
    if (!st.pendingExport) return;
    state = markApplied(state, st.pendingExport.id);
    for (const c of $$('.apply-check')) c.checked = false;
    $('#mark-applied').disabled = true;
    persist();
    renderInstall();
    renderWallpaperStatus();
    renderTabMarkers();
    toast('Marked as installed. Lock-In will tell you when it goes out of date.');
  });
}

async function exportPng(share) {
  if (candidate) {
    toast('Use or discard the new background first (step 3).');
    showTab('design');
    return;
  }
  renderPreview();
  const { version, device: dev, asOfDate, content } = lastRender;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return toast('Export failed: the image could not be encoded.');
  const name = `lock-in-${slug(content.title) || 'deadline'}-${dev.w}x${dev.h}-as-of-${asOfDate}.png`;
  if (share) {
    try {
      await navigator.share({ files: [new File([blob], name, { type: 'image/png' })], title: 'Lock-In wallpaper' });
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled: nothing was exported
      return toast('Sharing failed. Try Download PNG instead.');
    }
  } else {
    download(blob, name);
  }
  state = recordExport(state, { version, asOfDate, device: dev, background: backgroundId() });
  persist();
  renderInstall();
  renderWallpaperStatus();
  toast('Exported. Set it as your lock screen, then confirm in step 4.');
}

function statusSummary() {
  if (!lastRender) return { kind: 'none' };
  return wallpaperStatus(state, lastRender.version);
}

function renderWallpaperStatus() {
  const st = statusSummary();
  const pill = $('#wallpaper-pill');
  const map = {
    none: ['No wallpaper exported yet', 'pill'],
    exported: ['Exported, installation not confirmed', 'pill warn'],
    current: ['Installed wallpaper is current', 'pill ok'],
    stale: ['Installed wallpaper is out of date', 'pill bad'],
  };
  const [text, cls] = map[st.kind];
  pill.textContent = text;
  pill.className = cls;
  if (!$('[data-panel="install"]').hidden) renderInstall();
}

function renderInstall() {
  const st = statusSummary();
  const el = $('#install-status');
  const s = st.snapshot;
  if (st.kind === 'none') {
    el.className = 'callout';
    el.textContent = 'Nothing exported yet. Download the PNG, set it as your lock screen, then confirm below.';
  } else if (st.kind === 'exported') {
    el.className = 'callout warn';
    el.textContent = `Exported ${fmtStamp(s.exportedAt)} for ${s.device.name}. Installation not confirmed yet.`;
  } else if (st.kind === 'current') {
    el.className = 'callout ok';
    el.textContent = `Installed (you confirmed ${fmtStamp(s.appliedAt)}). It matches your current plan and today's countdown.`;
  } else {
    const dateChanged = s.asOfDate !== lastRender.asOfDate;
    el.className = 'callout bad';
    el.textContent = `Your installed wallpaper (confirmed ${fmtStamp(s.appliedAt)}) is out of date: ${
      dateChanged ? `it shows the countdown as of ${formatDateLong(s.asOfDate)}` : 'your plan or design changed since'
    }. Export a fresh one.`;
  }
  $('#apply-card').hidden = !st.pendingExport;
  const snaps = [...state.snapshots].reverse().slice(0, 8);
  $('#snapshot-list').innerHTML = snaps.length
    ? snaps
        .map(
          (sn) =>
            `<li><span>${esc(fmtStamp(sn.exportedAt))} · ${esc(sn.device.name)} · as of ${esc(formatDateShort(sn.asOfDate))}</span><span>${
              sn.state === 'applied' ? `Installed ✓ (confirmed ${esc(fmtStamp(sn.appliedAt))})` : 'Exported'
            }${lastRender && sn.version === lastRender.version ? ' · matches preview' : ''}</span></li>`,
        )
        .join('')
    : '<li class="empty">No exports yet.</li>';
}

// ---------------------------------------------------------------- reminders

function reminderItems() {
  return buildReminderItems(state.deadline, state.tasks, { time: state.reminders.time, refresh: state.reminders.refresh, now });
}

function initReminders() {
  $('#rem-time').addEventListener('change', (e) => {
    state.reminders.time = e.target.value || '09:00';
    persist();
    renderReminders();
  });
  $('#rem-refresh').addEventListener('change', (e) => {
    state.reminders.refresh = e.target.value;
    persist();
    renderReminders();
  });
  $('#rem-ics').addEventListener('click', () => {
    const items = reminderItems();
    if (!items.length) return toast('Add dated actions or a deadline first.');
    download(new Blob([buildIcs(items, { calendarName: `Lock-In: ${state.deadline.title || 'deadline'}` })], { type: 'text/calendar' }), `lock-in-reminders-${slug(state.deadline.title) || 'plan'}.ics`);
    toast('Calendar file downloaded. Import it, then tick each reminder you can see in your calendar.');
  });
  $('#rem-list').addEventListener('change', (e) => {
    const uid = e.target.dataset.uid;
    if (!uid) return;
    const item = reminderItems().find((i) => i.uid === uid);
    if (!item) return;
    if (e.target.checked) state.reminders.verified[uid] = { sig: item.sig, at: new Date().toISOString() };
    else delete state.reminders.verified[uid];
    persist();
    renderReminders();
    renderTabMarkers();
  });
}

function renderReminders() {
  $('#rem-time').value = state.reminders.time;
  $('#rem-refresh').value = state.reminders.refresh;
  const items = reminderItems();
  const v = state.reminders.verified;
  $('#rem-list').innerHTML = items.length
    ? items
        .map((it) => {
          const ok = isVerified(it, v);
          const changed = !ok && v[it.uid];
          const when = `${formatDateLong(it.date)} · ${formatTimeWithZone(it.start, it.timeZone)}${it.rrule ? ` · repeats ${it.rrule.startsWith('FREQ=DAILY') ? 'daily' : 'weekly'} until the deadline` : ''}`;
          return `<li class="rem ${ok ? 'verified' : ''}">
            <div><strong>${esc(it.title)}</strong><div class="when">${esc(when)}</div>${changed ? '<div class="when">⚠ Changed since you verified it. Update your calendar and re-check.</div>' : ''}</div>
            <div class="rem-actions">
              <a href="${esc(googleCalendarUrl(it))}" target="_blank" rel="noopener">Add to Google Calendar ↗</a>
              <label class="check"><input type="checkbox" data-uid="${esc(it.uid)}" ${ok ? 'checked' : ''}/> Seen in my calendar</label>
            </div>
          </li>`;
        })
        .join('')
    : '<li class="empty">Add a deadline date and dated actions to build a reminder schedule.</li>';
  const done = items.filter((i) => isVerified(i, v)).length;
  const sum = $('#rem-summary');
  sum.className = `callout ${items.length && done === items.length ? 'ok' : ''}`;
  sum.textContent = items.length ? `${done} of ${items.length} reminders verified in your calendar.` : '';
}

// ---------------------------------------------------------------- challenge

function autoEvidence(n) {
  const st = statusSummary();
  const rem = reminderItems();
  const verified = rem.filter((i) => isVerified(i, state.reminders.verified)).length;
  const warnings = currentWarnings().length;
  switch (n) {
    case 2:
      return state.deadline.date ? `Deadline: ${deadlineDescription()} · Device: ${device().name} (${device().w}×${device().h})` : 'No deadline date yet.';
    case 3: {
      const p = progress(state.tasks);
      return `${plural(p.total, 'action')} in the plan; ${lastRender?.layout.shownItems ?? 0} shown on the lock screen.`;
    }
    case 4:
      return warnings ? `Preview has ${plural(warnings, 'warning')}.` : 'Preview has no readability warnings.';
    case 5:
      return st.kind === 'current' ? `Installed and confirmed ${fmtStamp(st.snapshot.appliedAt)}.` : st.kind === 'stale' ? 'Installed wallpaper is out of date.' : 'Not confirmed as installed yet.';
    case 6:
      return rem.length ? `${verified} of ${rem.length} reminders verified.` : 'No reminders built yet.';
    default:
      return '';
  }
}

function initChallenge() {
  $('#challenge-steps').addEventListener('change', (e) => {
    const n = Number(e.target.dataset.step);
    if (!n) return;
    state.challenge.steps[n] = { ...(state.challenge.steps[n] || {}), done: e.target.checked };
    persist();
    renderChallenge();
    renderTabMarkers();
  });
  $('#challenge-notes').addEventListener('input', (e) => {
    state.challenge.notes = e.target.value;
    persist();
  });
  $('#data-export').addEventListener('click', () => {
    const json = JSON.stringify(state, null, 2);
    download(new Blob([json], { type: 'application/json' }), `lock-in-backup-${today()}.json`);
  });
  $('#data-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!confirm('Replace your current Lock-In data with this backup?')) return;
      state = migrate(raw);
      bgImage = null;
      persist();
      syncAll();
      loadBackground();
      toast('Backup imported. Custom background images are not part of backups.');
    } catch {
      toast('That file is not a valid Lock-In backup.');
    }
  });
  $('#data-sample').addEventListener('click', () => {
    if (state.tasks.length && !confirm('Replace your current deadline and actions with sample data?')) return;
    loadSample();
  });
  $('#data-reset').addEventListener('click', async () => {
    if (!confirm('Erase all Lock-In data in this browser? This cannot be undone.')) return;
    storage.clear();
    await clearAssets();
    gemini.forgetApiKey();
    state = defaultState();
    bgImage = null;
    candidate = null;
    persist();
    syncAll();
    toast('All data erased.');
  });
}

function renderChallenge() {
  $('#challenge-steps').innerHTML = CHALLENGE_STEPS.map((s) => {
    const done = Boolean(state.challenge.steps[s.n]?.done);
    const ev = autoEvidence(s.n);
    return `<li class="${done ? 'done' : ''}">
      <label class="check"><input type="checkbox" data-step="${s.n}" ${done ? 'checked' : ''}/> <span><strong>${s.n}. ${esc(s.title)}</strong><br /><span class="muted">Done when: ${esc(s.done)}</span></span></label>
      ${ev ? `<div class="auto">${esc(ev)}</div>` : ''}
    </li>`;
  }).join('');
  $('#challenge-notes').value = state.challenge.notes;
}

// -------------------------------------------------------------- sample data

function loadSample() {
  const zone = localTimeZone();
  const t0 = dateInZone(new Date(), zone);
  state.deadline = normalizeDeadline({ title: 'Capstone final report', kind: 'date', date: addDays(t0, 30), time: '23:59', timeZone: zone });
  state.goal = 'Submit a 20-page capstone report with a working demo and slides';
  state.capacity = 'About 1.5 hours on weekdays, free Saturday mornings';
  const mk = (title, label, d, priority = 2, pinned = false) => ({ title, label, due: addDays(t0, d), priority, pinned });
  const items = [
    mk('Confirm rubric and formatting requirements with the instructor', 'Confirm rubric', 2, 1),
    mk('Draft the full outline with section owners and page budgets', 'Draft outline', 5),
    mk('Finish data analysis and export all figures', 'Finish analysis + figures', 12, 1),
    mk('Write the first complete draft', 'First full draft', 19),
    mk('Peer review swap and revisions', 'Peer review + revise', 24),
    mk('Final review buffer: proofread, citations, PDF export', 'Final review buffer', 28),
  ];
  state.tasks = items.map((it, i) => createTask({ ...it, order: i + 1 }));
  state.reminders.verified = {};
  persist();
  syncAll();
  toast('Sample data loaded. It is fictional, so replace it with your real deadline.');
}

// --------------------------------------------------------------------- misc

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast('Copy failed. Select the text and copy it manually.');
  }
}

function syncAll() {
  syncDeadlineInputs();
  syncPlanInputs();
  syncDesignInputs();
  renderTasks();
  renderPlanPrompt();
  renderSceneryPrompt();
  renderCandidate();
  renderReminders();
  renderChallenge();
  renderPreview();
  renderInstall();
}

function tick() {
  const before = countdownKey();
  now = new Date();
  if (countdownKey() !== before) {
    // Midnight rollover or a timed deadline passing: recompute everything.
    renderDeadlineReadout();
    renderPreview();
    renderReminders();
  }
}
function countdownKey() {
  const c = computeCountdown(state.deadline, now);
  return `${c.status}|${c.days}|${c.asOfDate}`;
}

function init() {
  initDeadline();
  initPlan();
  initDesign();
  initInstall();
  initReminders();
  initChallenge();

  for (const t of $$('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    showTab(a.dataset.goto, a.dataset.task);
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
  setInterval(tick, 30_000);

  if (!storage.load() && !state.tasks.length && new URLSearchParams(location.search).has('sample')) loadSample();
  syncAll();
  showTab(location.hash.slice(1) || 'deadline');
  loadBackground();
  persist();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Expose a tiny hook for automated smoke tests / screenshots.
window.__lockIn = { get state() { return state; }, get lastRender() { return lastRender; }, loadSample, zonedWallTimeToInstant };

init();
