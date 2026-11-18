// Shop Welds: keeps a full copy of the app on the tablet so it opens with no signal.
// With signal, the app page comes fresh from the web (so updates show up straight away); after 3 seconds, or offline, the tablet's copy is used.
const CACHE = 'shopweld-1b833696fa';
const CORE = ['./', 'index.html', 'app.webmanifest', 'icon-192.png', 'icon-512.png', 'pdf.min.js', 'pdf.worker.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('shopweld-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;                       // saves to Drive go straight out
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

// ---------- push notifications (Alerts) ----------
// The backend sends an empty push; this fetches the latest notes from it and shows them.
// The app hands over the backend address and crew PIN (kept in its own cache, which updates don't clear).
const WP_CACHE = 'weldpush-conf';
const wpConf = () => caches.open(WP_CACHE).then(c => c.match('conf')).then(r => r ? r.json() : null).catch(() => null);
const wpSave = conf => caches.open(WP_CACHE).then(c => c.put('conf', new Response(JSON.stringify(conf))));
self.addEventListener('message', e => {
  const m = e.data && e.data.wpConf; if (!m) return;
  e.waitUntil(wpConf().then(old => wpSave({ api: m.api, pin: m.pin, since: Math.max((old && old.since) || 0, m.since || 0) })));
});
self.addEventListener('push', e => {
  e.waitUntil(wpConf().then(conf => {
    if (!conf || !conf.api) return [];
    return fetch(conf.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'weldpushnotes', pin: conf.pin, since: conf.since || 0 }) })
      .then(r => r.json()).then(res => {
        const notes = (res && res.notes) || [];
        if (!notes.length) return notes;
        conf.since = notes[notes.length - 1].at;
        return wpSave(conf).then(() => notes);
      });
  }).catch(() => null).then(notes => {
    if (notes && !notes.length) return;   // nothing new (already shown)
    if (!notes) return self.registration.showNotification('Shop Welds', { body: 'Something changed in the shop. Tap to open Shop Welds.', tag: 'weld', icon: 'icon-192.png' });
    return self.registration.showNotification(notes.length > 1 ? 'Shop Welds · ' + notes.length + ' updates' : 'Shop Welds', {
      body: notes.slice(-4).map(n => n.t).join('\n'), tag: 'weld-' + notes[notes.length - 1].at, icon: 'icon-192.png', badge: 'icon-192.png',
      vibrate: [300, 150, 300], requireInteraction: true, renotify: true
    });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return clients.openWindow('./');
  }));
});
