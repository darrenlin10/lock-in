// Accessibility audit (axe-core, WCAG 2.0/2.1/2.2 A and AA + best practices)
// of every screen, on desktop and phone, in light and dark mode.
//   npm install --no-save axe-core@4.10.2 && npm run test:a11y
const { chromium, devices } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(__dirname, '..');
// axe-core is a test-only tool: npm install --no-save axe-core@4.10.2
let axePath;
try {
  axePath = require.resolve('axe-core/axe.min.js', { paths: [process.cwd(), __dirname] });
} catch {
  console.error('axe-core is not installed. Run: npm install --no-save axe-core@4.10.2');
  process.exit(1);
}
const axeSrc = fs.readFileSync(axePath, 'utf8');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (p.endsWith('/')) p += 'index.html'; fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(b); }); });
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const all = new Map();
  for (const scheme of ['light', 'dark']) {
    for (const [name, opts] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 13']]]) {
      // bypassCSP only so axe (injected by the test) can run.
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme, bypassCSP: true });
      const page = await ctx.newPage();
      await page.goto(base + '?sample');
      await page.waitForFunction(() => window.__lockIn && window.__lockIn.lastRender);
      const views = [['deadline'], ['plan'], ['design', async () => { await page.click('#scenery-card > summary'); await page.click('.byok > summary'); }], ['install'], ['reminders'], ['settings', async () => { await page.click('#open-settings'); }], ['welcome', async () => { await page.evaluate(() => { window.__lockIn.state.welcomed = false; }); await page.evaluate(() => { document.querySelector('#welcome').hidden = false; }); }]];
      for (const [view, prep] of views) {
        if (!['settings', 'welcome'].includes(view)) await page.click(`.tab[data-tab=${view}]`);
        if (prep) await prep();
        await page.addScriptTag({ content: axeSrc });
        const res = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] })).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')}${n.any[0]?.message ? ' — ' + n.any[0].message.slice(0, 140) : ''}`) })));
        for (const v of res) {
          const k = `${v.impact} · ${v.id}: ${v.help}`;
          if (!all.has(k)) all.set(k, new Set());
          v.nodes.forEach((n) => all.get(k).add(`[${scheme}/${name}/${view}] ${n}`));
        }
        if (view === 'settings') await page.keyboard.press('Escape');
      }
      await ctx.close();
    }
  }
  for (const [k, nodes] of all) { console.log(k); [...nodes].slice(0, 6).forEach((n) => console.log('    ' + n)); }
  console.log(all.size ? `${all.size} kind(s) of accessibility issue` : 'No accessibility violations found');
  await browser.close(); srv.close();
  process.exit(all.size ? 1 : 0);
})();
