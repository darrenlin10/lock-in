// Safari / iPhone compatibility test (emulated in Chromium).
//   npm run test:compat
//
// WebKit can't be installed in every environment, so this test reproduces the
// iPhone Safari constraints that matter to Lock-In inside Chromium:
//   1. Canvas memory: iOS Safari refuses canvases above 16,777,216 pixels and
//      caps total canvas memory at ~384 MB (counted until a canvas is shrunk
//      or garbage-collected).
//   2. Web Share: Safari only allows navigator.share() during the tap itself
//      (same task as the click), not after an await.
//   3. Older Safari: no OffscreenCanvas, Intl.Segmenter, Intl.supportedValuesOf,
//      Web Share or IndexedDB (e.g. some private modes), and throwing storage.
// It does NOT replace testing on a real iPhone. Use selftest.html for that.
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const IOS_CANVAS_BUDGET = 384 * 2 ** 20;
const IOS_MAX_CANVAS_AREA = 16_777_216;

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

// Installed before the app loads: tracks canvas memory like iOS Safari does.
function canvasAccounting() {
  const live = new Set();
  window.__canvas = { peakBytes: 0, maxArea: 0 };
  const bump = (c) => {
    live.add(c);
    const bytes = [...live].reduce((s, x) => s + x.width * x.height * 4, 0);
    window.__canvas.peakBytes = Math.max(window.__canvas.peakBytes, bytes);
    window.__canvas.maxArea = Math.max(window.__canvas.maxArea, c.width * c.height);
  };
  const protos = [HTMLCanvasElement.prototype];
  if (typeof OffscreenCanvas !== 'undefined') protos.push(OffscreenCanvas.prototype);
  for (const proto of protos) {
    for (const prop of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      Object.defineProperty(proto, prop, { get: d.get, set(v) { d.set.call(this, v); bump(this); }, configurable: true });
    }
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const OC = OffscreenCanvas;
    window.OffscreenCanvas = class extends OC {
      constructor(w, h) {
        super(w, h);
        bump(this);
      }
    };
  }
}

// Installed before the app loads: Safari-style Web Share that only works
// synchronously inside the tap.
function safariShare() {
  let inTap = false;
  for (const type of ['click', 'pointerup', 'touchend']) {
    window.addEventListener(type, () => {
      inTap = true;
      setTimeout(() => (inTap = false), 0); // the gesture ends with this task
    }, true);
  }
  window.__shares = [];
  Object.defineProperty(navigator, 'canShare', { value: (d) => Boolean(d && d.files && d.files.length), configurable: true });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (data) => {
      if (!inTap) {
        window.__shares.push({ ok: false });
        throw new DOMException('Must be handling a user gesture to perform a share request.', 'NotAllowedError');
      }
      const f = data.files[0];
      const bmp = await createImageBitmap(f);
      window.__shares.push({ ok: true, name: f.name, type: f.type, w: bmp.width, h: bmp.height });
    },
  });
}

