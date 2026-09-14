// SC Inspect service worker: caches the app shell so it opens without a connection.
const VERSION = 'sc-inspect-16f5a6b6';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // never intercept the data APIs
  if (url.hostname === 'api.github.com' || url.hostname === 'api.anthropic.com') return;
  if (url.origin === self.location.origin) {
    // app shell: cache first, refresh in the background
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
      const net = fetch(e.request).then(r => { if (r.ok) caches.open(VERSION).then(c => c.put(e.request, r.clone())); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    // fonts: cache as they arrive; fall back to the system stack offline
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) caches.open(VERSION + '-fonts').then(c => c.put(e.request, r.clone())); return r; }).catch(() => new Response('', { status: 503 }))));
  }
});
