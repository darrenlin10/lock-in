// Browser smoke test + documentation images (uses the pre-installed Playwright).
//   npm run screenshots
// - Loads the app with sample data at a fixed date/timezone.
// - Fails on any console error or uncaught exception.
// - Exercises add/complete task, design changes, export and reminders.
// - Writes app screenshots, sample wallpapers and PNG icons.
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'images');
fs.mkdirSync(out, { recursive: true });
const FIXED_NOW = new Date('2026-11-04T10:00:00-08:00');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (p.endsWith('/')) p = path.join(p, 'index.html');
      fs.readFile(p, (err, body) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

async function hideToast(page) {
  await page.evaluate(() => (document.querySelector('#toast').hidden = true));
}

// Docs copies are downscaled JPEGs to keep the repo small; real exports are full-size PNGs.
async function canvasPng(page, file) {
  const data = await page.evaluate(() => {
    const src = document.querySelector('#canvas');
    const scale = Math.min(1, 1280 / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  });
  fs.writeFileSync(path.join(out, file), Buffer.from(data.split(',')[1], 'base64'));
}

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  const check = (cond, msg) => { if (!cond) { errors.push(`ASSERT: ${msg}`); } };

  // ---- Desktop run
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, timezoneId: 'America/Los_Angeles', locale: 'en-US', acceptDownloads: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(FIXED_NOW);
  // The mocked 429 below is an expected network error, not an app error.
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('429') && errors.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${base}?sample#plan`);
  await page.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender);

  const st = await page.evaluate(() => ({ dl: window.__lockIn.state.deadline, n: window.__lockIn.state.tasks.length, shown: window.__lockIn.lastRender.layout.shownItems, big: window.__lockIn.lastRender.content.big }));
  check(st.n === 6, 'sample has 6 tasks');
  check(st.shown === 3, 'three actions shown');
  check(st.big === '30', `countdown is 30 (got ${st.big})`);

  // Add then complete a task; completed task must leave the snapshot.
  await page.fill('#task-new-title', 'Email advisor about demo slot');
  await page.fill('#task-new-due', '2026-11-05');
  await page.click('#task-add button[type=submit]');
  // The preview re-renders on the next animation frame; wait for it.
  await page.waitForFunction(() => window.__lockIn.lastRender.content.items[0]?.label === 'Email advisor about demo slot', null, { timeout: 3000 }).catch(() => {});
  let labels = await page.evaluate(() => window.__lockIn.lastRender.content.items.map((i) => i.label));
  check(labels[0] === 'Email advisor about demo slot', `new earliest task shown first (${labels})`);
  await page.locator('.task', { hasText: '' }).filter({ has: page.locator('input.t-title[value="Email advisor about demo slot"]') }).locator('.t-done').check();
  await page.waitForFunction(() => !window.__lockIn.lastRender.content.items.some((i) => i.label === 'Email advisor about demo slot'), null, { timeout: 3000 }).catch(() => {});
  labels = await page.evaluate(() => window.__lockIn.lastRender.content.items.map((i) => i.label));
  check(!labels.includes('Email advisor about demo slot'), 'completed task removed from wallpaper');
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-plan.jpg'), type: 'jpeg', quality: 82 });

  // Design tab
  await page.click('.tab[data-tab=design]');
  await page.waitForTimeout(100);
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-design.jpg'), type: 'jpeg', quality: 82 });
  await canvasPng(page, 'wallpaper-iphone-walnut.jpg');

  await page.selectOption('#des-desk', 'marble');
  await page.selectOption('#des-paper', 'legal');
  await page.selectOption('#des-font', 'sans');
  await page.check('#des-accessories input[data-acc=plant]');
  await page.waitForTimeout(100);
  await canvasPng(page, 'wallpaper-iphone-marble-legal.jpg');

  await page.selectOption('#des-desk', 'black');
  await page.selectOption('#des-paper', 'dots');
  await page.selectOption('#des-lighting', 'evening');
  await page.selectOption('#des-font', 'serif');
  await page.selectOption('#dev-select', 'pixel-9');
  await page.waitForTimeout(100);
  await canvasPng(page, 'wallpaper-pixel-black-evening.jpg');

  await page.selectOption('#dev-select', 'macbook-air-13');
  await page.selectOption('#des-desk', 'walnut');
  await page.selectOption('#des-paper', 'cream');
  await page.selectOption('#des-lighting', 'day');
  await page.waitForTimeout(100);
  await canvasPng(page, 'wallpaper-macbook-walnut.jpg');
  const wl = await page.evaluate(() => window.__lockIn.lastRender.layout.warnings);
  check(wl.length === 0, `no layout warnings on macbook (${JSON.stringify(wl)})`);

  // Back to iPhone for export + install flow.
  await page.selectOption('#dev-select', 'iphone-6.1');
  await page.selectOption('#des-desk', 'walnut');
  await page.click('.tab[data-tab=install]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-png')]);
  check(/lock-in-capstone-final-report-1179x2556-as-of-2026-11-04\.png/.test(dl.suggestedFilename()), `export filename ${dl.suggestedFilename()}`);
  check((await page.textContent('#wallpaper-pill')).includes('not confirmed'), 'exported != installed');
  for (const c of await page.$$('.apply-check')) await c.check();
  await page.click('#mark-applied');
  check((await page.textContent('#wallpaper-pill')).includes('current'), 'marked installed');
  // Editing a task makes the installed wallpaper stale.
  await page.click('.tab[data-tab=plan]');
  await page.locator('.task .t-label').first().fill('Confirm rubric ✓ today');
  await page.waitForFunction((w) => document.querySelector('#wallpaper-pill').textContent.includes(w), 'out of date', { timeout: 3000 }).catch(() => {});
  check((await page.textContent('#wallpaper-pill')).includes('out of date'), 'stale after edit');
  await page.locator('.task .t-label').first().fill('Confirm rubric');
  await page.waitForFunction((w) => document.querySelector('#wallpaper-pill').textContent.includes(w), 'current', { timeout: 3000 }).catch(() => {});
  check((await page.textContent('#wallpaper-pill')).includes('current'), 'current again after reverting');
  await page.click('.tab[data-tab=install]');
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-install.jpg'), type: 'jpeg', quality: 82 });

  // Reminders
  await page.click('.tab[data-tab=reminders]');
  const remCount = await page.locator('.rem').count();
  check(remCount === 8, `8 reminders (6 actions + deadline + refresh), got ${remCount}`);
  const [ics] = await Promise.all([page.waitForEvent('download'), page.click('#rem-ics')]);
  const icsText = fs.readFileSync(await ics.path(), 'utf8');
  check(icsText.includes('BEGIN:VCALENDAR') && (icsText.match(/BEGIN:VEVENT/g) || []).length === 8, 'ics has 8 events');
  await page.locator('.rem input[type=checkbox]').first().check();
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-reminders.jpg'), type: 'jpeg', quality: 82 });

  // Persistence across reload
  await page.reload();
  await page.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender);
  const after = await page.evaluate(() => ({ n: window.__lockIn.state.tasks.length, snaps: window.__lockIn.state.snapshots.length }));
  check(after.n === 7 && after.snaps === 1, `persisted after reload ${JSON.stringify(after)}`);

  // BYOK image generation with a user-chosen provider and model (mocked APIs).
  // Checks: requests carry only the style prompt, keys go only to the chosen
  // provider, keys are cleared on provider switch and never persisted.
  const jpg = fs.readFileSync(path.join(out, 'wallpaper-pixel-black-evening.jpg')).toString('base64');
  let sentBody = '';
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET' && /\/models\?/.test(req.url())) {
      return route.fulfill({ json: { models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-image', displayName: 'Gemini Flash Image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] },
      ] } });
    }
    if (req.method() === 'GET') return route.fulfill({ json: { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] } });
    sentBody = req.postData() || '';
    check(req.url().endsWith(':predict'), `Imagen uses predict (${req.url()})`);
    check(req.headers()['x-goog-api-key'] === 'google-key-not-real', 'Google key sent in header');
    return route.fulfill({ json: { predictions: [{ mimeType: 'image/jpeg', bytesBase64Encoded: jpg }] } });
  });
  await page.click('.tab[data-tab=design]');
  await page.click('#scenery-card > summary');
  await page.click('.byok > summary');
  check((await page.inputValue('#ai-provider')) === 'gemini', 'Gemini is the default provider');
  await page.fill('#ai-key', 'google-key-not-real');
  await page.click('#ai-load-models');
  await page.waitForFunction(() => !document.querySelector('#ai-model-pick-field').hidden);
  const options = await page.$$eval('#ai-model-pick option', (o) => o.map((x) => x.value));
  check(options.join() === 'gemini-2.5-flash-image,imagen-4.0-generate-001', `image models listed (${options})`);
  await page.selectOption('#ai-model-pick', 'imagen-4.0-generate-001');
  check((await page.inputValue('#ai-model')) === 'imagen-4.0-generate-001', 'picking a model fills the model field');
  await page.click('#ai-verify');
  await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('Connected'));
  await page.click('#ai-generate');
  await page.waitForFunction(() => !document.querySelector('#candidate-bar').hidden);
  check(!/Capstone|rubric|outline|key-not-real/i.test(sentBody), 'request contains only the style prompt');
  check(sentBody.includes('Do not draw paper, text'), 'scenery prompt sent');
  await page.click('#candidate-discard');

  // Switch to OpenAI: the Google key must be cleared, not reused.
  let openaiAuth = '';
  let openaiBody = '';
  await page.route('https://api.openai.com/**', (route) => {
    openaiAuth = route.request().headers()['authorization'] || '';
    openaiBody = route.request().postData() || '';
    return route.fulfill({ json: { data: [{ b64_json: jpg }], output_format: 'jpeg' } });
  });
  await page.selectOption('#ai-provider', 'openai');
  check((await page.inputValue('#ai-key')) === '', 'key cleared when switching provider');
  check((await page.inputValue('#ai-model')) === 'gpt-image-1', 'provider default model shown');
  await page.click('#ai-generate');
  await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('Enter an API key'));
  await page.fill('#ai-model', 'dall-e-3');
  await page.fill('#ai-key', 'openai-key-not-real');
  await page.click('#ai-generate');
  await page.waitForFunction(() => !document.querySelector('#candidate-bar').hidden);
  check(openaiAuth === 'Bearer openai-key-not-real', 'OpenAI key sent as bearer token');
  const ob = JSON.parse(openaiBody || '{}');
  check(ob.model === 'dall-e-3' && ob.size === '1024x1792' && ob.response_format === 'b64_json', `OpenAI request shape ${openaiBody.slice(0, 120)}`);
  await page.click('#candidate-accept');
  await page.waitForFunction(() => document.querySelector('#bg-current').textContent.includes('dall-e-3'));
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-ai-provider.jpg'), type: 'jpeg', quality: 82 });

  // Custom endpoint: plain http to a remote host is refused.
  await page.selectOption('#ai-provider', 'compatible');
  await page.fill('#ai-base', 'http://images.example.com/v1');
  await page.dispatchEvent('#ai-base', 'change');
  check((await page.textContent('#ai-status')).includes('https://'), 'insecure base URL rejected');

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  check(!stored.includes('key-not-real'), 'API keys never persisted');
  const remembered = await page.evaluate(() => window.__lockIn.state.ai.models);
  check(remembered.gemini === 'imagen-4.0-generate-001' && remembered.openai === 'dall-e-3', `model remembered per provider ${JSON.stringify(remembered)}`);

  // Error path keeps working state.
  await page.selectOption('#ai-provider', 'gemini');
  check((await page.inputValue('#ai-model')) === 'imagen-4.0-generate-001', 'remembered model restored');
  await page.fill('#ai-key', 'google-key-not-real');
  await page.unroute('https://generativelanguage.googleapis.com/**');
  await page.route('https://generativelanguage.googleapis.com/**', (r) => r.fulfill({ status: 429, json: { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } } }));
  await page.click('#ai-generate');
  await page.waitForFunction(() => document.querySelector('#ai-status').textContent.includes('Quota'));
  check((await page.textContent('#bg-current')).includes('dall-e-3'), 'failed generation keeps the current background');
  // Put the bundled desk back so later screenshots match the sample.
  await page.check('input[name=bg-type][value=bundled]');

  // Challenge tab
  await page.click('.tab[data-tab=challenge]');
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-review.jpg'), type: 'jpeg', quality: 82 });

  // Deadline tab hero shot
  await page.click('.tab[data-tab=deadline]');
  await hideToast(page);
  await page.screenshot({ path: path.join(out, 'app-deadline.jpg'), type: 'jpeg', quality: 82 });

  // Robustness: clearing a task title must not wipe it.
  await page.click('.tab[data-tab=plan]');
  const firstTitle = page.locator('.task .t-title').first();
  const original = await firstTitle.inputValue();
  await firstTitle.fill('');
  await firstTitle.blur();
  check((await firstTitle.inputValue()) === original, 'clearing a title restores it on blur');

  // Robustness: oversized custom screens are scaled to an exportable size.
  await page.click('.tab[data-tab=design]');
  await page.selectOption('#dev-select', 'custom');
  await page.fill('#dev-w', '8000'); await page.dispatchEvent('#dev-w', 'change');
  await page.fill('#dev-h', '8000'); await page.dispatchEvent('#dev-h', 'change');
  await page.waitForTimeout(300);
  const cw = await page.evaluate(() => [document.querySelector('#canvas').width, document.querySelector('#canvas').height]);
  check(cw[0] * cw[1] <= 16777216 && !(await page.isHidden('#dev-capped')), `custom size capped (${cw})`);
  await page.selectOption('#dev-select', 'iphone-6.1');

  // Robustness: corrupted saved data still opens the app.
  const junkCtx = await browser.newContext();
  const junkPage = await junkCtx.newPage();
  junkPage.on('pageerror', (e) => errors.push(`junk pageerror: ${e.message}`));
  await junkPage.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('lock-in:v1', JSON.stringify({ display: { eyebrow: 5 }, challenge: { steps: null }, snapshots: [null], tasks: [{ title: 'A', order: 0 }, { title: 'B', order: 0 }] }));
  });
  await junkPage.goto(`${base}#challenge`);
  await junkPage.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender);
  await junkPage.click('.tab[data-tab=install]');
  await junkCtx.close();

  // Icons
  const iconPage = await ctx.newPage();
  for (const size of [192, 512]) {
    await iconPage.setViewportSize({ width: size, height: size });
    await iconPage.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${base}icons/icon.svg" width="${size}" height="${size}">`);
    await iconPage.waitForTimeout(100);
    await iconPage.screenshot({ path: path.join(root, 'icons', `icon-${size}.png`), omitBackground: true, scale: 'css' });
  }
  await ctx.close();

  // ---- Mobile run
  const mctx = await browser.newContext({ ...devices['iPhone 15'], timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  const m = await mctx.newPage();
  await m.clock.setFixedTime(FIXED_NOW);
  m.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
  await m.goto(`${base}?sample#design`);
  await m.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender);
  const overflowX = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflowX, 'no horizontal scroll on phone');
  await hideToast(m);
  await m.screenshot({ path: path.join(out, 'app-mobile.jpg'), type: 'jpeg', quality: 82, fullPage: false });
  await mctx.close();

  await browser.close();
  srv.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('Smoke test passed; images written to docs/images/');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