// Installed before the app loads: remove APIs that older iOS Safari lacks.
function oldSafari() {
  delete window.OffscreenCanvas;
  if (Intl.Segmenter) delete Intl.Segmenter;
  if (Intl.supportedValuesOf) delete Intl.supportedValuesOf;
  delete Navigator.prototype.canShare;
  delete Navigator.prototype.share;
  Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('blocked', 'SecurityError'); }, configurable: true });
}

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? '  ok ' : '  FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const iphone = { ...devices['iPhone 13'], timezoneId: 'America/Los_Angeles', locale: 'en-US' };
  const ready = (page) => page.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender, null, { timeout: 15000 });

  // 1. Canvas memory under the iOS budget, even in the worst case.
  console.log('1. iOS Safari canvas memory budget');
  {
    const ctx = await browser.newContext(iphone);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(canvasAccounting);
    await page.goto(`${base}?sample#design`);
    await ready(page);
    for (const dev of ['iphone-6.9', 'galaxy-ultra', 'pixel-9', 'iphone-se', 'iphone-6.1']) {
      await page.selectOption('#dev-select', dev);
      for (const desk of ['marble', 'black', 'walnut']) await page.selectOption('#des-desk', desk);
      for (const light of ['evening', 'day']) await page.selectOption('#des-lighting', light);
    }
    const normal = await page.evaluate(() => window.__canvas.peakBytes);
    check(normal < 128 * 2 ** 20, `normal use (5 phone sizes × 3 desks × 2 lights) peaks at ${Math.round(normal / 2 ** 20)} MB`);
    await page.selectOption('#dev-select', 'custom');
    await page.fill('#dev-w', '8000');
    await page.dispatchEvent('#dev-w', 'change');
    await page.fill('#dev-h', '8000');
    await page.dispatchEvent('#dev-h', 'change');
    for (const desk of ['marble', 'black', 'walnut']) await page.selectOption('#des-desk', desk);
    const worst = await page.evaluate(() => window.__canvas);
    check(worst.peakBytes < IOS_CANVAS_BUDGET, `largest custom size peaks at ${Math.round(worst.peakBytes / 2 ** 20)} MB (budget 384 MB)`);
    check(worst.maxArea <= IOS_MAX_CANVAS_AREA, `largest single canvas ${worst.maxArea.toLocaleString('en-US')} px ≤ ${IOS_MAX_CANVAS_AREA.toLocaleString('en-US')} px`);
    check(errors.length === 0, `no errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await ctx.close();
  }

  // 2. Share works the way Safari requires.
  console.log('2. Safari Web Share gesture rule');
  {
    const ctx = await browser.newContext(iphone);
    const page = await ctx.newPage();
    await page.addInitScript(safariShare);
    await page.goto(`${base}?sample#install`);
    await ready(page);
    check(await page.isVisible('#share-png'), 'Share button shown when files can be shared');
    await page.waitForTimeout(1200); // the app pre-encodes the PNG in the background
    await page.tap('#share-png');
    await page.waitForFunction(() => window.__shares.length > 0, null, { timeout: 5000 }).catch(() => {});
    const first = await page.evaluate(() => window.__shares);
    check(first.length === 1 && first[0].ok, 'share() is called inside the tap (Safari accepts it)');
    check(first[0]?.type === 'image/png' && first[0]?.w === 1170 && first[0]?.h === 2532, `shared file is a ${first[0]?.w}×${first[0]?.h} PNG matching the iPhone 13 screen (auto-detected on first launch)`);
    check(await page.evaluate(() => window.__lockIn.state.snapshots.length === 1), 'a successful share is recorded as an export');

    // Right after an edit the new image isn't encoded yet: the app must not
    // call share() late (Safari would reject it). It asks for a second tap.
    await page.tap('.tab[data-tab=plan]');
    await page.locator('.task .t-label').first().fill('Confirm rubric today');
    await page.tap('.tab[data-tab=install]');
    await page.tap('#share-png');
    await page.waitForTimeout(800);
    const second = await page.evaluate(() => window.__shares);
    check(second.every((s) => s.ok), 'share() is never called outside a tap');
    const toast = await page.textContent('#toast');
    check(second.length === 2 || /tap Share again/.test(toast), `fresh edit: ${second.length === 2 ? 'shared immediately' : 'asks for a second tap'}`);
    await page.waitForTimeout(800);
    await page.tap('#share-png');
    await page.waitForTimeout(800);
    const third = await page.evaluate(() => window.__shares);
    check(third.length >= 2 && third.every((s) => s.ok), 'second tap shares the updated image');
    await ctx.close();
  }

  // 3. Older Safari: features missing.
  console.log('3. Older Safari without OffscreenCanvas / Segmenter / Web Share / IndexedDB');
  {
    const ctx = await browser.newContext({ ...iphone, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(oldSafari);
    await page.goto(`${base}?sample#plan`);
    await ready(page);
    check(await page.evaluate(() => typeof OffscreenCanvas === 'undefined' && !Intl.Segmenter), 'APIs removed');
    check(await page.isHidden('#share-png'), 'Share button hidden without Web Share; Download still available');
    // A long full title with no short label must trigger the "add a short label" warning.
    await page.locator('.task .t-label').first().fill('');
    await page.locator('.task .t-title').first().fill('🎯👩‍💻 ' + 'Very long action title with emoji '.repeat(6));
    await page.waitForTimeout(200);
    const warn = await page.textContent('#warnings');
    check(/doesn't fit in two lines/.test(warn), 'long-label warning still works with the fallback text splitter');
    await page.tap('.tab[data-tab=install]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#export-png')]);
    check(/\.png$/.test(dl.suggestedFilename()), 'PNG export works');
    await page.tap('.tab[data-tab=deadline]');
    const zones = await page.$$eval('#dl-tz option', (o) => o.length);
    check(zones >= 5, `timezone list falls back to a built-in list (${zones} zones)`);
    check(errors.length === 0, `no errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await ctx.close();
  }

  await browser.close();
  srv.close();
  if (failures.length) {
    console.error(`\n${failures.length} compatibility check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll compatibility checks passed (emulated). Confirm on a real iPhone with selftest.html.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
