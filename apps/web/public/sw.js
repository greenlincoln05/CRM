/*
 * Service worker for the technician app.
 *
 * The job is narrow and deliberate: make /tech open with no signal. It caches
 * the app shell and its static assets, and it stays out of the way of
 * everything else.
 *
 * What it does NOT do is cache API responses. Job data lives in IndexedDB,
 * written by the app itself, because that is data the app has to reason about -
 * merge, mark dirty, replay. A stale cached API response pretending to be fresh
 * is worse than an honest offline state.
 */

const VERSION = 'lcp-tech-v1';
const SHELL = `${VERSION}-shell`;

// Requests that must never be served from cache. A queued action replayed
// against a cached 200 would silently vanish.
const NEVER_CACHE = /\/api\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(['/tech', '/manifest.webmanifest']))
      .catch(() => {/* first load may be offline; runtime caching will fill in */})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.test(url.pathname)) return;

  // Navigations: try the network so the app updates, fall back to the cached
  // shell so a tech in a dead zone still gets their day.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/tech', copy));
          return res;
        })
        .catch(() => caches.match('/tech').then((r) => r ?? new Response(
          '<h1>Offline</h1><p>Open this once with signal and it will work without it afterwards.</p>',
          { headers: { 'Content-Type': 'text/html' }, status: 503 },
        ))),
    );
    return;
  }

  // Static assets: cache first, they are content-hashed by the build.
  if (/\/_next\/static\/|\.(css|js|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) =>
        hit ?? fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        }),
      ),
    );
  }
});

// Nudge the app to flush its outbox when the browser reports connectivity.
self.addEventListener('sync', (event) => {
  if (event.tag === 'lcp-outbox') {
    event.waitUntil(
      self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: 'sync' }))),
    );
  }
});
