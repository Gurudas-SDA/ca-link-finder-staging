// Service Worker v4 — Force Update + DB cache-busting rollout
// Versija: 2026-04-11 (mainīt šo komentāru katru reizi kad vajag forsēt atjaunināšanu)

const SW_VERSION = 'v4-2026-04-11';

self.addEventListener('install', function(event) {
    console.log('[SW ' + SW_VERSION + '] Install — skip waiting');
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    console.log('[SW ' + SW_VERSION + '] Activate — clearing all caches and reloading clients');
    event.waitUntil(
        caches.keys().then(function(names) {
            return Promise.all(
                names.map(function(name) {
                    console.log('[SW ' + SW_VERSION + '] Deleting cache: ' + name);
                    return caches.delete(name);
                })
            );
        }).then(function() {
            return self.clients.claim();
        }).then(function() {
            return self.clients.matchAll({ type: 'window' });
        }).then(function(clients) {
            clients.forEach(function(client) {
                console.log('[SW ' + SW_VERSION + '] Reloading client: ' + client.url);
                client.navigate(client.url);
            });
        })
    );
});

self.addEventListener('fetch', function(event) {
    event.respondWith(fetch(event.request));
});
