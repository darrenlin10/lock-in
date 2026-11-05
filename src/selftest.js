// Device self-test: runs Lock-In's browser-dependent paths on the real device
// (e.g. iPhone Safari), where they can't be tested from a Linux CI machine.
// Nothing leaves the page. Results can be copied as plain text.

import { renderWallpaper } from './render/compositor.js';
import { freeCanvas } from './render/backgrounds.js';
import { detectDevice, resolveDevice, rectFor, MAX_CANVAS_AREA } from './devices.js';
import { countdownText, localTimeZone, addDays, dateInZone } from './dates.js';
import { graphemes } from './layout.js';

const results = [];
const list = document.querySelector('#results');

function add(status, name, detail = '') {
  const item = { status, name, detail };
  results.push(item);
  const li = document.createElement('li');
  li.className = status;
  li.innerHTML = `<span class="tag">${{ pass: 'PASS', fail: 'FAIL', info: 'INFO', wait: '…' }[status]}</span><span></span>`;
  const body = li.lastChild;
  body.textContent = name;
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    body.append(small);
  }
  list.append(li);
  return { li, item };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBlob = (canvas) => new Promise((r) => canvas.toBlob(r, 'image/png'));

function sampleContent(device) {
  const tz = localTimeZone();
  const today = dateInZone(new Date(), tz);
  const cd = countdownText({ title: 'Device check', kind: 'date', date: addDays(today, 30), timeZone: tz });
  return {
    eyebrow: 'Deadline',
    title: 'Device check 👩‍💻',
    big: cd.big,
    unit: cd.unit,
    dateLine: cd.dateLine,
    sectionLabel: 'Next actions',
    items: [
      { id: 'a', label: 'Confirm rubric', sub: 'by Nov 6' },
      { id: 'b', label: 'Draft outline', sub: 'by Nov 9' },
      { id: 'c', label: `Readable on ${device.name}?`, sub: '' },
    ],
    hiddenCount: 2,
    emptyText: '',
    footerLeft: cd.asOfLine,
    footerRight: 'LOCK-IN',
  };
}

let sharePng = null; // pre-encoded so share() can run inside the tap
let device = null;

