import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ai from '../src/ai.js';

const b64 = Buffer.from('fakepng').toString('base64');

function mockFetch(responses, log = []) {
  const queue = Array.isArray(responses) ? [...responses] : null;
  return async (url, init = {}) => {
    log.push({ url, init });
    const [status, json] = queue ? queue.shift() : responses(url, init);
    return { ok: status < 400, status, json: async () => json, blob: async () => new Blob(['img'], { type: 'image/png' }) };
  };
}

test('every provider is selectable and describes itself', () => {
  assert.deepEqual(Object.keys(ai.PROVIDERS), ['gemini', 'openai', 'compatible']);
  for (const p of Object.values(ai.PROVIDERS)) {
    assert.ok(p.name && p.keyLabel && p.keyHint);
  }
  assert.throws(() => ai.getProvider('nope'), { kind: 'config' });
});

test('model IDs are user-chosen but sanitised', () => {
  assert.equal(ai.sanitizeModel(' models/gemini-2.5-flash-image '), 'gemini-2.5-flash-image');
  assert.equal(ai.sanitizeModel('black-forest-labs/FLUX.1-schnell'), 'black-forest-labs/FLUX.1-schnell');
  assert.throws(() => ai.sanitizeModel(''), { kind: 'model' });
  assert.throws(() => ai.sanitizeModel('../../v1/keys'), { kind: 'model' });
  assert.throws(() => ai.sanitizeModel('a b'), { kind: 'model' });
});

