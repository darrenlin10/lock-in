// Lock-In app controller: wires the local store, deterministic compositor,
// optional bring-your-own-key scenery, reminders and settings.

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
  setDisplayLocale,
  getDisplayLocale,
} from './dates.js';
import { createTask, displayLabel, progress, selectVisibleTasks, updateTask } from './tasks.js';
import { DEVICES, CUSTOM_DEVICE_ID, resolveDevice, rectFor, rectKey, clampRect, describeRect, detectDevice, MAX_CANVAS_AREA } from './devices.js';
import { planningPrompt, sceneryPrompt } from './prompts.js';
import { parsePlanText } from './plan-import.js';
import { buildIcs, buildReminderItems, googleCalendarUrl, isVerified } from './reminders.js';
import {
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
import { DESKS, LIGHTING, ACCESSORIES, makeCanvas, freeCanvas } from './render/backgrounds.js';
import * as ai from './ai.js';
import { putAsset, getAsset, clearAssets } from './idb.js';

// ---------------------------------------------------------------- utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtStamp = (iso) =>
  new Date(iso).toLocaleString(getDisplayLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  }
}

let toastTimer = 0;
let toastActionFn = null;
/** Show a short message; optionally with one action button (e.g. Undo). */
function toast(msg, action) {
  const el = $('#toast');
  $('#toast-text').textContent = msg;
  const btn = $('#toast-action');
  toastActionFn = action ? action.run : null;
  btn.hidden = !action;
  if (action) btn.textContent = action.label;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    toastActionFn = null;
  }, action ? 7000 : 3200);
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

