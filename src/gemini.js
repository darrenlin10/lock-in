// Optional Bring-Your-Own-Key Gemini scenery generation (design doc §4.3).
//
// - Called only when the user asks for a new visual style; never for task or
//   countdown edits (those are re-composited locally).
// - Sends aesthetic instructions only. No task, deadline or calendar text is
//   ever included in the request.
// - The key lives in memory for the current tab only. It is never written to
//   localStorage, exports, logs or the repository. Reloading forgets it.
// - Failures never discard the current background.

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

let apiKey = '';
export function setApiKey(k) {
  apiKey = String(k || '').trim();
}
export function hasApiKey() {
  return apiKey.length > 0;
}
export function forgetApiKey() {
  apiKey = '';
}

export class GeminiError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

function sanitizeModel(model) {
  const m = String(model || DEFAULT_IMAGE_MODEL).trim().replace(/^models\//, '');
  if (!/^[a-z0-9.\-]+$/i.test(m)) throw new GeminiError('model', 'Model ID can only contain letters, numbers, dots and dashes.');
  return m;
}

async function call(path, { method = 'GET', body, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new GeminiError('no-key', 'Enter a Gemini API key first.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${API_ROOT}/${path}`, {
      method,
      headers: { 'x-goog-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new GeminiError('timeout', 'Gemini did not respond in time. Your current background is unchanged.');
    throw new GeminiError('network', 'Could not reach the Gemini API (offline or blocked). Your current background is unchanged.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw mapError(res.status, json);
  return json;
}

export function mapError(status, json) {
  const e = json?.error || {};
  const reason = (e.details || []).map((d) => d.reason).find(Boolean) || e.status || '';
  const msg = e.message || '';
  if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(msg)) return new GeminiError('invalid-key', 'That API key was rejected. Check it in Google AI Studio.', msg);
  if (status === 403) return new GeminiError('forbidden', 'This key does not have access to that model or API.', msg);
  if (status === 404) return new GeminiError('model', 'Model not found for this key. Check the model ID.', msg);
  if (status === 429) return new GeminiError('quota', 'Quota or rate limit reached for this key. Try again later or check your plan.', msg);
  if (status >= 500) return new GeminiError('server', 'Gemini returned a server error. Try again shortly.', msg);
  return new GeminiError('request', `Gemini rejected the request (${status}).`, msg);
}

/** Validate that the key can see the model and that it supports generateContent. */
export async function verifyModel(model, opts = {}) {
  const id = sanitizeModel(model);
  const json = await call(`models/${encodeURIComponent(id)}`, opts);
  const methods = json?.supportedGenerationMethods || [];
  if (methods.length && !methods.includes('generateContent')) {
    throw new GeminiError('model', `${id} does not support generateContent.`);
  }
  return { id, displayName: json?.displayName || id, description: json?.description || '' };
}

/**
 * Generate a scenery image. Returns { blob, mimeType, text }.
 * Throws GeminiError on any failure.
 */
export async function generateScenery({ model, prompt, aspectRatio }, opts = {}) {
  const id = sanitizeModel(model);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio },
    },
  };
  const json = await call(`models/${encodeURIComponent(id)}:generateContent`, { method: 'POST', body, timeoutMs: 120_000, ...opts });
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!img) {
    const why = cand?.finishReason || json?.promptFeedback?.blockReason || 'no image in response';
    throw new GeminiError('no-image', `Gemini returned no image (${why}). Try different style options.`);
  }
  const data = img.inlineData || img.inline_data;
  const mimeType = data.mimeType || data.mime_type || 'image/png';
  const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
  const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
  return { blob: new Blob([bytes], { type: mimeType }), mimeType, text };
}

/**
 * Heuristic acceptance check (§6.2: "inspect/crop the result").
 * Measures how busy the clock/shortcut clearance bands are after cropping.
 * Returns { ok, busyRegions: [labels] }. Advisory only; the user decides.
 */
export function assessScenery(image, size, guides, drawCover) {
  const scale = 120 / Math.max(size.w, size.h);
  const w = Math.max(8, Math.round(size.w * scale));
  const h = Math.max(8, Math.round(size.h * scale));
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  drawCover(ctx, image, w, h);
  const busyRegions = [];
  for (const g of guides) {
    const x0 = Math.floor(g.x * w);
    const y0 = Math.floor(g.y * h);
    const gw = Math.max(2, Math.floor(g.w * w));
    const gh = Math.max(2, Math.floor(g.h * h));
    const d = ctx.getImageData(x0, y0, gw, gh).data;
    let sum = 0;
    let sumSq = 0;
    let edges = 0;
    const lum = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i += 1) {
      const l = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      lum[i] = l;
      sum += l;
      sumSq += l * l;
    }
    for (let y = 0; y < gh; y += 1) {
      for (let x = 1; x < gw; x += 1) if (Math.abs(lum[y * gw + x] - lum[y * gw + x - 1]) > 40) edges += 1;
    }
    const n = gw * gh;
    const std = Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2));
    if (std > 42 || edges / n > 0.08) busyRegions.push(g.label);
  }
  return { ok: busyRegions.length === 0, busyRegions };
}