test('custom base URLs must be https (or localhost) with no credentials', () => {
  assert.equal(ai.normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(ai.normalizeBaseUrl('http://localhost:8000/v1'), 'http://localhost:8000/v1');
  assert.throws(() => ai.normalizeBaseUrl('http://api.example.com/v1'), { kind: 'config' });
  assert.throws(() => ai.normalizeBaseUrl('https://user:pw@example.com'), { kind: 'config' });
  assert.throws(() => ai.normalizeBaseUrl('https://example.com/v1?x=1'), { kind: 'config' });
  assert.throws(() => ai.normalizeBaseUrl('not a url'), { kind: 'config' });
});

test('request shapes: Gemini, Imagen, OpenAI GPT image, DALL·E, compatible', () => {
  const dims = { prompt: 'desk only', width: 1179, height: 2556 };
  const g = ai.buildImageRequest({ provider: 'gemini', model: 'gemini-2.5-flash-image' }, dims);
  assert.equal(g.path, 'models/gemini-2.5-flash-image:generateContent');
  assert.equal(g.body.generationConfig.imageConfig.aspectRatio, '9:16');
  assert.equal(g.body.contents[0].parts[0].text, 'desk only');

  const im = ai.buildImageRequest({ provider: 'gemini', model: 'imagen-4.0-generate-001' }, { ...dims, width: 1920, height: 1080 });
  assert.equal(im.path, 'models/imagen-4.0-generate-001:predict');
  assert.equal(im.body.parameters.aspectRatio, '16:9');

  const o = ai.buildImageRequest({ provider: 'openai', model: 'gpt-image-1' }, dims);
  assert.equal(o.path, 'images/generations');
  assert.deepEqual(o.body, { model: 'gpt-image-1', prompt: 'desk only', n: 1, size: '1024x1536' });

  const d = ai.buildImageRequest({ provider: 'openai', model: 'dall-e-3' }, dims);
  assert.equal(d.body.size, '1024x1792');
  assert.equal(d.body.response_format, 'b64_json');

  const c = ai.buildImageRequest({ provider: 'compatible', model: 'my-model', size: '768x1344' }, dims);
  assert.equal(c.body.size, '768x1344'); // user override wins
  const bad = ai.buildImageRequest({ provider: 'compatible', model: 'm', size: 'huge' }, dims);
  assert.equal(bad.body.size, '1024x1536'); // invalid override falls back to automatic
});

test('keys go only in the auth header of the chosen provider', async () => {
  ai.forgetApiKey();
  await assert.rejects(ai.verifyModel({ provider: 'gemini', model: 'x' }), { kind: 'no-key' });
  ai.setApiKey('k-123');

  const log = [];
  await ai.generateImage(
    { provider: 'gemini', model: 'gemini-2.5-flash-image' },
    { prompt: 'p', width: 1080, height: 1920 },
    { fetchImpl: mockFetch([[200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }] }]], log) },
  );
  assert.ok(log[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/'));
  assert.equal(log[0].init.headers['x-goog-api-key'], 'k-123');
  assert.equal(log[0].init.headers.Authorization, undefined);

  const out = await ai.generateImage(
    { provider: 'openai', model: 'gpt-image-1' },
    { prompt: 'p', width: 1080, height: 1920 },
    { fetchImpl: mockFetch([[200, { data: [{ b64_json: b64 }], output_format: 'webp' }]], log) },
  );
  assert.equal(out.mimeType, 'image/webp');
  assert.equal(log[1].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(log[1].init.headers.Authorization, 'Bearer k-123');
  assert.equal(log[1].init.headers['x-goog-api-key'], undefined);

  await ai.generateImage(
    { provider: 'compatible', baseUrl: 'https://img.example.com/v1/', model: 'flux' },
    { prompt: 'p', width: 1080, height: 1920 },
    { fetchImpl: mockFetch([[200, { data: [{ b64_json: b64 }] }]], log) },
  );
  assert.equal(log[2].url, 'https://img.example.com/v1/images/generations');
  for (const { url, init } of log) {
    assert.ok(!url.includes('k-123'));
    assert.ok(!String(init.body).includes('k-123'));
  }
  ai.forgetApiKey();
  assert.equal(ai.hasApiKey(), false);
});

test('Imagen and URL-style responses are decoded', async () => {
  ai.setApiKey('k');
  const im = await ai.generateImage(
    { provider: 'gemini', model: 'imagen-4.0-generate-001' },
    { prompt: 'p', width: 1, height: 1 },
    { fetchImpl: mockFetch([[200, { predictions: [{ bytesBase64Encoded: b64, mimeType: 'image/png' }] }]]) },
  );
  assert.equal(im.mimeType, 'image/png');
  const url = await ai.generateImage(
    { provider: 'compatible', baseUrl: 'https://x.example', model: 'm' },
    { prompt: 'p', width: 1, height: 1 },
    { fetchImpl: mockFetch([[200, { data: [{ url: 'https://cdn.example/img.png' }] }], [200, {}]]) },
  );
  assert.equal(url.mimeType, 'image/png');
  await assert.rejects(
    ai.generateImage({ provider: 'gemini', model: 'imagen-4.0-generate-001' }, { prompt: 'p', width: 1, height: 1 }, { fetchImpl: mockFetch([[200, { predictions: [] }]]) }),
    { kind: 'no-image' },
  );
  ai.forgetApiKey();
});

test('model lists come from the provider; image models sorted first', async () => {
  ai.setApiKey('k');
  const log = [];
  const gem = await ai.listModels(
    { provider: 'gemini' },
    {
      fetchImpl: mockFetch(
        [
          [200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'n2' }],
          [200, { models: [{ name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] }] }],
        ],
        log,
      ),
    },
  );
  assert.deepEqual(gem.map((m) => [m.id, m.image]), [['imagen-4.0-generate-001', true], ['gemini-2.5-flash', false]]);
  assert.ok(log[1].url.includes('pageToken=n2'));

  const oa = await ai.listModels({ provider: 'openai' }, { fetchImpl: mockFetch([[200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }] }]]) });
  assert.deepEqual(oa.filter((m) => m.image).map((m) => m.id), ['dall-e-3', 'gpt-image-1']);
  ai.forgetApiKey();
});

test('failures map to clear, non-destructive errors', async () => {
  ai.setApiKey('k');
  const cases = [
    ['gemini', 400, { error: { message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } }, 'invalid-key'],
    ['openai', 401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, 'invalid-key'],
    ['gemini', 403, { error: {} }, 'forbidden'],
    ['openai', 404, { error: {} }, 'model'],
    ['openai', 429, { error: { message: 'rate limit' } }, 'quota'],
    ['gemini', 503, {}, 'server'],
    ['openai', 400, { error: { message: 'Invalid size' } }, 'request'],
  ];
  for (const [provider, status, json, kind] of cases) {
    await assert.rejects(ai.verifyModel({ provider, model: 'm' }, { fetchImpl: mockFetch([[status, json]]) }), { kind });
  }
  await assert.rejects(
    ai.verifyModel({ provider: 'compatible', baseUrl: 'https://x.example', model: 'm' }, { fetchImpl: async () => { throw new TypeError('cors'); } }),
    (err) => err.kind === 'network' && /CORS/.test(err.message),
  );
  await assert.rejects(ai.verifyModel({ provider: 'compatible', baseUrl: 'http://evil.example', model: 'm' }), { kind: 'config' });
  ai.forgetApiKey();
});
