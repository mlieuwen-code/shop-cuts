// Keeps a full copy of the app on the tablet so it opens with no signal.
const CACHE = 'shopcuts-8676f7a7e1';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('shopcuts-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;                       // saves to Drive go straight out
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (req.mode === 'navigate') {                            // the app page: open from the tablet's copy, refresh it in the background
    e.respondWith(caches.open(CACHE).then(c => c.match('index.html').then(hit => {
      const net = fetch(req.url, { cache: 'no-cache' }).then(r => { if (r.ok) c.put('index.html', r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }
  e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(r => {   // fonts, icons
    if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r;
  }))));
});
