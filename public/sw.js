/**
 * Offline app shell. Two strategies, split by request type:
 *
 * Navigations (index.html) go network-first, so a browser tab open online always sees the latest
 * deploy — falling back to whatever shell is cached the moment there's no connection. Everything
 * else (the hashed /assets/* bundle Vite emits, the icons) goes cache-first: those filenames are
 * content-hashed and therefore immutable, so a cache hit is always correct and there's no reason
 * to pay for a network round trip once one exists.
 *
 * Nothing is precached at install beyond the shell's static, unhashed files — the hashed bundle
 * filenames aren't known until Vite builds, so the fetch handler fills the cache in as requests
 * for them arrive. That means the very first load has to happen online; every one after, on the
 * same deploy, works with no connection at all.
 */
const CACHE_NAME = 'sim-taxi-v1';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/apple-touch-icon.svg',
  '/apple-touch-icon.png',
  '/apple-touch-icon-512.png',
  '/favicon-16.png',
  '/favicon-32.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // The shell's own <script>/<link> requests, on the load that registers this worker, race the
    // worker's install and are not guaranteed to be intercepted by the fetch handler below — so
    // without this, a device that was only ever online for that one visit could still come up
    // empty offline. Pulling the hashed bundle's real filenames out of the shipped index.html and
    // precaching them here (rather than leaving it to the fetch handler to catch lazily) is what
    // makes a single online visit enough. The filenames aren't knowable ahead of time — Vite
    // fingerprints /assets/* fresh on every build.
    const shellHtml = await (await fetch('/index.html', { cache: 'no-store' })).text();
    const assetPaths = [...shellHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

    await cache.addAll([...PRECACHE_URLS, ...new Set(assetPaths)]);
    // Take over from any previous worker immediately rather than waiting for every tab of the
    // old version to close — a game reload (play-again) is the normal way this app cycles.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // POSTs etc. can't be cached, and cross-origin requests are out of scope — there are none in
  // this app today, but a stray one should hit the network exactly as it would with no worker
  // installed rather than fail against a cache that was never going to have it.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    })),
  );
});