setDisplayLocale(navigator.language);
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
    pill.textContent = 'Not saved: browser storage is full or blocked';
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
  schedulePngPrepare();
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
  const late = state.tasks.filter((t) => !t.done && t.title && t.due && state.deadline.date && t.due > state.deadline.date);
  if (late.length) {
    out.push({ msg: `${plural(late.length, 'action')} ${late.length === 1 ? 'is' : 'are'} due after the deadline (${formatDateShort(state.deadline.date)}). Move ${late.length === 1 ? 'it' : 'them'} earlier.`, tab: 'plan', taskId: late[0].id });
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

const TAB_IDS = ['deadline', 'plan', 'design', 'install', 'reminders'];
function showTab(id, focusTask) {
  if (!TAB_IDS.includes(id)) id = 'deadline';
  for (const t of $$('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === id));
    t.tabIndex = t.dataset.tab === id ? 0 : -1;
    // Keep the selected tab visible when the tab bar scrolls (phones).
    if (t.dataset.tab === id) t.parentElement.scrollTo?.({ left: Math.max(0, t.offsetLeft - 16), behavior: 'smooth' });
  }
  for (const p of $$('.panel')) p.hidden = p.dataset.panel !== id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (id === 'plan') renderPlanPrompt();
  if (id === 'design') renderSceneryPrompt();
  if (id === 'reminders') renderReminders();
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
    // "Done" only once there is something to design, not on an empty start.
    design: Boolean(state.deadline.date) && lastRender ? currentWarnings().filter((w) => w.tab === 'design').length === 0 : false,
    install: status === 'current',
    reminders: rem.some((i) => !i.past) && rem.filter((i) => !i.past).every((i) => isVerified(i, state.reminders.verified)),
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
    // An empty title would hide the task everywhere; keep the last real one
    // until the user types something (it is restored on blur).
    if (e.target.classList.contains('t-title')) {
      if (e.target.value.trim()) patchTask(li.dataset.id, { title: e.target.value });
    }
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
      state.tasks = state.tasks.filter((t) => t.id !== id);
      persist();
      const name = task.title.length > 40 ? `${task.title.slice(0, 40)}…` : task.title;
      toast(`Deleted “${name}”.`, {
        label: 'Undo',
        run: () => {
          // Put back only the deleted action (it keeps its place via `order`),
          // so edits made since the delete aren't lost.
          if (!state.tasks.some((t) => t.id === task.id)) state.tasks = [...state.tasks, task];
          persist();
          renderTasks();
          schedulePreview();
        },
      });
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
    if (file.size > 50 * 1024 * 1024) return toast('That image is over 50 MB. Try a smaller copy.');
    try {
      const { image, blob } = await decodeBackground(file);
      setCandidate({ image, blob, source: 'upload', label: file.name.slice(0, 80), model: null });
    } catch {
      toast("Couldn't read that image. Try a PNG or JPEG.");
    }
  });

  // BYOK: the user picks the provider/API and the model.
  $('#ai-provider').innerHTML = Object.values(ai.PROVIDERS)
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join('');
  $('#ai-provider').addEventListener('change', (e) => {
    state.ai.provider = e.target.value;
    resetAiSession(`Switched to ${ai.PROVIDERS[state.ai.provider].name}. Enter a key for this provider.`);
    persist();
    syncAiInputs();
  });
  $('#ai-base').addEventListener('change', (e) => {
    const next = e.target.value.trim();
    if (next === state.ai.baseUrl) return;
    state.ai.baseUrl = next;
    persist();
    // A key entered for one endpoint is never sent to another.
    resetAiSession('Base URL changed. Enter the key for this endpoint.');
    try {
      if (next) ai.normalizeBaseUrl(next);
    } catch (err) {
      aiStatus(err.message, 'bad');
    }
  });
  $('#ai-key').addEventListener('input', (e) => ai.setApiKey(e.target.value));
  $('#ai-model').addEventListener('input', (e) => {
    state.ai.models[state.ai.provider] = e.target.value.trim();
    persist();
    const dev = device();
    $('#ai-size').placeholder = `automatic (${ai.autoImageSize(currentModel() || '', dev.w, dev.h)})`;
  });
  $('#ai-size').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    state.ai.size = v;
    persist();
    if (v && !ai.isValidSize(v)) aiStatus('Image size must look like 1024x1536. Leave it blank for automatic.', 'bad');
    else aiStatus('', '');
  });
  $('#ai-show-all').addEventListener('change', renderModelPicker);
  $('#ai-model-pick').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.ai.models[state.ai.provider] = e.target.value;
    $('#ai-model').value = e.target.value;
    persist();
    aiStatus(`Model set to ${e.target.value}.`, 'ok');
  });
  $('#ai-load-models').addEventListener('click', async () => {
    aiStatus('Loading models…', '');
    try {
      loadedModels = await ai.listModels(aiConfig());
      renderModelPicker();
      const images = loadedModels.filter((m) => m.image).length;
      aiStatus(
        images
          ? `${plural(images, 'image model')} found (of ${loadedModels.length} total). Pick one below.`
          : `${plural(loadedModels.length, 'model')} found, none named like an image model. Tick “Include non-image models” to see them all.`,
        images ? 'ok' : '',
      );
    } catch (err) {
      aiStatus(err.message, 'bad');
    }
  });
  $('#ai-forget').addEventListener('click', () => resetAiSession('Key forgotten.'));
  $('#ai-verify').addEventListener('click', async () => {
    aiStatus('Checking…', '');
    try {
      const m = await ai.verifyModel(aiConfig());
      aiStatus(`Connected. ${m.displayName} is available to this key.`, 'ok');
    } catch (err) {
      aiStatus(err.message, 'bad');
    }
  });
  $('#ai-generate').addEventListener('click', generateWithAi);
  $('#candidate-accept').addEventListener('click', acceptCandidate);
  $('#candidate-discard').addEventListener('click', () => {
    candidate?.image.close?.();
    candidate = null;
    renderCandidate();
    schedulePreview();
  });
}

let loadedModels = [];

function currentModel() {
  const saved = state.ai.models[state.ai.provider];
  return saved !== undefined ? saved : ai.PROVIDERS[state.ai.provider].defaultModel;
}

function aiConfig() {
  return { provider: state.ai.provider, model: currentModel(), baseUrl: state.ai.baseUrl, size: state.ai.size };
}

function resetAiSession(msg) {
  ai.forgetApiKey();
  $('#ai-key').value = '';
  loadedModels = [];
  renderModelPicker();
  aiStatus(msg, '');
}