async function run() {
  list.innerHTML = '';
  results.length = 0;
  document.querySelector('#run').disabled = true;

  // Environment
  const dpr = window.devicePixelRatio || 1;
  const det = detectDevice({ width: screen.width, height: screen.height, dpr });
  device = resolveDevice({ deviceId: det.deviceId, customW: det.customW, customH: det.customH });
  add('info', 'Browser', navigator.userAgent);
  add('info', 'Screen', `${screen.width}×${screen.height} CSS px × ${dpr} = ${Math.round(Math.min(screen.width, screen.height) * dpr)}×${Math.round(Math.max(screen.width, screen.height) * dpr)} px → Lock-In preset: ${device.name} (${device.w}×${device.h})`);
  if (!window.isSecureContext) add('fail', 'Secure page (HTTPS)', 'This page was opened over plain HTTP, so Share and offline mode are switched off by the browser. Open it from the HTTPS site (e.g. GitHub Pages) to test them.');
  else add('pass', 'Secure page (HTTPS)');
    add('info', 'Timezone', `${localTimeZone()} · today is ${dateInZone(new Date(), localTimeZone())}`);

  // Feature support (each has a fallback in the app; listed for diagnosis)
  const features = {
    'Intl.Segmenter (emoji-safe wrapping)': Boolean(Intl.Segmenter),
    'OffscreenCanvas 2D': (() => {
      try {
        return Boolean(new OffscreenCanvas(1, 1).getContext('2d'));
      } catch {
        return false;
      }
    })(),
    'Intl.supportedValuesOf (full timezone list)': typeof Intl.supportedValuesOf === 'function',
    'createImageBitmap (custom backgrounds)': typeof createImageBitmap === 'function',
    'Service worker (offline use)': 'serviceWorker' in navigator,
  };
  for (const [name, ok] of Object.entries(features)) add(ok ? 'pass' : 'info', name, ok ? 'available' : 'not available: Lock-In uses a fallback');
  add(Array.from(graphemes('👩‍💻🇺🇸')).length === 2 ? 'pass' : 'info', 'Emoji are kept whole when wrapping', Intl.Segmenter ? '' : 'Older browser: rare emoji sequences may split');

  // Storage
  try {
    localStorage.setItem('lock-in:selftest', '1');
    localStorage.removeItem('lock-in:selftest');
    add('pass', 'Saving data (localStorage)');
  } catch (e) {
    add('fail', 'Saving data (localStorage)', `${e.name}: Lock-In works but forgets your plan on reload (private browsing?)`);
  }
  await new Promise((resolve) => {
    try {
      const req = indexedDB.open('lock-in-selftest', 1);
      req.onsuccess = () => {
        req.result.close();
        indexedDB.deleteDatabase('lock-in-selftest');
        add('pass', 'Saving background images (IndexedDB)');
        resolve();
      };
      req.onerror = () => {
        add('info', 'Saving background images (IndexedDB)', 'unavailable: custom backgrounds last for this session only');
        resolve();
      };
    } catch (e) {
      add('info', 'Saving background images (IndexedDB)', `${e.name}: custom backgrounds last for this session only`);
      resolve();
    }
  });

  // Render the real wallpaper for this screen and export it.
  {
    const { li, item } = add('wait', `Render and export a ${device.w}×${device.h} wallpaper`);
    await sleep(30);
    try {
      const canvas = document.createElement('canvas');
      const t0 = performance.now();
      renderWallpaper(canvas, { size: device, rect: rectFor(device), design: { desk: 'walnut', paper: 'cream', lighting: 'day', font: 'serif', accessories: { pen: true, cup: true, plant: false } }, backgroundImage: null, content: sampleContent(device) });
      const renderMs = performance.now() - t0;
      const t1 = performance.now();
      const blob = await toBlob(canvas);
      const encodeMs = performance.now() - t1;
      if (!blob) throw new Error('toBlob returned nothing');
      const bmp = await createImageBitmap(blob);
      const ok = bmp.width === device.w && bmp.height === device.h;
      sharePng = new File([blob], `lock-in-device-check-${device.w}x${device.h}.png`, { type: 'image/png' });
      const thumb = document.querySelector('#thumb');
      thumb.src = URL.createObjectURL(blob);
      thumb.hidden = false;
      li.className = ok ? 'pass' : 'fail';
      item.status = li.className;
      li.querySelector('.tag').textContent = ok ? 'PASS' : 'FAIL';
      item.detail = `${(blob.size / 1e6).toFixed(1)} MB PNG, ${bmp.width}×${bmp.height}; render ${Math.round(renderMs)} ms, encode ${Math.round(encodeMs)} ms`;
      li.lastChild.append(Object.assign(document.createElement('small'), { textContent: item.detail }));
      freeCanvas(canvas);
    } catch (e) {
      li.className = 'fail';
      item.status = 'fail';
      li.querySelector('.tag').textContent = 'FAIL';
      item.detail = String(e);
      li.lastChild.append(Object.assign(document.createElement('small'), { textContent: item.detail }));
    }
  }

  // Largest image Lock-In will ever create, three times at once (preview +
  // background layer + desk texture), like the app's worst case.
  {
    const side = Math.floor(Math.sqrt(MAX_CANVAS_AREA));
    const { li, item } = add('wait', `Largest size Lock-In allows: 3 canvases of ${side}×${side}`);
    await sleep(30);
    const made = [];
    let detail = '';
    let ok = true;
    try {
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('canvas');
        c.width = side;
        c.height = side;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error(`canvas ${i + 1} has no 2D context (memory limit reached)`);
        ctx.fillStyle = '#5b3923';
        ctx.fillRect(0, 0, side, side);
        made.push(c);
      }
      const blob = await toBlob(made[0]);
      if (!blob) throw new Error('could not export the largest size');
      const px = made[2].getContext('2d').getImageData(side - 1, side - 1, 1, 1).data;
      if (px[0] !== 0x5b) throw new Error('canvas pixels were lost (memory limit reached)');
      detail = `OK (${(blob.size / 1e6).toFixed(1)} MB PNG)`;
    } catch (e) {
      ok = false;
      detail = `${e.message}. Use a phone or computer preset rather than a very large custom size on this device.`;
    } finally {
      made.forEach(freeCanvas);
    }
    li.className = ok ? 'pass' : 'fail';
    item.status = li.className;
    item.detail = detail;
    li.querySelector('.tag').textContent = ok ? 'PASS' : 'FAIL';
    li.lastChild.append(Object.assign(document.createElement('small'), { textContent: detail }));
  }

  // Web Share capability (the tap test is a separate button)
  const canShareFiles = Boolean(sharePng && navigator.canShare && navigator.canShare({ files: [sharePng] }));
  add(canShareFiles ? 'pass' : 'info', 'Share / Save to Photos available', canShareFiles ? 'tap "Test Share" to confirm' : 'not available here: Lock-In shows Download PNG only');
  document.querySelector('#share').disabled = !canShareFiles;
  document.querySelector('#download').disabled = !sharePng;
  document.querySelector('#run').disabled = false;
}

document.querySelector('#run').addEventListener('click', run);

// Same pattern as the app: share() is called synchronously inside the tap.
document.querySelector('#share').addEventListener('click', () => {
  if (!sharePng) return;
  navigator
    .share({ files: [sharePng], title: 'Lock-In device check' })
    .then(() => add('pass', 'Share sheet (tap test)', 'opened and completed'))
    .catch((e) => {
      if (e.name === 'AbortError') add('pass', 'Share sheet (tap test)', 'opened; you cancelled, which is fine');
      else add('fail', 'Share sheet (tap test)', `${e.name}: ${e.message}`);
    });
});

document.querySelector('#download').addEventListener('click', () => {
  if (!sharePng) return;
  const url = URL.createObjectURL(sharePng);
  const a = Object.assign(document.createElement('a'), { href: url, download: sharePng.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  add('info', 'Download (tap test)', 'started: check that the file appears in Downloads / Files');
});

document.querySelector('#copy').addEventListener('click', async () => {
  const text = ['Lock-In device check', new Date().toISOString(), ...results.map((r) => `[${r.status.toUpperCase()}] ${r.name}${r.detail ? ` (${r.detail})` : ''}`)].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    document.querySelector('#note').textContent = 'Results copied.';
  } catch {
    document.querySelector('#note').textContent = 'Copy failed. Select the results and copy them manually.';
  }
});

run();
