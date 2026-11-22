/* Stash — fonctionnement hors ligne. Changer CACHE à chaque mise à jour. */
var CACHE = 'stash-1.5';
var FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg'];
self.addEventListener('install', function(e){ e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(FILES); }).then(function(){ return self.skipWaiting(); })); });
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){ return Promise.all(ks.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); })); }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  if (e.request.method !== 'GET') return;
  var same = e.request.url.indexOf(self.location.origin) === 0;
  if (!same) return; // la sauvegarde Google passe toujours par le réseau, jamais par le cache
  // « no-cache » : on redemande toujours la dernière version au serveur, sinon une mise à jour peut mettre 10 minutes à arriver
  e.respondWith((same ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request)).then(function(r){
    if (r && r.ok){ var copy = r.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, copy); }); }
    return r;
  }).catch(function(){ return caches.match(e.request, { ignoreSearch: true }).then(function(r){ return r || caches.match('index.html'); }); }));
});