function syncAiInputs() {
  const p = ai.PROVIDERS[state.ai.provider];
  $('#ai-provider').value = p.id;
  $('#ai-base-field').hidden = !p.customBaseUrl;
  $('#ai-base').value = state.ai.baseUrl;
  $('#ai-size-field').hidden = !p.sizeOption;
  $('#ai-size').value = state.ai.size;
  $('#ai-key-label').textContent = p.keyLabel;
  $('#ai-key-hint').innerHTML = p.keyUrl
    ? `${esc(p.keyHint)} <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Get a key ↗</a>`
    : `${esc(p.keyHint)} Your key is sent only to the base URL above.`;
  $('#ai-model').value = currentModel();
  $('#ai-model').placeholder = p.defaultModel ? `e.g. ${p.defaultModel}` : 'Type the model ID your endpoint expects';
  const dev = device();
  $('#ai-size').placeholder = `automatic (${ai.autoImageSize(currentModel() || '', dev.w, dev.h)})`;
}

function renderModelPicker() {
  const field = $('#ai-model-pick-field');
  const showAll = $('#ai-show-all').checked;
  const list = loadedModels.filter((m) => showAll || m.image);
  field.hidden = list.length === 0;
  $('#ai-model-pick').innerHTML = list
    .map((m) => `<option value="${esc(m.id)}" ${m.id === currentModel() ? 'selected' : ''}>${esc(m.displayName === m.id ? m.id : `${m.displayName} (${m.id})`)}</option>`)
    .join('');
}

/**
 * Decode a background image, shrinking very large photos (e.g. 48 MP camera
 * shots) to at most 4096 px on the long side and 16.7 MP. That is more than
 * any supported screen needs, and keeps memory within what phones allow.
 * Returns the decoded image and the blob to store.
 */
async function decodeBackground(blob) {
  const full = await createImageBitmap(blob);
  const k = Math.min(1, 4096 / Math.max(full.width, full.height), Math.sqrt(MAX_CANVAS_AREA / (full.width * full.height)));
  if (k >= 1) return { image: full, blob };
  const w = Math.max(1, Math.round(full.width * k));
  const h = Math.max(1, Math.round(full.height * k));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  full.close?.();
  const small = c.convertToBlob
    ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    : await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
  const image = await createImageBitmap(c);
  freeCanvas(c);
  if (!small) throw new Error('could not encode the resized image');
  return { image, blob: small };
}

