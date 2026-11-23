// Offline support: cache the app shell so bundled backgrounds, planning and
// export keep working without a network connection (design doc §5.1).
const CACHE = 'lock-in-v4';
const SHELL = [
  './',
  'index.html',
  'selftest.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/app.js',
  'src/dates.js',
  'src/tasks.js',
  'src/layout.js',
  'src/devices.js',
  'src/prompts.js',
  'src/plan-import.js',
  'src/reminders.js',
  'src/store.js',
  'src/ai.js',
  'src/selftest.js',
  'src/idb.js',
  'src/render/compositor.js',
  'src/render/backgrounds.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Network-first for same-origin GETs (so updates arrive), with the cache as
// fallback. On a slow or stalled connection, the cached copy is served after
// NETWORK_TIMEOUT_MS while the network response still refreshes the cache.
// Cross-origin requests (AI APIs, Google Calendar) are never cached.
const NETWORK_TIMEOUT_MS = 4000;
// After one timeout, assume the connection is bad for a while and answer from
// the cache immediately. Otherwise each step of the module import chain would
// wait its own timeout and a stalled network would still take ~15 s.
const SLOW_MODE_MS = 60_000;
let slowUntil = 0;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const network = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  });
  const cached = () =>
    caches.match(e.request, { ignoreSearch: true }).then((r) => r || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined));
  e.waitUntil(network.catch(() => {}));
  if (Date.now() < slowUntil) {
    e.respondWith(cached().then((r) => r || network));
    return;
  }
  e.respondWith(
    new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (!done && r) {
          done = true;
          resolve(r);
        }
      };
      const timer = setTimeout(() => {
        slowUntil = Date.now() + SLOW_MODE_MS;
        cached().then((r) => (r ? finish(r) : null));
      }, NETWORK_TIMEOUT_MS);
      network
        .then((res) => {
          clearTimeout(timer);
          if (!done) slowUntil = 0; // the network answered in time
          finish(res);
        })
        .catch(() => {
          clearTimeout(timer);
          cached().then((r) => finish(r || Response.error()));
        });
    }),
  );
});
