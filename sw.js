// Service Worker v8 — Force Update + no-cache for index.html
// Versija: 2026-07-07 (mainīt šo komentāru katru reizi kad vajag forsēt atjaunināšanu)

const SW_VERSION = 'v8-2026-07-07-no-first-install-reload';
const MARKER_PREFIX = 'sw-marker-';

self.addEventListener('install', function(event) {
    console.log('[SW ' + SW_VERSION + '] Install — skip waiting');
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    console.log('[SW ' + SW_VERSION + '] Activate — clearing all caches');
    event.waitUntil(
        caches.keys().then(function(names) {
            // A marker cache left by a previous SW version means this activation
            // is an UPDATE. On a FIRST install there is no marker — and we must
            // NOT reload clients then, or we abort the in-flight meta.db download
            // for a brand-new visitor.
            var isUpdate = names.some(function(name) {
                return name.indexOf(MARKER_PREFIX) === 0;
            });
            return Promise.all(
                names.map(function(name) {
                    console.log('[SW ' + SW_VERSION + '] Deleting cache: ' + name);
                    return caches.delete(name);
                })
            ).then(function() {
                return self.clients.claim();
            }).then(function() {
                // Leave a marker so the NEXT activation knows it is an update
                return caches.open(MARKER_PREFIX + SW_VERSION);
            }).then(function() {
                if (!isUpdate) {
                    console.log('[SW ' + SW_VERSION + '] First install — not reloading clients');
                    return;
                }
                return self.clients.matchAll({ type: 'window' }).then(function(clients) {
                    clients.forEach(function(client) {
                        console.log('[SW ' + SW_VERSION + '] Reloading client: ' + client.url);
                        client.navigate(client.url);
                    });
                });
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
