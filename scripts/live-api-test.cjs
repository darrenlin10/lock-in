// Live test of the BYOK image providers through the real app UI, in a real
// browser (so CORS is tested too), against the providers' real APIs.
//
//   npm run test:live                         tier 1: no key needed, free
//   GEMINI_API_KEY=... npm run test:live      tier 2: + model list / verify, free
//   OPENAI_API_KEY=... npm run test:live      (same for OpenAI)
//   ... npm run test:live -- --generate       tier 3: + one real image per
//                                             provider (billed to your key,
//                                             typically a few cents)
//
// Keys are read from the environment and typed into the app's password field.
// They are never printed or written to disk. Uses HTTPS_PROXY if set.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const GENERATE = process.argv.includes('--generate');
const PROVIDERS = [
  { id: 'gemini', host: 'generativelanguage.googleapis.com', env: 'GEMINI_API_KEY', models: ['gemini-2.5-flash-image', 'imagen-4.0-generate-001'] },
  { id: 'openai', host: 'api.openai.com', env: 'OPENAI_API_KEY', models: ['gpt-image-1'] },
];

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (p.endsWith('/')) p = path.join(p, 'index.html');
      fs.readFile(p, (err, body) => {
        if (err) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  let failed = 0;
  const line = (status, msg) => {
    if (status === 'FAIL') failed += 1;
    console.log(`  [${status}] ${msg}`);
  };

  for (const p of PROVIDERS) {
    console.log(`\n${p.id} (${p.host})`);
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // Is the host reachable from this browser at all?
    await page.goto(`${base}?sample#design`);
    await page.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender);
    const reach = await page.evaluate(async (host) => {
      try {
        // no-cors: only checks the network path; real API calls below check CORS.
        const r = await fetch(`https://${host}/`, { method: 'GET', mode: 'no-cors' });
        return { ok: true, status: r.status };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, p.host);
    if (!reach.ok) {
      line('SKIP', `${p.host} is not reachable from this machine (network policy, offline, or a browser block). Nothing tested.`);
      await ctx.close();
      continue;
    }

    await page.click('#scenery-card > summary');
    await page.click('.byok > summary');
    await page.selectOption('#ai-provider', p.id);
    const status = () => page.textContent('#ai-status');
    const waitStatus = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#ai-status').textContent), re.source, { timeout: 150_000 });

    // Tier 1: invalid key. Proves URL, auth header, CORS and error mapping.
    await page.fill('#ai-key', 'lock-in-live-test-invalid-key');
    for (const model of p.models) {
      await page.fill('#ai-model', model);
      for (const btn of ['#ai-load-models', '#ai-verify', '#ai-generate']) {
        await page.click(btn);
        await waitStatus(/rejected|not reach|CORS|rejected|error|Quota|not found|access/i).catch(() => {});
        const s = await status();
        line(/rejected/i.test(s) ? 'PASS' : 'FAIL', `invalid key · ${model} · ${btn.replace('#ai-', '')}: "${s}"`);
      }
    }

    // Tier 2 and 3: real key from the environment.
    const key = process.env[p.env];
    if (!key) {
      line('SKIP', `${p.env} not set: model listing and generation not tested.`);
    } else {
      await page.fill('#ai-key', key);
      await page.click('#ai-load-models');
      await waitStatus(/found|rejected|error|reach|Quota/i);
      const s = await status();
      const models = await page.$$eval('#ai-model-pick option', (o) => o.map((x) => x.value));
      line(/found/.test(s) ? 'PASS' : 'FAIL', `list models: "${s}"`);
      if (models.length) console.log(`         image models available to this key: ${models.join(', ')}`);
      const def = p.models[0];
      line(models.includes(def) ? 'PASS' : 'WARN', `default model ${def} ${models.includes(def) ? 'is' : 'is NOT'} in the key's model list`);
      for (const model of p.models) {
        await page.fill('#ai-model', model);
        await page.click('#ai-verify');
        await waitStatus(/Connected|rejected|not found|access|error|Quota/i);
        const v = await status();
        line(/Connected/.test(v) ? 'PASS' : 'WARN', `verify ${model}: "${v}"`);
      }
      if (GENERATE) {
        const model = models.includes(def) ? def : models[0];
        if (!model) {
          line('FAIL', 'no image model available to generate with');
        } else {
          await page.fill('#ai-model', model);
          await page.click('#ai-generate');
          await waitStatus(/Done|rejected|error|Quota|No image|too small|reach/i);
          const g = await status();
          const shown = await page.isVisible('#candidate-bar');
          line(/Done/.test(g) && shown ? 'PASS' : 'FAIL', `generate with ${model}: "${g}"`);
          if (shown) {
            const msg = await page.textContent('#candidate-msg');
            console.log(`         ${msg}`);
            await page.click('#candidate-accept');
            await page.click('.tab[data-tab=install]');
            const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-png')]);
            const file = path.join(root, `live-test-${p.id}.png`);
            await dl.saveAs(file);
            line('PASS', `exported a wallpaper with the generated background → ${path.basename(file)} (not committed; delete when done)`);
          }
        }
      } else {
        line('SKIP', 'generation not run (add --generate; billed to your key)');
      }
    }
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    line(stored.includes('lock-in-live-test') || (key && stored.includes(key)) ? 'FAIL' : 'PASS', 'no API key was saved to browser storage');
    line(pageErrors.length ? 'FAIL' : 'PASS', `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(failed ? `\n${failed} live check(s) failed.` : '\nLive checks finished with no failures (see SKIP lines for what was not covered).');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
