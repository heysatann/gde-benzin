// Service Worker для PWA «ГдеЗаправка»
// - кэширует оболочку приложения для офлайн-запуска
// - принимает и показывает push-уведомления
'use strict';

const CACHE = 'gz-shell-v5';

const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',

  // Карта: MapLibre GL JS (открытый, без API-ключей)
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Стратегии:
// - API и тайлы карты — network-first (свежие данные важнее)
// - оболочка — cache-first
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  const isApi = url.pathname.startsWith('/api/');
  const isTile = /tile\.openstreetmap\.org/.test(url.host);

  if (isApi || isTile) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (isTile) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Собственные ассеты (app.js/style.css/index) — network-first, чтобы
  // правки сразу подхватывались; при офлайне отдаём кэш.
  const isOwnAsset =
    url.origin === self.location.origin && /\.(js|css)$|\/$|index\.html$/.test(url.pathname);
  if (isOwnAsset) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});

// ---------- Push-уведомления ----------
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (_) {
    data = { title: 'ГдеЗаправка', body: e.data ? e.data.text() : '' };
  }
  const title = data.title || 'ГдеЗаправка';
  const options = {
    body: data.body || 'Обновление по заправкам рядом с вами',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',

    data: data.url || '/',
    vibrate: [80, 40, 80],
    tag: data.tag || 'gz-notify',
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
