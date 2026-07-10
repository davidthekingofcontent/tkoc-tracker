// TKOC Intelligence service worker.
// v2: fixed deploy-staleness — the v1 worker cached ALL .js/.css cache-first and
// stale HTML in a dynamic cache, so phones kept running old app versions after
// deploys. Strategy now:
//   - cache-first ONLY for /_next/static/ (content-hashed, immutable) + PWA shell
//   - navigations: network-first, offline.html as the ONLY fallback (never stale HTML)
//   - API and everything else: network only (no caching of authenticated data)
// The version bump purges every v1 cache on activate.
const CACHE_VERSION = 'tkoc-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const SHELL_ASSETS = [
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable, content-hashed build assets: cache-first is safe forever
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const cloned = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, cloned));
          }
          return response;
        });
      })
    );
    return;
  }

  // PWA shell assets: cache-first (tiny, versioned via CACHE_VERSION bumps)
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  // Navigations: always fresh; offline.html only when the network is down
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Everything else (APIs, images, fonts, widget JS): straight to network.
  // No respondWith → browser default behavior, nothing stored.
});
