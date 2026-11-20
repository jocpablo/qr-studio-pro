/* QR Studio Pro — service worker: permite usar la app sin conexión. */
const CACHE = 'qrstudio-v1';
const SHELL = [
  './qr-studio-pro.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    // jsQR es opcional: si no hay conexión durante la instalación, se guardará en el primer uso
    try { await c.add(new Request(JSQR, { mode: 'cors' })); } catch (err) { /* ignorar */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  // Nunca guardar en caché la API ni las redirecciones de QR dinámicos
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/'))) return;
  if (!sameOrigin && req.url !== JSQR) return;

  // Página principal: primero la red (para recibir actualizaciones), caché si no hay conexión
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && url.pathname.endsWith('qr-studio-pro.html')) (await caches.open(CACHE)).put('./qr-studio-pro.html', res.clone());
        return res;
      } catch (err) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./qr-studio-pro.html'));
      }
    })());
    return;
  }

  // Recursos: caché primero, y se actualiza en segundo plano
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Sin conexión', { status: 503, statusText: 'Offline' });
  })());
});
