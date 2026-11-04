import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gemini from '../src/gemini.js';

const png = Buffer.from('fakepng').toString('base64');
function mockFetch(status, json, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return { ok: status < 400, status, json: async () => json };
  };
}

test('requires a key and never puts it in the URL or body', async () => {
  gemini.forgetApiKey();
  await assert.rejects(gemini.verifyModel('gemini-2.5-flash-image'), { kind: 'no-key' });
  gemini.setApiKey('k-123');
  const cap = {};
  const res = await gemini.generateScenery(
    { model: 'gemini-2.5-flash-image', prompt: 'desk only', aspectRatio: '9:16' },
    { fetchImpl: mockFetch(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }, cap) },
  );
  assert.equal(res.mimeType, 'image/png');
  assert.ok(!cap.url.includes('k-123'));
  assert.ok(!cap.init.body.includes('k-123'));
  assert.equal(cap.init.headers['x-goog-api-key'], 'k-123');
  const body = JSON.parse(cap.init.body);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '9:16');
  assert.equal(body.contents[0].parts[0].text, 'desk only');
  gemini.forgetApiKey();
  assert.equal(gemini.hasApiKey(), false);
});

test('maps API failures to clear, non-destructive errors', async () => {
  gemini.setApiKey('k');
  const cases = [
    [400, { error: { message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } }, 'invalid-key'],
    [403, { error: {} }, 'forbidden'],
    [404, { error: {} }, 'model'],
    [429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'quota'],
    [503, {}, 'server'],
  ];
  for (const [status, json, kind] of cases) {
    await assert.rejects(gemini.verifyModel('m', { fetchImpl: mockFetch(status, json) }), { kind });
  }
  await assert.rejects(
    gemini.verifyModel('m', { fetchImpl: async () => { throw new TypeError('offline'); } }),
    { kind: 'network' },
  );
  await assert.rejects(
    gemini.generateScenery({ model: 'm', prompt: 'p', aspectRatio: '1:1' }, { fetchImpl: mockFetch(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }) }),
    { kind: 'no-image' },
  );
  await assert.rejects(gemini.verifyModel('../evil', { fetchImpl: mockFetch(200, {}) }), { kind: 'model' });
  gemini.forgetApiKey();
});
