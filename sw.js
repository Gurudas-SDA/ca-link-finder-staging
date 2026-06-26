// Service Worker v7 — Force Update + no-cache for index.html
// Versija: 2026-06-26 (mainīt šo komentāru katru reizi kad vajag forsēt atjaunināšanu)

const SW_VERSION = 'v7-2026-06-26-nocache-html';

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
    var url = new URL(event.request.url);
    var path = url.pathname;
    // Always bypass HTTP cache for index.html so updated ?v= hashes are seen immediately
    if (path === '/' || path.endsWith('/index.html') || path === '/ca-link-finder' || path === '/ca-link-finder/') {
        event.respondWith(fetch(event.request, { cache: 'no-cache' }));
    } else {
        event.respondWith(fetch(event.request));
    }
});