function aiStatus(msg, kind) {
  const el = $('#ai-status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

async function generateWithAi() {
  if (!ai.hasApiKey()) return aiStatus('Enter an API key for the selected provider first.', 'bad');
  const cfg = aiConfig();
  const provider = ai.PROVIDERS[cfg.provider];
  const dev = device();
  const btn = $('#ai-generate');
  btn.disabled = true;
  aiStatus(`Generating with ${provider.name} · ${cfg.model || '(no model)'}… this can take a minute.`, '');
  try {
    if (cfg.size && !ai.isValidSize(cfg.size)) throw new ai.AiError('config', 'Image size must look like 1024x1536, or be blank.');
    const res = await ai.generateImage(cfg, { prompt: $('#scenery-prompt').value, width: dev.w, height: dev.h });
    const { image, blob } = await decodeBackground(res.blob);
    if (image.width < 256 || image.height < 256) throw new ai.AiError('no-image', 'The returned image was too small to use.');
    const label = `${provider.name.replace(/ \(custom URL\)$/, '')} · ${cfg.model}`;
    setCandidate({ image, blob, source: cfg.provider, label, model: cfg.model, provider: cfg.provider });
    aiStatus('Done. Review the preview and choose whether to use it.', 'ok');
  } catch (err) {
    aiStatus(err.message || 'Generation failed. Your current background is unchanged.', 'bad');
  } finally {
    btn.disabled = false;
  }
}

function setCandidate(c) {
  const dev = device();
  const guides = dev.guides.filter((g) => dev.h >= dev.w || g.label.includes('Clock'));
  c.assessment = ai.assessScenery(c.image, dev, guides, drawCover);
  if (candidate && candidate !== c) candidate.image.close?.();
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
  if (bgImage && bgImage !== c.image) bgImage.close?.();
  bgImage = c.image;
  state.design.background = { type: 'custom', assetId: 'bg-current', label: c.label, model: c.model, provider: c.provider || null };
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
  const dev = device();
  $('#dev-capped').hidden = !dev.capped;
  $('#dev-capped').textContent = dev.capped
    ? `Using ${dev.w}×${dev.h}px. Larger images can't be exported reliably in every browser (iPhone Safari stops at about 16.7 megapixels), so the size was scaled down with the same shape.`
    : '';
  $('#dev-w').value = d.customW;
  $('#dev-h').value = d.customH;
  $('#des-paper').value = d.paper;
  $('#des-font').value = d.font;
  $('#des-desk').value = d.desk;
  $('#des-lighting').value = d.lighting;
  for (const cb of $$('#des-accessories input')) cb.checked = Boolean(d.accessories[cb.dataset.acc]);
  for (const r of $$('input[name="bg-type"]')) r.checked = r.value === d.background.type;
  $('#bundled-controls').hidden = d.background.type !== 'bundled';
  syncAiInputs();
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
  // On touch devices with Web Share, the preview's main button shares (that's
  // how a picture gets into Photos on iPhone, incl. home-screen apps).
  $('#export-png-2').addEventListener('click', () => exportPng(preferShare));
  $('#share-png').addEventListener('click', () => exportPng(true));
  try {
    const probe = new File([new Blob(['x'])], 'x.png', { type: 'image/png' });
    shareSupported = Boolean(navigator.canShare && navigator.canShare({ files: [probe] }));
    preferShare = shareSupported && window.matchMedia('(pointer: coarse)').matches;
    if (preferShare) {
      $('#export-png-2').textContent = 'Save to Photos / Share';
      $('#share-png').classList.add('primary');
      $('#export-png').classList.remove('primary');
      $('#share-png').after($('#export-png'));
    }
    $('#share-png').hidden = !shareSupported;
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
    toast("Done. Lock-In will tell you when it's out of date.");
  });
}

let shareSupported = false;
let preferShare = false;
let pngCache = { version: null, blob: null };
let pngTimer = 0;

/** Encode the current preview in the background so Share is instant. */
function schedulePngPrepare(delay = 500) {
  if (!shareSupported) return;
  clearTimeout(pngTimer);
  pngTimer = setTimeout(() => {
    if (!lastRender || candidate || pngCache.version === lastRender.version) return;
    const version = lastRender.version;
    // toBlob copies the pixels when called, so the blob matches `version`.
    canvas.toBlob((blob) => {
      if (blob) pngCache = { version, blob };
    }, 'image/png');
  }, delay);
}

async function exportPng(share) {
  if (candidate) {
    toast('Use or discard the new background first (step 3).');
    showTab('design');
    return;
  }
  if (exporting) return;
  if (!state.deadline.date) {
    toast('Choose a due date first, so the countdown is right.');
    showTab('deadline');
    $('#dl-date').focus();
    return;
  }
  renderPreview();
  const { version, device: dev, asOfDate, content } = lastRender;
  const name = `lock-in-${slug(content.title) || 'deadline'}-${dev.w}x${dev.h}-as-of-${asOfDate}.png`;
  if (share) {
    // Must call share() synchronously in the tap: no await before it.
    if (pngCache.version !== version || !pngCache.blob) {
      schedulePngPrepare(0);
      toast('Preparing the image… tap Share again in a moment.');
      return;
    }
    try {
      await navigator.share({ files: [new File([pngCache.blob], name, { type: 'image/png' })], title: 'Lock-In wallpaper' });
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled: nothing was exported
      return toast('Sharing failed. Try Download PNG instead.');
    }
  } else {
    exporting = true;
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return toast('Export failed: the image could not be encoded.');
      download(blob, name);
    } finally {
      exporting = false;
    }
  }
  state = recordExport(state, { version, asOfDate, device: dev, background: backgroundId() });
  persist();
  renderInstall();
  renderWallpaperStatus();
  toast('Saved. Set it as your lock screen, then confirm in the Export tab.');
}

let exporting = false;

function statusSummary() {
  if (!lastRender) return { kind: 'none' };
  return wallpaperStatus(state, lastRender.version);
}

