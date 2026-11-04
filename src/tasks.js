// Local task model and display selection (design doc §3.2, §4.1).
//
// Visible-action order (documented in README):
//   1. Pinned open tasks, in the user's manual order. Pinned items are never
//      silently replaced; if more are pinned than fit, the caller gets a warning.
//   2. Remaining open tasks by due date (earliest first, undated last),
//      then priority (high → low), then manual order.
// Completed tasks never appear on a newly generated snapshot.
//
// Pure module.

import { isValidDateString } from './dates.js';

export const PRIORITIES = { 1: 'High', 2: 'Medium', 3: 'Low' };

let counter = 0;
export function newId(prefix = 't') {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function createTask(fields = {}, now = new Date()) {
  const ts = now.toISOString();
  return normalizeTask({
    id: fields.id || newId(),
    title: fields.title ?? '',
    label: fields.label ?? '',
    done: false,
    priority: fields.priority ?? 2,
    due: fields.due ?? null,
    pinned: Boolean(fields.pinned),
    order: fields.order ?? Date.now(),
    createdAt: ts,
    updatedAt: ts,
  });
}

export function normalizeTask(t) {
  const priority = [1, 2, 3].includes(Number(t?.priority)) ? Number(t.priority) : 2;
  return {
    id: String(t?.id || newId()),
    title: String(t?.title ?? '').trim(),
    label: String(t?.label ?? '').trim(),
    done: Boolean(t?.done),
    priority,
    due: isValidDateString(t?.due) ? t.due : null,
    pinned: Boolean(t?.pinned),
    order: Number.isFinite(Number(t?.order)) ? Number(t.order) : 0,
    createdAt: t?.createdAt || new Date(0).toISOString(),
    updatedAt: t?.updatedAt || t?.createdAt || new Date(0).toISOString(),
  };
}

export function updateTask(task, patch, now = new Date()) {
  return normalizeTask({ ...task, ...patch, id: task.id, createdAt: task.createdAt, updatedAt: now.toISOString() });
}

/** The text drawn on the wallpaper: the short label if set, otherwise the full title. */
export function displayLabel(task) {
  return task.label || task.title;
}

function compareAuto(a, b) {
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.order - b.order;
}

/** Open tasks in display order (pinned first, then automatic order). */
export function orderedOpenTasks(tasks) {
  const open = tasks.filter((t) => !t.done && t.title);
  const pinned = open.filter((t) => t.pinned).sort((a, b) => a.order - b.order);
  const rest = open.filter((t) => !t.pinned).sort(compareAuto);
  return [...pinned, ...rest];
}

/**
 * Choose which open tasks appear on the lock screen.
 * Returns { visible, hidden, pinnedOverflow } where `hidden` counts open tasks
 * that do not fit within `max`.
 */
export function selectVisibleTasks(tasks, max = 3) {
  const ordered = orderedOpenTasks(tasks);
  const limit = Math.max(0, Math.floor(max));
  const pinnedCount = ordered.filter((t) => t.pinned).length;
  return {
    visible: ordered.slice(0, limit),
    hidden: Math.max(0, ordered.length - limit),
    pinnedOverflow: pinnedCount > limit,
  };
}

/** Plan progress counts. */
export function progress(tasks) {
  const real = tasks.filter((t) => t.title);
  const done = real.filter((t) => t.done).length;
  return { done, total: real.length };
}
