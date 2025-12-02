/**
 * MesaRPG - Service Worker para PWA
 * Permite funcionar offline y cachear recursos
 */

const CACHE_NAME = 'mesarpg-v1';
const ASSETS_TO_CACHE = [
    '/mobile',
    '/mobile/index.html',
    '/mobile/css/mobile.css',
    '/mobile/js/app.js',
    '/mobile/js/controls.js',
    '/mobile/manifest.json'
];

// Instalación - cachear recursos
self.addEventListener('install', (event) => {
    console.log('SW: Instalando...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('SW: Cacheando recursos');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => self.skipWaiting())
    );
});

// Activación - limpiar caches antiguos
self.addEventListener('activate', (event) => {
    console.log('SW: Activando...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch - servir desde cache, fallback a red
self.addEventListener('fetch', (event) => {
    // Solo cachear GET requests
    if (event.request.method !== 'GET') return;
    
    // No cachear WebSocket
    if (event.request.url.includes('/ws/')) return;
    
    // No cachear API calls
    if (event.request.url.includes('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                return new Response(JSON.stringify({ error: 'Offline' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }
    
    event.respondWith(
        caches.match(event.request)
            .then(cached => {
                // Devolver cache si existe, mientras actualiza en background
                const fetchPromise = fetch(event.request)
                    .then(response => {
                        // Guardar en cache
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => cache.put(event.request, clone));
                        }
                        return response;
                    })
                    .catch(() => cached);
                
                return cached || fetchPromise;
            })
    );
});

// Push notifications (para futuro uso)
self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    
    const options = {
        body: data.body || 'Nueva notificación de MesaRPG',
        icon: '/mobile/assets/icon-192.png',
        badge: '/mobile/assets/icon-192.png',
        vibrate: [100, 50, 100],
        tag: 'mesarpg-notification'
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'MesaRPG', options)
    );
});

// Click en notificación
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/mobile')
    );
});
