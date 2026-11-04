// Optional Bring-Your-Own-Key scenery generation (design doc §4.3), with a
// user-chosen provider/API and model.
//
// Providers:
//   - gemini:     Google Gemini API (Gemini image models via generateContent,
//                 Imagen models via predict)
//   - openai:     OpenAI Images API
//   - compatible: any OpenAI-compatible /images/generations endpoint at a
//                 base URL the user enters
//
// Rules that hold for every provider:
// - Called only when the user asks for a new visual style; never for task or
//   countdown edits (those are re-composited locally).
// - Sends the style prompt only. No task, deadline or calendar text is ever
//   included in a request.
// - The key lives in memory for the current tab only. It is never written to
//   storage, exports or URLs, and it is forgotten on reload. The app clears
//   it whenever the provider or base URL changes, so a key can't be sent to
//   a different service by accident.
// - Failures never discard the current background.

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini API',
    keyLabel: 'Gemini API key',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'Create a key in Google AI Studio.',
    defaultModel: 'gemini-2.5-flash-image',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    customBaseUrl: false,
    sizeOption: false,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI Images API',
    keyLabel: 'OpenAI API key',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Create a key in the OpenAI platform dashboard.',
    defaultModel: 'gpt-image-1',
    baseUrl: 'https://api.openai.com/v1',
    customBaseUrl: false,
    sizeOption: true,
  },
  compatible: {
    id: 'compatible',
    name: 'OpenAI-compatible endpoint (custom URL)',
    keyLabel: 'API key',
    keyUrl: '',
    keyHint: 'Any service that implements POST {base URL}/images/generations.',
    defaultModel: '',
    baseUrl: '',
    customBaseUrl: true,
    sizeOption: true,
  },
};

export const GEMINI_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export const IMAGEN_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];

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

export class AiError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new AiError('config', `Unknown provider "${id}".`);
  return p;
}

export function sanitizeModel(model) {
  const m = String(model || '').trim().replace(/^models\//, '');
  if (!m) throw new AiError('model', 'Choose or type a model ID first.');
  if (!/^[a-z0-9][a-z0-9._:/\-]*$/i.test(m) || m.includes('..') || m.length > 120) {
    throw new AiError('model', 'Model IDs can only contain letters, numbers and . _ : / -');
  }
  return m;
}

/**
 * Validate a user-entered base URL. HTTPS is required, except for
 * localhost so people can use a self-hosted server on their machine.
 */
export function normalizeBaseUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    throw new AiError('config', 'Enter a full base URL, e.g. https://example.com/v1');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new AiError('config', 'The base URL must use https:// (http:// is allowed only for localhost).');
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new AiError('config', 'The base URL must not contain credentials, a query or a fragment.');
  }
  return u.toString().replace(/\/+$/, '');
}

function baseUrlFor(cfg) {
  const p = getProvider(cfg.provider);
  return p.customBaseUrl ? normalizeBaseUrl(cfg.baseUrl) : p.baseUrl;
}

export function isImagenModel(model) {
  return /^imagen/i.test(model);
}

/** Heuristic: does this model ID look like an image-generation model? */
export function looksLikeImageModel(id) {
  return /image|imagen|dall-e|flux|stable-diffusion|sdxl|sd3|diffusion|recraft|ideogram|playground/i.test(id);
}