function renderWallpaperStatus() {
  const st = statusSummary();
  const pill = $('#wallpaper-pill');
  const map = {
    none: ['No wallpaper yet', 'pill'],
    exported: ['Saved, not confirmed on your lock screen', 'pill warn'],
    current: ['Lock screen is up to date', 'pill ok'],
    stale: ['Lock screen is out of date', 'pill bad'],
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
    el.textContent = 'Nothing saved yet. Save the image, set it as your lock screen, then confirm below.';
  } else if (st.kind === 'exported') {
    el.className = 'callout warn';
    el.textContent = `Saved ${fmtStamp(s.exportedAt)} for ${s.device.name}. Once it's your lock screen, confirm below.`;
  } else if (st.kind === 'current') {
    el.className = 'callout ok';
    el.textContent = `On your lock screen (you confirmed ${fmtStamp(s.appliedAt)}). It matches your plan and today's countdown.`;
  } else {
    const dateChanged = s.asOfDate !== lastRender.asOfDate;
    el.className = 'callout bad';
    el.textContent = `Your lock screen (confirmed ${fmtStamp(s.appliedAt)}) is out of date: ${
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
              sn.state === 'applied' ? `On lock screen ✓ (confirmed ${esc(fmtStamp(sn.appliedAt))})` : 'Saved'
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
    const items = reminderItems().filter((i) => !i.past);
    if (!items.length) return toast('No upcoming reminders. Add dated actions or a future deadline first.');
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
          if (it.past) {
            return `<li class="rem past"><div><strong>${esc(it.title)}</strong><div class="when">${esc(formatDateLong(it.date))} · already passed, so it's not in the calendar file</div></div></li>`;
          }
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
  const upcoming = items.filter((i) => !i.past);
  const done = upcoming.filter((i) => isVerified(i, v)).length;
  const sum = $('#rem-summary');
  sum.className = `callout ${upcoming.length && done === upcoming.length ? 'ok' : ''}`;
  sum.textContent = upcoming.length ? `${done} of ${upcoming.length} upcoming reminders verified in your calendar.` : '';
}

// ----------------------------------------------------------------- settings

let settingsReturnFocus = null;
function openSettings(section) {
  settingsReturnFocus = document.activeElement;
  $('#settings').hidden = false;
  $('#settings-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  $('#preview-jump').hidden = true;
  const target = section ? $(`#settings-${section}`) : null;
  if (target) target.scrollIntoView({ block: 'start' });
  else $('#settings .modal-body').scrollTop = 0;
  $('#close-settings').focus();
}
function closeSettings() {
  if ($('#settings').hidden) return;
  $('#settings').hidden = true;
  $('#settings-backdrop').hidden = true;
  document.body.classList.remove('modal-open');
  updatePreviewJump();
  settingsReturnFocus?.focus?.();
}

function initSettings() {
  $('#open-settings').addEventListener('click', () => openSettings());
  for (const b of $$('[data-settings]')) b.addEventListener('click', () => openSettings(b.dataset.settings));
  $('#close-settings').addEventListener('click', closeSettings);
  $('#settings-backdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if ($('#settings').hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSettings();
    } else if (e.key === 'Tab') {
      // Keep keyboard focus inside the dialog while it is open.
      const f = $$('#settings button, #settings a[href], #settings label.file-btn').filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
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
      if (file.size > 5 * 1024 * 1024) throw new Error('too large'); // real backups are a few KB
      const raw = JSON.parse(await file.text());
      if (!confirm('Replace your current Lock-In data with this backup?')) return;
      state = migrate(raw);
      bgImage = null;
      resetAiSession('');
      persist();
      syncAll();
      loadBackground();
      closeSettings();
      toast("Backup restored. Background images aren't part of backups, so re-upload yours if you used one.");
    } catch {
      toast('That file is not a valid Lock-In backup.');
    }
  });
  $('#data-sample').addEventListener('click', () => {
    if ((state.tasks.length || state.deadline.date) && !confirm('Replace your current deadline and actions with the example?')) return;
    loadSample();
    closeSettings();
  });
  $('#data-reset').addEventListener('click', async () => {
    if (!confirm("Erase your deadline, plan, reminders and backgrounds from this browser? This can't be undone. Download a backup first if you might want them back.")) return;
    storage.clear();
    await clearAssets();
    resetAiSession('');
    state = defaultState();
    bgImage = null;
    candidate = null;
    persist();
    syncAll();
    closeSettings();
    showWelcome();
    toast('Everything was erased.');
  });
}

