// SPDX-License-Identifier: Apache-2.0
// Service worker: cache-first for static assets, network-first for /api/*.
// Version the cache; bump CACHE on each deploy to invalidate.

const CACHE = 'muse-pwa-v1';
const OFFLINE_URL = '/offline';
const STATIC_ASSETS = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', OFFLINE_URL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, fall back to cache (no offline page for API).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Navigation + static: cache-first, fall back to network, then offline page.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((res) => {
            // Only cache successful same-origin responses.
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          })
          .catch(() => {
            // Navigation requests get the offline page; assets get a 503.
            if (request.mode === 'navigate') return caches.match(OFFLINE_URL);
            return new Response('', { status: 503, statusText: 'Offline' });
          }),
    ),
  );
});