export function nearestAspectRatio(w, h, options) {
  const target = Math.log(w / h);
  let best = options[0];
  let bestDiff = Infinity;
  for (const opt of options) {
    const [a, b] = opt.split(':').map(Number);
    const diff = Math.abs(Math.log(a / b) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return best;
}

/** Default OpenAI-style size for a model and target orientation. */
export function autoImageSize(model, w, h) {
  const portrait = h > w * 1.1;
  const landscape = w > h * 1.1;
  if (/^dall-e-3/i.test(model)) return portrait ? '1024x1792' : landscape ? '1792x1024' : '1024x1024';
  if (/^dall-e-2/i.test(model)) return '1024x1024';
  return portrait ? '1024x1536' : landscape ? '1536x1024' : '1024x1024';
}

export function isValidSize(s) {
  return /^\d{2,5}x\d{2,5}$/.test(String(s || '').trim());
}

function authHeaders(provider) {
  return provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}

async function call(cfg, path, { method = 'GET', body, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new AiError('no-key', 'Enter an API key first.');
  const url = `${baseUrlFor(cfg)}/${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { ...authHeaders(cfg.provider), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new AiError('timeout', 'The image service did not respond in time. Your current background is unchanged.');
    throw new AiError(
      'network',
      cfg.provider === 'compatible'
        ? 'Could not reach that endpoint. It may be offline, or it may not allow requests from a browser (CORS). Your current background is unchanged.'
        : 'Could not reach the API (offline or blocked). Your current background is unchanged.',
    );
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw mapError(cfg.provider, res.status, json);
  return json;
}

export function mapError(provider, status, json) {
  const e = json?.error || {};
  const msg = typeof e === 'string' ? e : e.message || '';
  const reason = (e.details || []).map((d) => d.reason).find(Boolean) || e.status || e.code || '';
  if (reason === 'API_KEY_INVALID' || reason === 'invalid_api_key' || status === 401 || /api key not valid|incorrect api key/i.test(msg)) {
    return new AiError('invalid-key', 'That API key was rejected. Check that it belongs to the selected provider.', msg);
  }
  if (status === 403) return new AiError('forbidden', 'This key does not have access to that model or API.', msg);
  if (status === 404) return new AiError('model', 'Model not found for this key. Load the available models or check the ID.', msg);
  if (status === 429) return new AiError('quota', 'Quota or rate limit reached for this key. Try again later or check your plan.', msg);
  if (status >= 500) return new AiError('server', 'The image service returned a server error. Try again shortly.', msg);
  const extra = msg ? `: ${msg.slice(0, 200)}` : '';
  return new AiError('request', `The request was rejected (${status})${extra}`, msg);
}

/**
 * List models the key can use.
 * @returns {Promise<{id: string, displayName: string, image: boolean}[]>}
 */
export async function listModels(cfg, opts = {}) {
  getProvider(cfg.provider);
  const out = [];
  if (cfg.provider === 'gemini') {
    let token = '';
    for (let page = 0; page < 10; page += 1) {
      const json = await call(cfg, `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, opts);
      for (const m of json?.models || []) {
        const id = String(m.name || '').replace(/^models\//, '');
        const methods = m.supportedGenerationMethods || [];
        if (!id || !(methods.includes('generateContent') || methods.includes('predict'))) continue;
        out.push({ id, displayName: m.displayName || id, image: looksLikeImageModel(id) });
      }
      token = json?.nextPageToken;
      if (!token) break;
    }
  } else {
    const json = await call(cfg, 'models', opts);
    for (const m of json?.data || []) {
      if (!m?.id) continue;
      out.push({ id: m.id, displayName: m.id, image: looksLikeImageModel(m.id) });
    }
  }
  return out.sort((a, b) => Number(b.image) - Number(a.image) || a.id.localeCompare(b.id));
}

/** Check the key can see the chosen model. */
export async function verifyModel(cfg, opts = {}) {
  const id = sanitizeModel(cfg.model);
  if (cfg.provider === 'gemini') {
    const json = await call(cfg, `models/${encodeURIComponent(id)}`, opts);
    const methods = json?.supportedGenerationMethods || [];
    const needed = isImagenModel(id) ? 'predict' : 'generateContent';
    if (methods.length && !methods.includes(needed)) throw new AiError('model', `${id} does not support ${needed}.`);
    return { id, displayName: json?.displayName || id };
  }
  const json = await call(cfg, `models/${id.split('/').map(encodeURIComponent).join('/')}`, opts);
  return { id, displayName: json?.id || id };
}

function b64ToBlob(b64, mimeType) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

/**
 * Build the request for a scenery image (exported for tests).
 * @returns {{path: string, body: object}}
 */
export function buildImageRequest(cfg, { prompt, width, height }) {
  const model = sanitizeModel(cfg.model);
  if (cfg.provider === 'gemini') {
    if (isImagenModel(model)) {
      return {
        path: `models/${encodeURIComponent(model)}:predict`,
        body: { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: nearestAspectRatio(width, height, IMAGEN_ASPECT_RATIOS) } },
      };
    }
    return {
      path: `models/${encodeURIComponent(model)}:generateContent`,
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: nearestAspectRatio(width, height, GEMINI_ASPECT_RATIOS) } },
      },
    };
  }
  const size = isValidSize(cfg.size) ? cfg.size.trim() : autoImageSize(model, width, height);
  const body = { model, prompt, n: 1, size };
  // DALL·E models return a URL by default; ask for base64 so no second
  // cross-origin download is needed. GPT image models always return base64
  // and reject this parameter, so it is only sent for DALL·E.
  if (/^dall-e/i.test(model)) body.response_format = 'b64_json';
  return { path: 'images/generations', body };
}

/**
 * Generate a scenery image with the chosen provider and model.
 * @returns {Promise<{blob: Blob, mimeType: string}>}
 */
export async function generateImage(cfg, { prompt, width, height }, opts = {}) {
  const { path, body } = buildImageRequest(cfg, { prompt, width, height });
  const json = await call(cfg, path, { method: 'POST', body, timeoutMs: 150_000, ...opts });

  if (cfg.provider === 'gemini' && isImagenModel(cfg.model)) {
    const pred = json?.predictions?.[0];
    if (!pred?.bytesBase64Encoded) throw new AiError('no-image', `No image returned (${pred?.raiFilteredReason || 'empty response'}). Try different style options.`);
    const mimeType = pred.mimeType || 'image/png';
    return { blob: b64ToBlob(pred.bytesBase64Encoded, mimeType), mimeType };
  }
  if (cfg.provider === 'gemini') {
    const cand = json?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
    if (!img) {
      const why = cand?.finishReason || json?.promptFeedback?.blockReason || 'no image in response';
      throw new AiError('no-image', `No image returned (${why}). Try different style options or another model.`);
    }
    const data = img.inlineData || img.inline_data;
    const mimeType = data.mimeType || data.mime_type || 'image/png';
    return { blob: b64ToBlob(data.data, mimeType), mimeType };
  }

  const item = json?.data?.[0];
  if (item?.b64_json) {
    const fmt = json.output_format || 'png';
    const mimeType = `image/${fmt === 'jpg' ? 'jpeg' : fmt}`;
    return { blob: b64ToBlob(item.b64_json, mimeType), mimeType };
  }
  if (item?.url) {
    const fetchImpl = opts.fetchImpl || fetch;
    try {
      const res = await fetchImpl(item.url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      return { blob, mimeType: blob.type || 'image/png' };
    } catch {
      throw new AiError('no-image', 'The service returned an image link that the browser could not download (CORS). Try a model that returns base64 images.');
    }
  }
  throw new AiError('no-image', 'No image returned. Try different style options or another model.');
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