// ------------------------------------------------------------------ welcome

function showWelcome() {
  $('#welcome').hidden = Boolean(state.welcomed || state.deadline.date || state.tasks.length);
}

function initWelcome() {
  $('#welcome-start').addEventListener('click', () => {
    state.welcomed = true;
    persist();
    $('#welcome').hidden = true;
    $('#dl-title').focus();
    updatePreviewJump();
  });
  $('#welcome-sample').addEventListener('click', () => {
    state.welcomed = true;
    loadSample();
    $('#welcome').hidden = true;
    updatePreviewJump();
  });
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
  toast('Example loaded. It is made up, so replace it with your own deadline when you are ready.');
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
  showWelcome();
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
  initSettings();
  initWelcome();

  for (const t of $$('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  $('.tabs').addEventListener('keydown', (e) => {
    const i = TAB_IDS.indexOf(document.activeElement?.dataset?.tab);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TAB_IDS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const id = TAB_IDS[(next + TAB_IDS.length) % TAB_IDS.length];
    showTab(id);
    $(`.tab[data-tab="${id}"]`).focus();
  });
  $('#toast-action').addEventListener('click', () => {
    const fn = toastActionFn;
    toastActionFn = null;
    $('#toast').hidden = true;
    fn?.();
  });
  initPreviewJump();
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    showTab(a.dataset.goto, a.dataset.task);
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
  setInterval(tick, 30_000);

  if (!storage.load()) {
    // First launch: start with the screen this page is opened on.
    try {
      Object.assign(state.design, detectDevice({ width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 }));
    } catch {
      /* keep the default preset */
    }
    if (!state.tasks.length && new URLSearchParams(location.search).has('sample')) loadSample();
  }
  try {
    syncAll();
  } catch (err) {
    showLoadError(err);
    return;
  }
  showTab(location.hash.slice(1) || 'deadline');
  loadBackground();
  persist();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function showLoadError(err) {
  console.error(err);
  const box = document.createElement('div');
  box.className = 'callout bad load-error';
  box.setAttribute('role', 'alert');
  box.innerHTML = `<strong>Lock-In couldn't open your saved data.</strong> Nothing has been deleted. Download a copy, then start fresh (you can import the copy later).
    <div class="buttons"><button class="btn" id="le-download">Download saved data</button><button class="btn danger" id="le-reset">Start fresh</button></div>`;
  document.querySelector('.layout').before(box);
  box.querySelector('#le-download').addEventListener('click', () => {
    let raw = '';
    try {
      raw = localStorage.getItem('lock-in:v1') || JSON.stringify(state);
    } catch {
      raw = JSON.stringify(state);
    }
    download(new Blob([raw], { type: 'application/json' }), 'lock-in-saved-data.json');
  });
  box.querySelector('#le-reset').addEventListener('click', () => {
    if (!confirm('Erase the saved data in this browser and start fresh?')) return;
    storage.clear();
    location.reload();
  });
}

// On phones the preview sits below the form: offer a button to jump to it
// while it's out of view.
let updatePreviewJump = () => {};
function initPreviewJump() {
  const btn = $('#preview-jump');
  if (!('IntersectionObserver' in window)) return;
  let visible = true;
  const narrow = window.matchMedia('(max-width: 860px)');
  const update = (updatePreviewJump = () => {
    // Hidden on wide screens, while the preview is visible, while Settings is
    // open, and on the welcome card (nothing to preview yet).
    btn.hidden = !narrow.matches || visible || !$('#settings').hidden || !$('#welcome').hidden;
  });
  new IntersectionObserver((entries) => {
    visible = entries.some((en) => en.isIntersecting);
    update();
  }).observe($('#frame'));
  narrow.addEventListener?.('change', update);
  btn.addEventListener('click', () => $('.preview').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// Expose a tiny hook for automated smoke tests / screenshots.
window.__lockIn = { get state() { return state; }, get lastRender() { return lastRender; }, loadSample, zonedWallTimeToInstant };

init();
