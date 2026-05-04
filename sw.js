const CACHE = 'coastdown-v7';
const ASSETS = ['/', 'index.html', 'styles.css', 'app.js', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: try network, fall back to cache (ensures updates are picked up)
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Update cache with fresh response
        const clone = response.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
