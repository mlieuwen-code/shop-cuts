// Shop Welds moved to https://mlieuwen-code.github.io/shop-welds/
// This replaces the old app's worker: it drops the old alert sign-up and the old saved copy, removes itself,
// and reloads any open old window so it shows the "moved" page.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){
  e.waitUntil((async function(){
    try { var s = await self.registration.pushManager.getSubscription(); if (s) await s.unsubscribe(); } catch (x) {}
    try { var ks = await caches.keys(); await Promise.all(ks.filter(function(k){ return k.indexOf('shopweld-') === 0; }).map(function(k){ return caches.delete(k); })); } catch (x) {}
    try { await self.registration.unregister(); } catch (x) {}
    try { var cs = await self.clients.matchAll({ type: 'window' }); cs.forEach(function(c){ c.navigate(c.url); }); } catch (x) {}
  })());
});
