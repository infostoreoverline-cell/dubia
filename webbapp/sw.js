// sw.js — Service Worker (BioTwin Dubia v2)
// Cache-first strategy for all static assets.
// Version bump CACHE_VERSION to force cache refresh on deploy.

const CACHE_VERSION = 'biotwin-v2.0.0';
const CACHE_NAME    = `${CACHE_VERSION}-static`;

// Assets to cache on install
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './dubia_db.js',
  './dubia_core.js',
  './dubia_app.js',
  './cloud_anchor.js',
  './manifest.json',
];

// External CDN assets to cache after first fetch
const CDN_PATTERNS = [
  'cdn.jsdelivr.net/npm/chart.js',
  'cdn.jsdelivr.net/npm/@supabase',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── INSTALL ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Precache failed:', err))
  );
});

// ── ACTIVATE ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.info('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept Supabase API calls or non-GET requests
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;

  // For CDN assets: cache-first, fall back to network
  const isCDN = CDN_PATTERNS.some(p => url.href.includes(p));
  if (isCDN) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // For local app assets: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => {
          // Offline fallback: return index.html for navigation requests
          if (event.request.mode === 'navigate') return caches.match('./index.html');
        });
      })
    );
  }
});

// ── MESSAGE HANDLER ────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'CACHE_VERSION') {
    event.ports[0].postMessage(CACHE_VERSION);
  }
});
