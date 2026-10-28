/* Service Worker: App-Hülle offline verfügbar machen. Gewässerpakete liegen in IndexedDB, nicht im Cache. */
const CACHE = 'uw-mobil-0.2.0';
const SHELL = [
  './', 'index.html', 'app.js',
  'lib/three.min.js', 'lib/colors.js', 'lib/package.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'
];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
