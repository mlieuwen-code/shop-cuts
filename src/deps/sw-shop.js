// Shop Cuts: keeps a full copy of the app on the tablet so it opens with no signal.
// With signal, the app page comes fresh from the web (so updates show up straight away); after 3 seconds, or offline, the tablet's copy is used.
const CACHE = 'shopcuts-VERSION';
const CORE = ['./', 'index.html', 'app.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('shopcuts-') || k.startsWith('cutsheets-')) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;                       // saves to Drive go straight out
  if (url.pathname.indexOf('/weld/') >= 0) return;         // Shop Welds lives in /weld/ with its own worker and its own copy
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(c => {
      const net = fetch(req.url, { cache: 'no-cache' }).then(r => { if (r.ok) c.put('index.html', r.clone()); return r; });
      const slow = new Promise(res => setTimeout(res, 3000));
      return Promise.race([net.catch(() => null), slow.then(() => null)])
        .then(r => r || c.match('index.html').then(hit => hit || net));
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(r => {   // fonts, icons
    if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r;
  }))));
});
