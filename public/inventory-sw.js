const CACHE='mi-tienda-shell-v6';
const FILES=['/caja/index.html','/caja/style.css','/caja/app.mjs','/caja/domain.mjs','/caja/sale-data.mjs','/caja/sales-view.mjs','/caja/storage.mjs','/caja/profiles.mjs','/caja/demo-fixtures.mjs','/caja/icon.svg','/caja/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('mi-tienda-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(url.origin!==self.location.origin||event.request.method!=='GET')return;
 if(FILES.includes(url.pathname)){event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();void caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request)));return;}
 if(event.request.mode==='navigate'&&(url.pathname==='/'||url.pathname.startsWith('/caja/'))){event.respondWith(fetch(event.request).catch(()=>caches.match('/caja/index.html')));}
});
