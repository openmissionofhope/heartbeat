// Caches only the offline recording page and its static assets. No participant data is cached.
const CACHE = 'heartbeat-offline-v1';
const ASSETS = ['/offline', '/static/js/offline.js', '/static/css/styles.css'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !ASSETS.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
